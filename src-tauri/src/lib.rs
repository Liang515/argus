mod activity;
mod custom_agents;
mod editors;
mod git;
mod handoff;
mod hook;
mod integration;
mod paths;
mod project;
mod pty;
mod sys;
mod theme;
mod updater;
mod workspace;

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

const QUIT_MENU_ID: &str = "argus-quit";

/// 有分頁在忙、而且這次還沒問過，才需要前端確認；沒有分頁在忙就直接結束，
/// 前端卡住或系統關機時也不會被擋。
fn needs_confirmation<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<pty::PtyManager>().busy_count() > 0 && app.state::<QuitGate>().should_ask()
}

/// ⌘Q（選單的 Quit）：需要確認就交給前端，否則直接結束。
fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if needs_confirmation(app) {
        let _ = app.emit("quit-requested", ());
    } else {
        app.exit(0);
    }
}

/// 前端在 [`QUIT_GRACE`] 內沒回應（例如卡住）時，再按一次 ⌘Q 就直接結束。
const QUIT_GRACE: Duration = Duration::from_secs(5);

/// ⌘Q 或關視窗時先交給前端確認（有 agent 在跑會先問），記下上次請求的時間。
#[derive(Default)]
struct QuitGate {
    state: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    pending_since: Option<Instant>,
    /// 已經放行（連按兩次）：關視窗後接著的結束請求也不要再擋
    forced: bool,
}

impl QuitGate {
    /// 回傳 true 表示要擋下這次結束、改問前端；連按兩次且前端沒回應時放行。
    fn should_ask(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.forced {
            return false;
        }
        match state.pending_since {
            Some(since) if since.elapsed() < QUIT_GRACE => {
                // 對話框已經開著、使用者又按了一次：讓它結束
                state.forced = true;
                false
            }
            _ => {
                state.pending_since = Some(Instant::now());
                true
            }
        }
    }

    fn clear(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending_since = None;
    }
}

/// 前端確認後真的結束（`app.exit` 帶結束碼，不會再被 [`QuitGate`] 擋下）。
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    app.exit(0);
}

/// 使用者在對話框按了取消。
#[tauri::command]
fn cancel_quit(gate: tauri::State<'_, QuitGate>) {
    gate.clear();
}

/// 自訂選單：保留編輯（複製／貼上）與視窗功能，
/// 但不放「Close Window」，讓 Cmd+W 交給前端關分頁。
#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        app,
        "Argus",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            // 不用系統內建的 Quit：macOS 上它會直接結束，跳過「有 agent 在跑」的確認
            &MenuItem::with_id(app, QUIT_MENU_ID, "Quit Argus", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
}

/// `argus --hook-summary`：給 hook 呼叫的小工具，不啟動視窗。
pub fn hook_summary_main() {
    activity::hook_summary_main();
}

/// `argus --handoff-context`：交接後清除對話的 SessionStart hook（見 handoff.rs）。
pub fn handoff_context_main() {
    handoff::context_main();
}

/// Windows：stdin 是不是管線（見 main.rs 的舊版 Claude Code 判斷）。
#[cfg(windows)]
pub fn stdin_is_pipe() -> bool {
    sys::stdin_is_pipe()
}

/// `argus --hook <狀態> [agent]`：Windows 的狀態 hook，送給執行中的 Argus 後結束。
pub fn hook_main(args: &[String]) {
    hook::hook_main(args);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    let pipe = hook::new_pipe_name();
    #[cfg(windows)]
    let integration = integration::install(pipe.clone());
    #[cfg(not(windows))]
    let integration = integration::install();
    let builder = tauri::Builder::default();
    // macOS 的選單在螢幕頂端；Windows 設了選單（即使是空的）會在視窗裡多一排選單列，所以不設
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu);
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyManager::new(
            integration
                .inspect_err(|e| eprintln!("Claude 狀態整合安裝失敗：{e}"))
                .ok(),
        ))
        .manage(project::Watchers::default())
        .manage(QuitGate::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_is_busy,
            workspace::workspace_load,
            workspace::workspace_save,
            workspace::resolve_dir,
            workspace::recap_load,
            workspace::recap_save,
            git::git_branch,
            project::git_status,
            project::read_project_doc,
            project::open_in,
            project::create_worktree,
            project::detect_agents,
            editors::detect_apps,
            custom_agents::read_custom_agents,
            custom_agents::edit_custom_agents,
            project::add_handoff_protocol,
            handoff::handoff_mark,
            paths::resolve_paths,
            paths::open_path,
            theme::terminal_app_theme,
            updater::install_update,
            project::watch_project,
            project::unwatch_project,
            confirm_quit,
            cancel_quit,
        ])
        .setup(move |_app| {
            #[cfg(windows)]
            hook::serve(_app.handle().clone(), pipe);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ID {
                request_quit(app);
            }
        })
        .on_window_event(|window, event| {
            // 點紅色按鈕關視窗＝結束 App，一樣先讓前端確認
            if let WindowEvent::CloseRequested { api, .. } = event
                && needs_confirmation(window.app_handle())
            {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // code 是 None 代表使用者按 ⌘Q（不是 confirm_quit 呼叫的 app.exit）
            RunEvent::ExitRequested {
                code: None, api, ..
            } if needs_confirmation(app) => {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
            }
            RunEvent::Exit => app.state::<pty::PtyManager>().kill_all(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_gate_asks_first_and_lets_a_second_press_through() {
        let gate = QuitGate::default();
        assert!(gate.should_ask(), "第一次 ⌘Q 先問前端");
        gate.clear();
        assert!(gate.should_ask(), "取消後下一次 ⌘Q 一樣先問");
        assert!(!gate.should_ask(), "對話框沒回應時再按一次就結束");
        assert!(
            !gate.should_ask(),
            "放行後（例如關掉最後一個視窗）接著的結束請求不再擋"
        );
    }
}
