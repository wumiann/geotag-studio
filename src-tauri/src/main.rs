// 发布版不显示控制台窗口；debug 构建保留，方便看到报错
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    photo_gps_manager_lib::run();
}
