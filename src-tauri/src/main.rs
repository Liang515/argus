// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // hook 呼叫的摘要工具：處理完就結束，不開視窗
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--hook-summary") => return argus_lib::hook_summary_main(),
        // Windows 的狀態 hook（見 hook.rs）
        Some("--hook") => return argus_lib::hook_main(&args[1..]),
        _ => {}
    }
    // 舊版 Claude Code 不認得 hooks.json 的 args，會不帶參數執行 argus.exe：
    // 在 Argus 分頁裡、stdin 又是管線（hook 會把資料接到 stdin）時不開新視窗
    #[cfg(windows)]
    if args.is_empty() && std::env::var_os("ARGUS_TAB_ID").is_some() && argus_lib::stdin_is_pipe() {
        return;
    }
    argus_lib::run()
}
