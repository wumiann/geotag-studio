# 第三方组件声明

GeoTag Studio 自身的代码以 [GNU GPL v3](LICENSE) 发布。可执行程序压缩包里还带有下列第三方组件，程序运行时也会用到一些在线服务。它们各自遵循自己的许可证和条款，与 GeoTag Studio 的许可证无关。

## 随压缩包分发的组件

### ExifTool

- 版权：Copyright 2003-2025, Phil Harvey
- 主页：<https://exiftool.org/>
- 许可证：与 Perl 相同的许可证，即 Artistic License 1.0 或 GNU General Public License，可任选其一
- 使用方式：作为独立的外部程序通过命令行调用，不与 GeoTag Studio 的代码链接
- 分发方式：ExifTool 官方 Windows 压缩包（13.64）原样分发，没有修改任何文件，只把启动器 `exiftool(-k).exe` 改名为 `exiftool.exe`
- 许可证全文随包保存在 `exiftool_files` 文件夹里：`LICENSE`、`windows_exiftool.txt`、`Licenses_Strawberry_Perl.zip`

### Strawberry Perl 运行库

`exiftool_files` 文件夹里的 `perl.exe`、`perl532.dll` 等文件来自 Strawberry Perl，是 ExifTool 官方 Windows 压缩包自带的。

- 主页：<http://strawberryperl.com/>
- 许可证：GNU General Public License 或 Artistic License
- 其中各个开源库的许可证全文见 `exiftool_files\Licenses_Strawberry_Perl.zip`

### Microsoft Visual C++ 运行库

`vcruntime140.dll`、`vcruntime140_1.dll`、`vcruntime140_threads.dll`、`msvcp140.dll`、`msvcp140_1.dll`、`msvcp140_2.dll`、`msvcp140_atomic_wait.dll`、`msvcp140_codecvt_ids.dll`、`concrt140.dll`、`vccorlib140.dll`

- 版权：Copyright Microsoft Corporation
- 来源：Microsoft Visual C++ 2015-2022 Redistributable（x64）v14.44.35211，文件版本 14.44.35211.0
- 分发方式：依据 Microsoft 的许可条款，这些文件属于允许随程序分发的“可分发代码”（Distributable Code），这里原样分发，没有做任何修改

## 链接进程序的组件

GeoTag Studio 的源代码编译时用到下面这些开源项目，它们各自的许可证见对应的项目主页：

- [Tauri](https://tauri.app/) 2（MIT / Apache-2.0）：桌面窗口和前后端通信
- [Leaflet](https://leafletjs.com/) 1.9（BSD-2-Clause）：OpenStreetMap 地图的渲染、缩放和图钉
- 其余 Rust 和前端依赖列在 `src-tauri/Cargo.lock` 和 `pnpm-lock.yaml` 里

## 在线服务

程序本身不包含地图数据，运行时通过联网使用下列服务，使用时需要遵守各自的服务条款：

- **高德地图 JS API**：脚本在运行时从高德的服务器加载，版权归高德软件有限公司。需要在高德开放平台申请自己的 Key 和安全密钥，配额与条款以高德开放平台的说明为准
- **OpenStreetMap**：地图数据 © OpenStreetMap 贡献者，以 [ODbL 1.0](https://www.openstreetmap.org/copyright) 提供；地点搜索使用其公开的 Nominatim 服务
