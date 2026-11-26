import './style.css';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { gcj02ToWgs84, wgs84ToGcj02, type LngLat } from './gcj02';

const tauri = Boolean((window as any).__TAURI_INTERNALS__);
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

type AssetKind = '照片' | 'RAW' | '视频';
type Asset = { id: number; name: string; path: string; kind: AssetKind; size: string; selected: boolean; status: string; done: boolean };
type Basemap = 'osm' | 'amap';
type View = LngLat & { zoom: number };
type WriteResult = { path: string; success: boolean; action: string; error?: string };
type HistoryRecord = { time: string; file: string; path: string; status: '成功' | '失败'; latitude: number | null; longitude: number | null; city: string | null; error: string | null };
type SearchHit = { name: string; address: string; lat: number; lon: number; crs: 'GCJ-02' | 'WGS84' };
const rawExt = /\.(cr2|cr3|nef|arw|dng|raf|orf|rw2|pef|srw|tif|tiff)$/i;
const videoExt = /\.(mp4|mov|m4v|mkv)$/i;
// 打开时显示全国。位置一律以 WGS84 保存，只在当前地图上显示时换算。
const CHINA: View = { lat: 35.3, lon: 104.5, zoom: 4 };
const CRS_NAME: Record<Basemap, string> = { osm: 'OpenStreetMap · WGS84', amap: '高德地图 · GCJ-02' };

function load<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不下也不影响本次使用
  }
}
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

let assets: Asset[] = [];
let nextId = 1;
let position: LngLat | null = null;
let view: View = { ...CHINA };
const savedAmap = load<{ key?: string; secret?: string }>('geotag.amap', {});
let amapConfig = { key: savedAmap.key || '', secret: savedAmap.secret || '' };
const savedBasemap = load<Basemap | null>('geotag.basemap', null);
let basemap: Basemap = savedBasemap === 'amap' || (savedBasemap === null && !!amapConfig.key) ? 'amap' : 'osm';
if (basemap === 'amap' && !amapConfig.key) basemap = 'osm';

// 界面骨架只创建一次，地图实例放在里面才不会被重建
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<div class='window'>
<header><div class='brand'>◉ GeoTag Studio <span>本地处理 · 不上传原文件</span></div><div class='project'><button id='history'>处理记录</button><b id='position-status'>未选位置</b></div></header>
<main><aside id='drop-zone'>
<div class='section-head'><strong>待处理文件</strong><small id='count'></small></div>
<input id='fileInput' type='file' multiple accept='.jpg,.jpeg,.png,.heic,.cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef,.srw,.mp4,.mov' hidden/>
<button id='import'>＋ 添加照片、RAW 或视频</button>
<div class='list-tools'><button id='clear-done'>清除已处理的</button><button id='clear-all'>清除全部</button></div>
<div class='filter'>筛选 <select id='filter'><option>全部文件</option><option>照片</option><option>RAW</option><option>视频</option></select></div>
<div class='list' id='list'></div>
<footer>RAW：CR2 / CR3 / NEF / ARW / DNG 等<br/>标准 EXIF GPS 写入；视频生成 XMP sidecar</footer>
</aside>
<section class='map-pane'>
<div class='toolbar'><input id='search' placeholder='搜索地点，或输入 纬度,经度' autocomplete='off'/><button id='search-go'>搜索</button><select id='basemap'><option value='osm'>OpenStreetMap</option><option value='amap'>高德地图</option></select><button id='settings'>⚙ 设置</button></div>
<div class='search-results' id='search-results' hidden></div>
<div class='map-layer' id='map-osm'></div><div class='map-layer' id='map-amap' hidden></div>
<div class='map-notice' id='map-notice' hidden></div>
<div class='settings-panel' id='settings-panel' hidden>
<strong>设置</strong>
<label>高德地图 Key<input id='amap-key' autocomplete='off' placeholder='Web端(JS API) 类型的 Key'/></label>
<label>安全密钥<input id='amap-secret' type='password' autocomplete='off' placeholder='与上面 Key 配对的安全密钥'/></label>
<small>在高德开放平台（console.amap.com）创建“Web端(JS API)”类型的 Key 后填写。信息只保存在本机，用来加载高德官方地图、搜索地点和查询城市；OpenStreetMap 地图本身不需要 Key。Key 若设置了域名白名单，需要放行 tauri.localhost。</small>
<div class='settings-actions'><button id='settings-cancel'>取消</button><button id='settings-save'>保存</button></div>
<div class='settings-status' id='settings-status'></div>
</div>
<div class='coords' id='coords'></div>
</section></main>
<div class='actions'><label class='backup'>原文件 <select id='backup'><option value='sibling'>写入前备份为 .bak</option><option value='none'>不备份，直接修改</option></select></label><button class='primary' id='write'>写入 <span class='count'>0</span> 个文件</button></div>
<div class='dialog' id='dialog' hidden><div class='dialog-box'><strong>确认写入</strong><div class='dialog-place' id='dialog-place'></div><ul class='dialog-files' id='dialog-files'></ul><div class='dialog-actions'><button id='dialog-cancel'>取消</button><button class='primary' id='dialog-confirm'>确认写入</button></div></div></div>
<div class='dialog' id='history-dialog' hidden><div class='dialog-box history-box'><strong>处理记录 <small id='history-count'></small></strong><div class='history-head'><span>文件名</span><span>状态</span><span>写入的 GPS</span><span>城市</span></div><div class='history-list' id='history-list'></div><div class='dialog-actions'><button id='history-close'>关闭</button></div></div></div>
<div id='toast'></div></div>`;

let toastTimer = 0;
function toast(message: string) {
  const element = $('#toast');
  element.textContent = message;
  element.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (element.className = ''), 3600);
}
function selected() {
  return assets.filter(a => a.selected);
}
function classify(name: string): AssetKind {
  return rawExt.test(name) ? 'RAW' : videoExt.test(name) ? '视频' : '照片';
}
function initialStatus(kind: AssetKind): string {
  return kind === '视频' ? '待生成 XMP' : '待写入 EXIF';
}
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return bytes > 0 ? `${bytes} B` : '大小未知';
}
function formatGps(lat: number, lon: number): string {
  return `${lat.toFixed(6)} ${lat >= 0 ? 'N' : 'S'}, ${lon.toFixed(6)} ${lon >= 0 ? 'E' : 'W'}`;
}

function visibleAssets() {
  const filter = $<HTMLSelectElement>('#filter').value;
  return filter === '全部文件' ? assets : assets.filter(a => a.kind === filter);
}
function renderList() {
  const shown = visibleAssets();
  $('#list').innerHTML = !assets.length
    ? `<div class='empty'>还没有文件<br/>点击上方按钮添加，或把照片、RAW、视频拖到这里</div>`
    : !shown.length
      ? `<div class='empty'>这个分类下没有文件</div>`
      : shown
          .map(a => `<label class='row ${a.selected ? 'selected' : ''}'><input type='checkbox' data-id='${a.id}' ${a.selected ? 'checked' : ''}/><span class='thumb'>${a.kind}</span><span class='meta'><span class='name-line'><b title='${esc(a.path || a.name)}'>${esc(a.name)}</b>${a.done ? "<i class='done-badge'>已处理</i>" : ''}</span><small title='${esc(a.status)}'>${esc(a.size)} · ${esc(a.status)}</small></span><button class='row-remove' data-id='${a.id}' title='从列表移除（不会删除文件）'>×</button></label>`)
          .join('');
  $('#list').querySelectorAll<HTMLInputElement>('.row input').forEach(input =>
    input.addEventListener('change', () => {
      const asset = assets.find(a => a.id === +input.dataset.id!);
      if (asset) asset.selected = input.checked;
      renderList();
      renderStatus();
    }),
  );
  $('#list').querySelectorAll<HTMLButtonElement>('.row-remove').forEach(button =>
    button.addEventListener('click', event => {
      // 按钮在 label 里，不阻止的话会连带切换勾选状态
      event.preventDefault();
      event.stopPropagation();
      assets = assets.filter(a => a.id !== +button.dataset.id!);
      renderList();
      renderStatus();
    }),
  );
}
function renderStatus() {
  const count = selected().length;
  $('#position-status').textContent = position ? '已选位置' : '未选位置';
  $('#count').textContent = `已选 ${count} / ${assets.length}`;
  app.querySelectorAll<HTMLElement>('.actions .count').forEach(element => (element.textContent = String(count)));
}
function renderCoords() {
  const element = $('#coords');
  if (!position) {
    element.innerHTML = `<div><b>位置预览</b><div>点击地图、搜索地点或输入经纬度来选择位置</div></div><small>当前地图 ${CRS_NAME[basemap]}<br/>写入 EXIF 使用 WGS84</small>`;
    return;
  }
  const shown = toMap(position);
  element.innerHTML = `<div><b>位置预览</b><div>纬度 ${shown.lat.toFixed(6)}° · 经度 ${shown.lon.toFixed(6)}°</div></div><small>当前地图 ${CRS_NAME[basemap]}<br/>写入 EXIF (WGS84)：${formatGps(position.lat, position.lon)}</small>`;
}

// 位置在两种地图之间切换时保持指向同一个真实地点
function fromMap(point: LngLat): LngLat {
  const raw = { lat: point.lat, lon: wrapLon(point.lon) };
  return basemap === 'amap' ? gcj02ToWgs84(raw.lat, raw.lon) : raw;
}
function toMap(point: LngLat): LngLat {
  return basemap === 'amap' ? wgs84ToGcj02(point.lat, point.lon) : point;
}

// OpenStreetMap：Leaflet 加载官方瓦片
const pinIcon = L.icon({ iconUrl, iconRetinaUrl, shadowUrl, iconSize: [25, 41], iconAnchor: [12, 41], shadowSize: [41, 41], shadowAnchor: [12, 41] });
const osm = L.map('map-osm', { center: [CHINA.lat, CHINA.lon], zoom: CHINA.zoom, zoomControl: false, attributionControl: false, minZoom: 3, maxZoom: 19, worldCopyJump: true });
L.control.zoom({ position: 'topleft' }).addTo(osm);
L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('© OpenStreetMap contributors').addTo(osm);
let osmMarker: L.Marker | null = null;
let osmTilesOk = false;
let osmTileFails = 0;
const osmTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(osm);
osmTiles.on('tileload', () => {
  osmTilesOk = true;
  renderNotice();
});
osmTiles.on('tileerror', () => {
  osmTileFails++;
  renderNotice();
});
osm.on('click', event => setPosition({ lat: event.latlng.lat, lon: wrapLon(event.latlng.lng) }));
osm.on('moveend zoomend', captureView);
window.addEventListener('resize', () => osm.invalidateSize());

function renderNotice() {
  let text = '';
  if (basemap === 'osm' && !osmTilesOk && osmTileFails >= 3) {
    text = '地图瓦片加载失败：当前网络访问不到 OpenStreetMap（国内网络通常需要代理）。可以切换到高德地图。';
  } else if (basemap === 'amap' && amapAuthError) {
    text = `${amapAuthText()}。可点右上角“设置”修改`;
  }
  $('#map-notice').textContent = text;
  $('#map-notice').hidden = !text;
}

// 高德地图：官方 JS API 2.0，Key 和安全密钥来自设置
let amapMap: any = null;
let amapMarker: any = null;
let amapState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let amapError = '';
let amapScript: Promise<void> | null = null;
let amapReady: Promise<void> = Promise.resolve();
// 高德在 Key 或安全密钥不对时只画空白地图、不报错，只有数据接口的返回里带着 {"status":"0","info":"…"}
let amapAuthError = '';
let amapWatchInstalled = false;
function watchAmapErrors() {
  if (amapWatchInstalled) return;
  amapWatchInstalled = true;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      const body = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response);
      const match = /"status"\s*:\s*"0".*?"info"\s*:\s*"([A-Z_]+)"/.exec(body || '');
      if (/\.amap\.com\//.test(this.responseURL) && match && !amapAuthError) {
        amapAuthError = match[1];
        renderNotice();
      }
    });
    return send.apply(this, args);
  };
}
function amapAuthText(): string {
  if (!amapAuthError) return '';
  const advice =
    amapAuthError === 'INVALID_USER_KEY'
      ? 'Key 不存在，请检查是否抄错'
      : '请检查 Key 是否为 Web端(JS API) 类型、安全密钥是否与它配对，以及 Key 的域名白名单是否放行 tauri.localhost';
  return `高德地图返回 ${amapAuthError}：${advice}`;
}

function loadAmapScript(): Promise<void> {
  if (window.AMap) return Promise.resolve();
  if (amapScript) return amapScript;
  window._AMapSecurityConfig = { securityJsCode: amapConfig.secret };
  watchAmapErrors();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('加载超时，请检查网络')), 15000));
  const download = new Promise<void>((resolve, reject) => {
    (window as any).__onAmapLoaded = () =>
      window.AMap ? resolve() : reject(new Error('高德没有返回地图对象，请检查 Key 是否为 Web端(JS API) 类型'));
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(amapConfig.key)}&plugin=AMap.ToolBar,AMap.Scale&callback=__onAmapLoaded`;
    script.async = true;
    script.onerror = () => reject(new Error('下载脚本失败，请检查网络'));
    document.head.appendChild(script);
  });
  amapScript = Promise.race([download, timeout]).catch(error => {
    amapScript = null;
    throw error;
  });
  return amapScript;
}
// 按需加载高德的某个插件（搜索地点、逆地理编码），不依赖地图当前显示的是哪一家。
// 加载后插件类挂在 AMap 上，名字不带 "AMap." 前缀
function amapPlugin(name: string): Promise<any> {
  if (!amapConfig.key) return Promise.reject(new Error('未配置高德 Key'));
  return loadAmapScript().then(
    () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('加载高德插件超时，请检查网络')), 12000);
        window.AMap.plugin(name, () => {
          clearTimeout(timer);
          resolve(window.AMap[name.split('.')[1]]);
        });
      }),
  );
}
// 高德给的坐标有时是 [经度, 纬度] 数组，有时是 LngLat 对象
function lngLatOf(location: any): [number, number] | null {
  if (Array.isArray(location) && location.length >= 2) return [+location[0], +location[1]];
  if (location && typeof location.getLng === 'function') return [location.getLng(), location.getLat()];
  return location && typeof location.lng === 'number' ? [location.lng, location.lat] : null;
}
async function ensureAmap(): Promise<void> {
  if (amapState === 'ready') return;
  if (amapState === 'loading') return amapReady;
  amapState = 'loading';
  amapError = '';
  amapReady = (async () => {
    await loadAmapScript();
    if (!amapMap) createAmap();
    const center = toMap(view);
    amapMap.setZoomAndCenter(view.zoom, [center.lon, center.lat]);
    syncMarker();
  })().then(
    () => {
      amapState = 'ready';
    },
    (error: Error) => {
      amapState = 'error';
      amapError = error.message;
      throw error;
    },
  );
  return amapReady;
}
function createAmap() {
  const AMap = window.AMap;
  amapMap = new AMap.Map('map-amap', { viewMode: '2D', zoom: view.zoom, center: [view.lon, view.lat] });
  // 这一版高德的 offset 参数不生效，只有 position 写成对象才管用（实测）
  amapMap.addControl(new AMap.ToolBar({ position: { top: '70px', left: '10px' } }));
  amapMap.addControl(new AMap.Scale());
  amapMap.on('click', (event: any) => setPosition(fromMap({ lat: event.lnglat.getLat(), lon: event.lnglat.getLng() })));
  amapMap.on('moveend zoomend', captureView);
}

function setPosition(point: LngLat | null) {
  position = point;
  syncMarker();
  renderCoords();
  renderStatus();
}
function syncMarker() {
  if (basemap === 'osm') {
    if (!position) {
      if (osmMarker) osm.removeLayer(osmMarker);
      osmMarker = null;
    } else {
      if (!osmMarker) {
        osmMarker = L.marker([0, 0], { icon: pinIcon, draggable: true }).addTo(osm);
        osmMarker.on('dragend', () => setPosition({ lat: osmMarker!.getLatLng().lat, lon: wrapLon(osmMarker!.getLatLng().lng) }));
      }
      osmMarker.setLatLng([position.lat, position.lon]);
    }
  } else if (amapMap) {
    if (!position) {
      if (amapMarker) amapMap.remove(amapMarker);
      amapMarker = null;
    } else {
      if (!amapMarker) {
        amapMarker = new window.AMap.Marker({ draggable: true });
        amapMap.add(amapMarker);
        amapMarker.on('dragend', () => {
          const current = amapMarker.getPosition();
          setPosition(fromMap({ lat: current.getLat(), lon: current.getLng() }));
        });
      }
      const point = toMap(position);
      amapMarker.setPosition([point.lon, point.lat]);
    }
  }
}
function captureView() {
  if (basemap === 'osm') {
    const center = osm.getCenter();
    view = { lat: center.lat, lon: wrapLon(center.lng), zoom: osm.getZoom() };
  } else if (amapMap) {
    const center = amapMap.getCenter();
    view = { ...gcj02ToWgs84(center.getLat(), center.getLng()), zoom: amapMap.getZoom() };
  }
}
function moveTo(target: View) {
  if (basemap === 'osm') osm.setView([target.lat, target.lon], target.zoom);
  else if (amapMap) {
    const center = toMap(target);
    amapMap.setZoomAndCenter(target.zoom, [center.lon, center.lat]);
  }
}

async function applyBasemap() {
  $('#map-osm').hidden = basemap !== 'osm';
  $('#map-amap').hidden = basemap !== 'amap';
  $<HTMLSelectElement>('#basemap').value = basemap;
  if (basemap === 'osm') {
    osm.setView([view.lat, view.lon], view.zoom);
    setTimeout(() => osm.invalidateSize(), 0);
  } else {
    try {
      await ensureAmap();
    } catch (error: any) {
      toast(`高德地图加载失败：${error.message}`);
      basemap = 'osm';
      save('geotag.basemap', 'osm');
      await applyBasemap();
      openSettings();
      return;
    }
  }
  renderNotice();
  syncMarker();
  renderCoords();
}
async function setBasemap(next: Basemap) {
  if (next === basemap) return;
  if (next === 'amap' && !amapConfig.key) {
    toast('请先在设置里填写高德地图的 Key');
    openSettings();
    return;
  }
  captureView();
  basemap = next;
  save('geotag.basemap', next);
  await applyBasemap();
}
function openSettings() {
  $<HTMLInputElement>('#amap-key').value = amapConfig.key;
  $<HTMLInputElement>('#amap-secret').value = amapConfig.secret;
  $('#settings-status').textContent = amapError ? `高德地图加载失败：${amapError}` : amapAuthText();
  $('#settings-panel').hidden = false;
}

function parseCoords(text: string): LngLat | null {
  const match = text.trim().match(/^(-?\d+(?:\.\d+)?)[,，\s]+(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  let [first, second] = [+match[1], +match[2]];
  // 国内地图的坐标拾取器复制出来是“经度，纬度”：纬度不可能超过 90，据此识别并交换
  if (Math.abs(first) > 90 && Math.abs(second) <= 90) [first, second] = [second, first];
  return Math.abs(first) <= 90 && Math.abs(second) <= 180 ? { lat: first, lon: second } : null;
}

// ---------- 添加文件：按钮选择、拖拽 ----------

async function addPaths(paths: string[]) {
  if (!tauri) return;
  try {
    const fresh = paths.filter(path => !assets.some(a => a.path === path));
    if (!fresh.length) return toast('这些文件已经在列表里了');
    const result = await invoke<{ name: string; folder: string | null; kind: string; supported: boolean; size: number }[]>('classify_files', { paths: fresh });
    const seen = new Set(assets.map(a => a.path));
    const supported = result.filter(x => {
      // 拖入的文件夹里可能有已经在列表里的文件
      if (!x.supported || seen.has(x.name)) return false;
      seen.add(x.name);
      return true;
    });
    assets.push(
      ...supported.map(x => ({ id: nextId++, name: x.name.split(/[\\/]/).pop() || x.name, path: x.name, kind: x.kind as AssetKind, size: formatSize(x.size), selected: true, status: initialStatus(x.kind as AssetKind), done: false })),
    );
    // 新加进来的文件不该被筛选条件藏起来
    $<HTMLSelectElement>('#filter').value = '全部文件';
    renderList();
    renderStatus();
    const skipped = result.filter(x => !x.supported).length;
    const usable = result.length - skipped;
    const folders = [...new Set(result.map(x => x.folder).filter((folder): folder is string => !!folder))];
    let message = `已导入 ${supported.length} 个文件`;
    if (folders.length === 1) message = `已从文件夹“${folders[0].split(/[\\/]/).pop()}”导入 ${supported.length} 个文件`;
    if (folders.length > 1) message = `已导入 ${supported.length} 个文件（来自 ${folders.length} 个文件夹）`;
    if (!supported.length && folders.length) message = usable ? '文件夹里的文件已经在列表里了' : `${folders.length === 1 ? '这个文件夹' : '这些文件夹'}里没有可导入的照片、RAW 或视频`;
    if (!result.length) message = '文件夹里没有直接存放的文件，下层文件夹需要单独拖入';
    if (skipped) message += `，另有 ${skipped} 个不支持的文件已跳过`;
    toast(message);
  } catch (error) {
    toast(`导入失败：${error}`);
  }
}

$('#import').addEventListener('click', async () => {
  if (!tauri) return ($('#fileInput') as HTMLInputElement).click();
  const picked = await openDialog({ multiple: true, directory: false, filters: [{ name: '照片、RAW、视频', extensions: ['jpg', 'jpeg', 'png', 'heic', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'mp4', 'mov', 'm4v', 'mkv'] }] }).catch(error => {
    toast(`打开文件选择框失败：${error}`);
    return null;
  });
  if (Array.isArray(picked) && picked.length) await addPaths(picked);
});
$('#fileInput').addEventListener('change', event => {
  const files = [...((event.target as HTMLInputElement).files || [])];
  assets.push(...files.map(file => ({ id: nextId++, name: file.name, path: '', kind: classify(file.name), size: formatSize(file.size), selected: true, status: initialStatus(classify(file.name)), done: false })));
  $<HTMLSelectElement>('#filter').value = '全部文件';
  renderList();
  renderStatus();
  toast(`已导入 ${files.length} 个文件`);
});
// 拖拽：Tauri 接管了网页的拖放事件，坐标是物理像素，要换算成页面坐标再判断落点
if (tauri) {
  const zone = $('#drop-zone');
  const overZone = (x: number, y: number) => {
    const rect = zone.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };
  getCurrentWebview().onDragDropEvent(event => {
    const zone = $('#drop-zone');
    const payload = event.payload;
    if (payload.type === 'leave') return zone.classList.remove('drop-target');
    const scale = window.devicePixelRatio || 1;
    const inside = overZone(payload.position.x / scale, payload.position.y / scale);
    if (payload.type !== 'drop') return zone.classList.toggle('drop-target', inside);
    zone.classList.remove('drop-target');
    if (inside) void addPaths(payload.paths);
    else toast('请把文件拖到左侧“待处理文件”区域');
  });
}

// ---------- 列表的清除与筛选（都只动列表，不动文件） ----------

$('#clear-done').addEventListener('click', () => {
  const done = assets.filter(a => a.done).length;
  if (!done) return toast('没有已处理的文件');
  assets = assets.filter(a => !a.done);
  renderList();
  renderStatus();
  toast(`已从列表移除 ${done} 个已处理的文件`);
});
$('#clear-all').addEventListener('click', () => {
  if (!assets.length) return toast('列表是空的');
  const removed = assets.length;
  assets = [];
  renderList();
  renderStatus();
  toast(`已清空列表（${removed} 个文件），源文件没有改动`);
});
$('#filter').addEventListener('change', renderList);

// ---------- 地点搜索 ----------

let searchHits: SearchHit[] = [];
function closeSearch() {
  $('#search-results').hidden = true;
  searchHits = [];
}
function showSearchState(text: string) {
  $('#search-results').innerHTML = `<div class='search-state'>${esc(text)}</div>`;
  $('#search-results').hidden = false;
}
// 高德的地点搜索返回 GCJ-02 坐标；没配高德 Key 时退回 OpenStreetMap 的搜索服务（WGS84，国内通常需要代理）
async function searchPlaces(keyword: string): Promise<SearchHit[]> {
  if (amapConfig.key) {
    const PlaceSearch = await amapPlugin('AMap.PlaceSearch');
    return new Promise((resolve, reject) => {
      // extensions: 'all' 才带城市名和区县名
      new PlaceSearch({ city: '', citylimit: false, pageSize: 10, pageIndex: 1, extensions: 'all' }).search(keyword, (status: string, result: any) => {
        // 出错（配额用完、Key 不对等）要如实报出来，不能当成“没有找到”
        if (status === 'error') return reject(new Error(result?.info || '高德返回了错误'));
        const pois = status === 'complete' && result.poiList ? result.poiList.pois : [];
        resolve(
          pois
            .map((poi: any) => {
              const point = lngLatOf(poi.location);
              return point
                ? { name: poi.name, address: [poi.cityname, poi.adname, poi.address].filter(Boolean).join(''), lat: point[1], lon: point[0], crs: 'GCJ-02' as const }
                : null;
            })
            .filter((hit: SearchHit | null): hit is SearchHit => hit !== null),
        );
      });
    });
  }
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh&q=${encodeURIComponent(keyword)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const list = (await response.json()) as { lat: string; lon: string; display_name: string }[];
  return list.map(item => ({ name: item.display_name.split(',')[0], address: item.display_name, lat: +item.lat, lon: +item.lon, crs: 'WGS84' as const }));
}
async function runSearch(keyword: string) {
  showSearchState('搜索中…');
  try {
    const hits = await searchPlaces(keyword);
    if (!hits.length) return showSearchState(`没有找到“${keyword}”，换个说法试试`);
    searchHits = hits;
    $('#search-results').innerHTML = hits.map((hit, index) => `<button class='search-hit' data-index='${index}'><b>${esc(hit.name)}</b><small>${esc(hit.address)}</small></button>`).join('');
    $('#search-results').hidden = false;
  } catch (error: any) {
    const reason = /timed out|abort/i.test(`${error}`) ? '连接搜索服务超时' : error.message || `${error}`;
    showSearchState(`搜索失败：${reason}。${amapConfig.key ? '' : 'OpenStreetMap 的搜索服务在国内通常需要代理，也可以在设置里填写高德 Key'}`);
  }
}
async function submitSearch() {
  const text = $<HTMLInputElement>('#search').value.trim();
  if (!text) return;
  const typed = parseCoords(text);
  if (typed) {
    closeSearch();
    setPosition(fromMap(typed));
    view = { ...(position as LngLat), zoom: Math.max(view.zoom, 14) };
    moveTo(view);
    return toast(`已定位到输入坐标（按${CRS_NAME[basemap]}解析）`);
  }
  await runSearch(text);
}
$('#search').addEventListener('keydown', async (event) => {
  if ((event as KeyboardEvent).key === 'Escape') return closeSearch();
  if ((event as KeyboardEvent).key === 'Enter') await submitSearch();
});
$('#search-go').addEventListener('click', () => void submitSearch());
$('#search-results').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.search-hit');
  if (!button) return;
  const hit = searchHits[+button.dataset.index!];
  if (!hit) return;
  const found = hit.crs === 'GCJ-02' ? gcj02ToWgs84(hit.lat, hit.lon) : { lat: hit.lat, lon: wrapLon(hit.lon) };
  setPosition(found);
  view = { ...found, zoom: Math.max(view.zoom, 15) };
  moveTo(view);
  $<HTMLInputElement>('#search').value = hit.name;
  closeSearch();
  toast(`已定位到 ${hit.name}`);
});
document.addEventListener('pointerdown', event => {
  const target = event.target as HTMLElement;
  if (!target.closest('#search-results') && !target.closest('#search')) closeSearch();
});

// ---------- 写入 ----------

// 写入只有一个入口：先列出将要发生的改动，确认之后才动文件
function planFor(asset: Asset): { text: string; warn?: boolean } {
  if (asset.kind === '视频') return { text: `生成 ${asset.name}.xmp，原视频不改动` };
  return $<HTMLSelectElement>('#backup').value === 'none'
    ? { text: '写入 EXIF GPS，不备份、直接修改原文件', warn: true }
    : { text: `写入 EXIF GPS，原始文件备份为 ${asset.name}.bak（已有则不覆盖）` };
}
function openWriteDialog() {
  if (!assets.length) return toast('请先添加照片、RAW 或视频');
  const chosen = selected();
  if (!chosen.length) return toast('请先在左侧勾选要写入的文件');
  if (!position) return toast('请先在地图上选择位置');
  const writable = chosen.filter(a => a.path);
  if (!writable.length) return toast('这些文件没有磁盘路径，无法写入');
  const shown = toMap(position);
  $('#dialog-place').innerHTML = `<div><b>写入位置</b> WGS84 ${formatGps(position.lat, position.lon)}</div><small>当前地图（${CRS_NAME[basemap]}）：${shown.lat.toFixed(6)}, ${shown.lon.toFixed(6)}</small>`;
  $('#dialog-files').innerHTML = writable
    .map(a => {
      const plan = planFor(a);
      return `<li><b title='${esc(a.path)}'>${esc(a.name)}</b><span class='${plan.warn ? 'warn' : ''}'>${esc(plan.text)}</span></li>`;
    })
    .join('');
  $<HTMLButtonElement>('#dialog-confirm').textContent = `确认写入 ${writable.length} 个文件`;
  $('#dialog').hidden = false;
}
let writing = false;
async function performWrite() {
  const target = position;
  const chosen = selected().filter(a => a.path);
  if (writing || !target || !chosen.length) return;
  $('#dialog').hidden = true;
  writing = true;
  $<HTMLButtonElement>('#write').disabled = true;
  chosen.forEach(a => {
    a.status = '写入中…';
    a.done = false;
  });
  renderList();
  let results: WriteResult[] | null = null;
  let failure = '';
  try {
    results = await invoke<WriteResult[]>('write_gps', {
      request: { paths: chosen.map(a => a.path), latitude: target.lat, longitude: target.lon, backup: $<HTMLSelectElement>('#backup').value },
    });
  } catch (error) {
    failure = `${error}`;
    toast(`写入失败：${failure}`);
  }
  chosen.forEach(a => {
    const result = results?.find(item => item.path === a.path);
    a.status = result ? (result.success ? result.action : `写入失败：${(result.error || '').trim()}`) : `写入失败：${failure || '没有返回结果'}`;
    a.done = Boolean(result?.success);
  });
  writing = false;
  $<HTMLButtonElement>('#write').disabled = false;
  renderList();
  const failed = chosen.filter(a => !a.done).length;
  toast(failed ? `完成：${chosen.length - failed} 个成功，${failed} 个失败，原因见列表` : `已写入 ${chosen.length} 个文件`);
  void recordHistory(chosen, target);
}

// ---------- 处理记录 ----------

// 城市用高德的逆地理编码查（需要配置高德 Key，坐标要转成 GCJ-02）；查不到就留空
async function cityOf(point: LngLat): Promise<string | null> {
  if (!amapConfig.key) return null;
  const lookup = amapPlugin('AMap.Geocoder').then(
    Geocoder =>
      new Promise<string | null>(resolve => {
        const gcj = wgs84ToGcj02(point.lat, point.lon);
        new Geocoder().getAddress([gcj.lon, gcj.lat], (status: string, result: any) => {
          const part = result?.regeocode?.addressComponent;
          if (status !== 'complete' || !part) return resolve(null);
          // 直辖市的 city 是空数组，这时用省份名
          const city = typeof part.city === 'string' && part.city ? part.city : part.province;
          if (!city) return resolve(null);
          const district = Array.isArray(part.district) ? '' : part.district;
          resolve([part.province === city ? '' : part.province, city, district].filter(Boolean).join(' '));
        });
      }),
  );
  const giveUp = new Promise<null>(resolve => setTimeout(() => resolve(null), 4000));
  return Promise.race([lookup.catch(() => null), giveUp]);
}
async function recordHistory(files: Asset[], target: LngLat) {
  // 一批文件写入的是同一个位置，城市只查一次
  const city = files.some(a => a.done) ? await cityOf(target) : null;
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const records: HistoryRecord[] = files.map(a => ({
    time,
    file: a.name,
    path: a.path,
    status: a.done ? '成功' : '失败',
    latitude: a.done ? target.lat : null,
    longitude: a.done ? target.lon : null,
    city: a.done ? city : null,
    error: a.done ? null : a.status,
  }));
  try {
    await invoke('record_history', { records });
  } catch (error) {
    toast(`处理记录保存失败：${error}`);
  }
}
async function openHistory() {
  $('#history-list').innerHTML = `<div class='history-empty'>读取中…</div>`;
  $('#history-count').textContent = '';
  $('#history-dialog').hidden = false;
  try {
    const records = await invoke<HistoryRecord[]>('load_history');
    $('#history-count').textContent = `共 ${records.length} 条`;
    $('#history-list').innerHTML = records.length
      ? records
          .map(
            record => `<div class='history-row'><span class='h-file'><b title='${esc(record.path)}'>${esc(record.file)}</b><small>${esc(record.time)}</small></span><span class='h-status ${record.status === '成功' ? 'ok' : 'bad'}' title='${esc(record.error || '')}'>${esc(record.status)}</span><span class='h-gps'>${record.latitude === null || record.longitude === null ? '—' : esc(formatGps(record.latitude, record.longitude))}</span><span class='h-city' title='${esc(record.city || '')}'>${esc(record.city || '—')}</span>${record.error ? `<span class='h-reason'>${esc(record.error)}</span>` : ''}</div>`,
          )
          .join('')
      : `<div class='history-empty'>还没有处理记录</div>`;
  } catch (error) {
    $('#history-list').innerHTML = `<div class='history-empty'>读取失败：${esc(`${error}`)}</div>`;
  }
}
$('#history').addEventListener('click', openHistory);
$('#history-close').addEventListener('click', () => ($('#history-dialog').hidden = true));
$('#history-dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) $('#history-dialog').hidden = true;
});

$('#write').addEventListener('click', openWriteDialog);
$('#dialog-confirm').addEventListener('click', performWrite);
$('#dialog-cancel').addEventListener('click', () => ($('#dialog').hidden = true));
$('#dialog').addEventListener('click', event => {
  if (event.target === event.currentTarget) $('#dialog').hidden = true;
});
document.addEventListener('keydown', event => {
  if ((event as KeyboardEvent).key !== 'Escape') return;
  $('#dialog').hidden = true;
  $('#history-dialog').hidden = true;
  closeSearch();
});
$('#basemap').addEventListener('change', event => setBasemap((event.target as HTMLSelectElement).value as Basemap));
$('#settings').addEventListener('click', openSettings);
$('#settings-cancel').addEventListener('click', () => ($('#settings-panel').hidden = true));
$('#settings-save').addEventListener('click', () => {
  amapConfig = { key: $<HTMLInputElement>('#amap-key').value.trim(), secret: $<HTMLInputElement>('#amap-secret').value.trim() };
  save('geotag.amap', amapConfig);
  // 高德脚本只能用加载时的密钥初始化，改了密钥要重新加载页面
  location.reload();
});

// 供自动化检查读取当前状态，只读
(window as any).__geotag = {
  get position() {
    return position ? { ...position } : null;
  },
  get basemap() {
    return basemap;
  },
  get view() {
    return { ...view };
  },
  get amapState() {
    return amapState;
  },
  get amapAuthError() {
    return amapAuthError;
  },
  get files() {
    return assets.map(a => ({ name: a.name, path: a.path, kind: a.kind, selected: a.selected, status: a.status, done: a.done }));
  },
  get dialogOpen() {
    return !$('#dialog').hidden;
  },
  get writing() {
    return writing;
  },
  get searchHits() {
    return searchHits.map(hit => ({ ...hit }));
  },
};

renderList();
renderStatus();
applyBasemap();
