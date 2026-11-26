use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Debug, Serialize)]
struct FileKind {
    name: String,
    // 拖进来的是文件夹时，记录这个文件来自哪个文件夹；直接拖入的文件为空
    folder: Option<String>,
    kind: String,
    supported: bool,
    size: u64,
}

// latitude / longitude 必须已是 WGS84：坐标系换算在前端完成（见 src/gcj02.ts）
#[derive(Debug, Deserialize)]
struct WriteRequest {
    paths: Vec<String>,
    latitude: f64,
    longitude: f64,
    backup: String,
}

#[derive(Debug, Serialize, Clone)]
struct WriteResult {
    path: String,
    success: bool,
    action: String,
    error: Option<String>,
}

#[tauri::command]
fn classify_files(paths: Vec<String>) -> Vec<FileKind> {
    // 拖进来的是文件夹时，取它里面直接存放的文件（不往下层文件夹递归）
    let candidates: Vec<(String, Option<String>)> = paths
        .into_iter()
        .flat_map(|name| {
            let path = Path::new(&name);
            if !path.is_dir() {
                return vec![(name, None)];
            }
            let mut children: Vec<String> = fs::read_dir(path)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|entry| entry.path().is_file())
                        .map(|entry| entry.path().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            children.sort();
            children
                .into_iter()
                .map(|child| (child, Some(name.clone())))
                .collect()
        })
        .collect();
    candidates
        .into_iter()
        .map(|(name, folder)| {
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let raw = [
                "cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw", "tif", "tiff",
            ];
            let video = ["mp4", "mov", "m4v", "mkv"];
            let (kind, supported) = if raw.contains(&ext.as_str()) {
                ("RAW", true)
            } else if video.contains(&ext.as_str()) {
                ("视频", true)
            } else if ["jpg", "jpeg", "png", "heic"].contains(&ext.as_str()) {
                ("照片", true)
            } else {
                ("未知", false)
            };
            let size = fs::metadata(&name)
                .map(|meta| meta.len())
                .unwrap_or(0);
            FileKind {
                name,
                folder,
                kind: kind.into(),
                supported,
                size,
            }
        })
        .collect()
}

fn exiftool_path() -> PathBuf {
    // 先找程序自己目录下的，其次才是当前工作目录
    let beside_exe =
        std::env::current_exe().ok().and_then(|p| p.parent().map(|x| x.join("exiftool.exe")));
    match beside_exe {
        Some(path) if path.exists() => path,
        _ => PathBuf::from("exiftool.exe"),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(meta_a), Ok(meta_b)) if meta_a.len() == meta_b.len() => {
            matches!((fs::read(a), fs::read(b)), (Ok(content_a), Ok(content_b)) if content_a == content_b)
        }
        _ => false,
    }
}

fn is_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp4" | "mov" | "m4v" | "mkv"
    )
}

static ARG_FILE_ID: AtomicU64 = AtomicU64::new(0);

// ExifTool 按系统代码页转换命令行上的文件名，含表情符号等代码页之外字符的文件名会找不到。
// 所以文件名一律经 UTF-8 参数文件传给它（每行一个参数）。
const CHARSET_UTF8: [&str; 2] = ["-charset", "filename=UTF8"];
const GPS_TAGS: [&str; 4] = [
    "-GPSLatitude",
    "-GPSLongitude",
    "-GPSLatitudeRef",
    "-GPSLongitudeRef",
];

#[derive(serde::Deserialize)]
struct GpsReadback {
    #[serde(rename = "SourceFile")]
    source_file: String,
    #[serde(rename = "GPSLatitude")]
    latitude: Option<f64>,
    #[serde(rename = "GPSLongitude")]
    longitude: Option<f64>,
    #[serde(rename = "GPSLatitudeRef")]
    latitude_ref: Option<String>,
    #[serde(rename = "GPSLongitudeRef")]
    longitude_ref: Option<String>,
}

impl GpsReadback {
    fn describe(&self) -> String {
        format!(
            "{} {}, {} {}",
            self.latitude.map_or("?".to_string(), |v| format!("{v}")),
            self.latitude_ref.as_deref().unwrap_or("?"),
            self.longitude.map_or("?".to_string(), |v| format!("{v}")),
            self.longitude_ref.as_deref().unwrap_or("?")
        )
    }
}

// 一个等待写入的照片或 RAW，连同这次为它创建的备份
struct Pending {
    path: String,
    created_backup: Option<PathBuf>,
    kept_existing_backup: bool,
}

fn failure(path: &str, action: &str, error: String) -> WriteResult {
    WriteResult {
        path: path.to_string(),
        success: false,
        action: action.to_string(),
        error: Some(error),
    }
}

fn gps_args(lat: f64, lon: f64) -> Vec<String> {
    vec![
        "-overwrite_original".to_string(),
        format!("-GPSLatitude={:.8}", lat.abs()),
        format!(
            "-GPSLatitudeRef={}",
            if lat >= 0.0 { "N" } else { "S" }
        ),
        format!("-GPSLongitude={:.8}", lon.abs()),
        format!(
            "-GPSLongitudeRef={}",
            if lon >= 0.0 { "E" } else { "W" }
        ),
    ]
}

fn readback_args() -> Vec<String> {
    let mut args: Vec<String> = CHARSET_UTF8.iter().map(|s| s.to_string()).collect();
    args.extend(["-j", "-n", "-s"].iter().map(|s| s.to_string()));
    args.extend(GPS_TAGS.iter().map(|s| s.to_string()));
    args
}

fn has_newline(path: &str) -> bool {
    path.contains(['\n', '\r'])
}

fn normalized(path: &str) -> String {
    path.replace('\\', "/")
}

fn run_exiftool(
    tool: &Path,
    args: &[String],
    paths: &[String],
) -> Result<std::process::Output, String> {
    let cannot_run = |e: std::io::Error| format!("无法运行 {}：{e}", tool.display());
    if paths.len() == 1 && has_newline(&paths[0]) {
        // 参数文件按行拆分参数，文件名里不能有换行；这种极少见的情况退回命令行方式，
        // 这时文件名按系统代码页解释，不能再声明 UTF-8
        return Command::new(tool)
            .args(args.iter().filter(|arg| !CHARSET_UTF8.contains(&arg.as_str())))
            .arg(&paths[0])
            .output()
            .map_err(cannot_run);
    }
    let arg_file = std::env::temp_dir().join(format!(
        "GeoTagStudio-{}-{}.args",
        std::process::id(),
        ARG_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut lines = args.join("\n");
    lines.push('\n');
    for path in paths {
        lines.push_str(path);
        lines.push('\n');
    }
    fs::write(&arg_file, lines)
        .map_err(|e| format!("无法写入临时参数文件 {}：{e}", arg_file.display()))?;
    let output = Command::new(tool).arg("-@").arg(&arg_file).output();
    let _ = fs::remove_file(&arg_file);
    output.map_err(cannot_run)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(300).collect())
}

// 读回一批文件里的 GPS，用来确认确实写进去了
fn readback(tool: &Path, paths: &[String]) -> Result<Vec<GpsReadback>, String> {
    let output = run_exiftool(tool, &readback_args(), paths)?;
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("无法解析 ExifTool 的返回结果：{e}"))
}

fn is_written(gps: &GpsReadback, lat: f64, lon: f64) -> bool {
    let (Some(read_lat), Some(read_lon)) = (gps.latitude, gps.longitude) else {
        return false;
    };
    let want_lat_ref = if lat >= 0.0 { "N" } else { "S" };
    let want_lon_ref = if lon >= 0.0 { "E" } else { "W" };
    gps.latitude_ref.as_deref() == Some(want_lat_ref)
        && gps.longitude_ref.as_deref() == Some(want_lon_ref)
        && (read_lat - lat).abs() < 1e-6
        && (read_lon - lon).abs() < 1e-6
}

// ExifTool 对出错的文件输出一行 "Error: 原因 - 文件路径"，按路径整理出各自的失败原因
fn error_reasons(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let reason = line.trim().strip_prefix("Error:")?.trim();
            let (reason, path) = reason.rsplit_once(" - ")?;
            Some((normalized(path.trim()), reason.trim().to_string()))
        })
        .collect()
}

// 以读回的坐标为准判断是否写入成功；reasons 是 ExifTool 报错的文件及原因，
// overall 是整个调用失败时的原因
fn verify(
    pending: &Pending,
    read: &[GpsReadback],
    reasons: &[(String, String)],
    overall: Option<&str>,
    lat: f64,
    lon: f64,
) -> Result<(), String> {
    let key = normalized(&pending.path);
    let read = read.iter().find(|gps| normalized(&gps.source_file) == key);
    match read {
        Some(gps) if is_written(gps, lat, lon) => Ok(()),
        // 文件里有了坐标，但不是指定的值
        Some(gps) if gps.latitude.is_some() && gps.longitude.is_some() => Err(format!(
            "写入后读回的坐标是 {}，与指定的 {} {}, {} {} 不符",
            gps.describe(),
            lat,
            if lat >= 0.0 { "N" } else { "S" },
            lon,
            if lon >= 0.0 { "E" } else { "W" }
        )),
        // 没有读到坐标：优先用 ExifTool 对这个文件报的错，其次是用整个调用的失败原因
        _ => Err(
            reasons
                .iter()
                .find(|(path, _)| path == &key)
                .map_or_else(
                    || overall.unwrap_or("写入后没有读到 GPS 坐标").to_string(),
                    |(_, reason)| reason.clone(),
                ),
        ),
    }
}

// 一次调用写入这批文件，再一次调用读回，逐个核对后返回各自的结果
fn write_and_verify(
    tool: &Path,
    pendings: &[&Pending],
    lat: f64,
    lon: f64,
) -> Vec<Result<(), String>> {
    let paths: Vec<String> = pendings.iter().map(|p| p.path.clone()).collect();
    let mut args: Vec<String> = CHARSET_UTF8.iter().map(|s| s.to_string()).collect();
    args.extend(gps_args(lat, lon));
    let (read, reasons, overall) = match run_exiftool(tool, &args, &paths) {
        Ok(output) => {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            match readback(tool, &paths) {
                Ok(read) => (read, error_reasons(&text), None),
                Err(error) => (
                    Vec::new(),
                    Vec::new(),
                    Some(first_line(&text).unwrap_or(error)),
                ),
            }
        }
        Err(error) => (Vec::new(), Vec::new(), Some(error)),
    };
    pendings
        .iter()
        .map(|pending| verify(pending, &read, &reasons, overall.as_deref(), lat, lon))
        .collect()
}

fn settle(pending: &Pending, outcome: Result<(), String>) -> WriteResult {
    match outcome {
        Ok(()) => {
            let mut action = "已写入 EXIF GPS".to_string();
            if pending.kept_existing_backup {
                action.push_str("（已有 .bak 未覆盖）");
            }
            WriteResult {
                path: pending.path.clone(),
                success: true,
                action,
                error: None,
            }
        }
        Err(error) => {
            // 没写成就不留备份：仅当原文件和刚创建的备份完全相同时才删
            if let Some(backup) = &pending.created_backup {
                if same_file(Path::new(&pending.path), backup) {
                    let _ = fs::remove_file(backup);
                }
            }
            failure(&pending.path, "写入失败", error)
        }
    }
}

fn write_xmp(path: &Path, lat: f64, lon: f64) -> Result<(), String> {
    let xmp = format!(
        r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:exif="http://ns.adobe.com/exif/1.0/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" exif:GPSLatitude="{lat:.8}" exif:GPSLongitude="{lon:.8}" exif:GPSLatitudeRef="{lat_ref}" exif:GPSLongitudeRef="{lon_ref}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>"#,
        lat = lat.abs(),
        lon = lon.abs(),
        lat_ref = if lat >= 0.0 { "N" } else { "S" },
        lon_ref = if lon >= 0.0 { "E" } else { "W" }
    );
    fs::write(format!("{}.xmp", path.display()), xmp).map_err(|e| e.to_string())
}

// async：Tauri 会把 async 命令放到后台任务里执行，写大文件时界面不会卡住
#[tauri::command]
async fn write_gps(request: WriteRequest) -> Vec<WriteResult> {
    let tool = exiftool_path();
    let (lat, lon) = (request.latitude, request.longitude);
    let mut results: Vec<Option<WriteResult>> = vec![None; request.paths.len()];
    // (在 request.paths 里的序号, 待写入的文件)
    let mut batch: Vec<(usize, Pending)> = Vec::new();

    for (index, raw_path) in request.paths.iter().enumerate() {
        let path = PathBuf::from(raw_path);
        if !path.exists() {
            results[index] = Some(failure(raw_path, "文件不存在", "文件不存在".into()));
            continue;
        }
        if is_video(&path) {
            results[index] = Some(match write_xmp(&path, lat, lon) {
                Ok(()) => WriteResult {
                    path: raw_path.clone(),
                    success: true,
                    action: "已生成 XMP sidecar".into(),
                    error: None,
                },
                Err(error) => failure(raw_path, "写入失败", error),
            });
            continue;
        }
        // 照片和 RAW 会被修改：选择了备份就先复制一份，备份失败则不往下写。
        // 已有的 .bak 不覆盖，保住第一次写入前的原始文件
        let mut pending = Pending {
            path: raw_path.clone(),
            created_backup: None,
            kept_existing_backup: false,
        };
        if request.backup != "none" {
            let backup = PathBuf::from(format!("{}.bak", path.display()));
            if backup.exists() {
                pending.kept_existing_backup = true;
            } else if let Err(e) = fs::copy(&path, &backup) {
                results[index] = Some(failure(
                    raw_path,
                    "备份失败",
                    format!("无法创建备份 {}：{e}", backup.display()),
                ));
                continue;
            } else {
                pending.created_backup = Some(backup);
            }
        }
        batch.push((index, pending));
    }

    if batch.is_empty() {
        return finish(results);
    }
    if !tool.exists() {
        let missing = "未找到 exiftool.exe，请将其放在绿色版程序目录";
        for (index, pending) in &batch {
            results[*index] = Some(failure(&pending.path, "写入失败", missing.into()));
        }
        return finish(results);
    }

    // 文件名带换行的进不了参数文件，逐个走命令行
    for (index, pending) in batch.iter().filter(|(_, p)| has_newline(&p.path)) {
        results[*index] = Some(settle(
            pending,
            write_and_verify(&tool, &[pending], lat, lon).remove(0),
        ));
    }

    // 其余的一次调用全部写完，再一次调用读回核对
    let many: Vec<(usize, &Pending)> = batch
        .iter()
        .filter(|(_, p)| !has_newline(&p.path))
        .map(|(index, p)| (*index, p))
        .collect();
    if !many.is_empty() {
        let pendings: Vec<&Pending> = many.iter().map(|(_, p)| *p).collect();
        for ((index, pending), outcome) in many
            .into_iter()
            .zip(write_and_verify(&tool, &pendings, lat, lon))
        {
            results[index] = Some(settle(pending, outcome));
        }
    }
    finish(results)
}

fn finish(results: Vec<Option<WriteResult>>) -> Vec<WriteResult> {
    results
        .into_iter()
        .map(|result| result.unwrap_or_else(|| failure("", "写入失败", "未处理".into())))
        .collect()
}

// 绿色版的数据（WebView 数据、处理记录）放在 exe 同目录的 data 文件夹；该目录不可写时回退到系统默认位置
fn storage_dir<R: tauri::Runtime>(manager: &impl tauri::Manager<R>) -> tauri::Result<PathBuf> {
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("data")));
    match beside_exe {
        Some(dir) if fs::create_dir_all(&dir).is_ok() => Ok(dir),
        _ => manager.path().app_local_data_dir(),
    }
}

// 一条处理记录，由前端生成；逐行追加到数据目录下的 history.jsonl，重启后还在
#[derive(Debug, Serialize, Deserialize)]
struct HistoryRecord {
    time: String,
    file: String,
    path: String,
    status: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    city: Option<String>,
    error: Option<String>,
}

fn history_file<R: tauri::Runtime>(
    manager: &impl tauri::Manager<R>,
) -> Result<PathBuf, String> {
    let dir = storage_dir(manager).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    Ok(dir.join("history.jsonl"))
}

#[tauri::command]
fn record_history(app: tauri::AppHandle, records: Vec<HistoryRecord>) -> Result<(), String> {
    use std::io::Write;
    let file = history_file(&app)?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("无法写入处理记录 {}：{e}", file.display()))?;
    for record in &records {
        let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
        output
            .write_all(line.as_bytes())
            .and_then(|_| output.write_all(b"\n"))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 最新的排在前面
#[tauri::command]
fn load_history(app: tauri::AppHandle) -> Result<Vec<HistoryRecord>, String> {
    let file = history_file(&app)?;
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("无法读取处理记录 {}：{e}", file.display())),
    };
    // 写到一半的残行直接跳过，不让一条坏记录拖垮整个列表
    let mut records: Vec<HistoryRecord> = text
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    records.reverse();
    records.truncate(5000);
    Ok(records)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            classify_files,
            write_gps,
            record_history,
            load_history
        ])
        // 主窗口在 tauri.conf.json 中设为 create: false，在这里创建以指定 WebView 数据目录
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("main window not defined in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(storage_dir(app)?)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
