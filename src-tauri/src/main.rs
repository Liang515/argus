// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // hook 呼叫的摘要工具：處理完就結束，不開視窗
    if std::env::args().nth(1).as_deref() == Some("--hook-summary") {
        argus_lib::hook_summary_main();
        return;
    }
    argus_lib::run()
}
