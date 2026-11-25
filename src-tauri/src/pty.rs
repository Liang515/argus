//! 每個分頁一個 PTY session：在專案目錄啟動 shell（macOS：login shell；Windows：PowerShell），
//! 輸出經 Channel 串流回前端。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::integration::Integration;

/// 輸出批次送出的最長等待時間（約一個畫面更新週期）。
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// 單批輸出上限，避免大量輸出時一次塞爆前端。
const MAX_BATCH: usize = 256 * 1024;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell_pid: Option<u32>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
    integration: Option<Integration>,
}

impl PtyManager {
    pub fn new(integration: Option<Integration>) -> Self {
        Self {
            sessions: Mutex::default(),
            integration,
        }
    }

    /// 前景有程式（不是 shell 本身）在跑的分頁數，結束 App 前用來決定要不要確認。
    pub fn busy_count(&self) -> usize {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.values().filter(|s| is_busy(s)).count()
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for (_, mut s) in sessions.drain() {
            let _ = s.killer.kill();
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

/// 從 GUI App 繼承的環境變數整理成子行程環境：
/// 移除巢狀 Claude Code / Argus 會誤判的變數，補上終端機、UTF-8 設定與 `extra`。
fn child_env(
    parent: impl IntoIterator<Item = (String, String)>,
    extra: Vec<(String, String)>,
) -> Vec<(String, String)> {
    // Windows 的環境變數名稱不分大小寫
    let name = |k: &str| {
        if cfg!(windows) {
            k.to_ascii_uppercase()
        } else {
            k.to_string()
        }
    };
    let mut env: Vec<(String, String)> = parent
        .into_iter()
        .filter(|(k, _)| {
            let k = name(k);
            !(k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k.starts_with("ARGUS_"))
        })
        .filter(|(k, _)| !matches!(name(k).as_str(), "TERM" | "COLORTERM" | "TERM_PROGRAM"))
        .collect();
    // macOS 的 GUI App 沒有 LANG，補上 UTF-8 才不會亂碼。Windows 不用 LANG 決定編碼，
    // 補了反而會讓 git 等工具改用英文訊息
    if !cfg!(windows) && !env.iter().any(|(k, _)| k == "LANG") {
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    env.push(("TERM_PROGRAM".into(), "Argus".into()));
    env.extend(extra);
    env
}

/// Argus 專屬變數：分頁 id、終端機裝置路徑（給 hook 回報狀態），zsh 再加上 ZDOTDIR 包裝。
fn argus_env(
    tab_id: &str,
    tty: Option<&Path>,
    shell: &str,
    integration: Option<&Integration>,
) -> Vec<(String, String)> {
    let mut extra = vec![("ARGUS_TAB_ID".to_string(), tab_id.to_string())];
    if let Some(tty) = tty {
        extra.push(("ARGUS_TTY".into(), tty.to_string_lossy().into_owned()));
    }
    if let Some(integration) = integration {
        if let Some(pipe) = &integration.pipe {
            extra.push((crate::hook::PIPE_ENV.into(), pipe.clone()));
        }
        extra.push((
            "ARGUS_HOOKS".into(),
            integration.hooks_file.to_string_lossy().into_owned(),
        ));
        if Path::new(shell).file_name().is_some_and(|n| n == "zsh") {
            if let Ok(user_zdotdir) = std::env::var("ZDOTDIR") {
                extra.push(("ARGUS_USER_ZDOTDIR".into(), user_zdotdir));
            }
            extra.push((
                "ZDOTDIR".into(),
                integration.zsh_dir.to_string_lossy().into_owned(),
            ));
        }
    }
    extra
}

/// 分頁要啟動的 shell 與參數。
#[cfg(not(windows))]
fn shell(_hooks: bool) -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // login shell 會載入 .zprofile / .zshrc，GUI App 才拿得到使用者的 PATH。
    (shell, vec!["-l".into()])
}

/// Windows 版的 `claude` 包裝（同 zsh 的 `function claude`）：在使用者的 profile 之後定義，
/// 執行 claude 時自動帶上狀態回報 hooks。使用者的 alias 會蓋過函式，所以先移除。
/// 找真正的 claude 時只看執行檔（claude.exe、npm 的 claude.cmd；不然會找到這個函式自己，
/// .ps1 也可能被執行原則擋下）。不能有雙引號：整段是一個命令列參數。
#[cfg(windows)]
const POWERSHELL_CLAUDE: &str = "Remove-Item Alias:claude -Force -ErrorAction SilentlyContinue; \
function global:claude { \
$c = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; \
if (-not $c) { Write-Error 'claude: command not found'; return }; \
& $c.Source --settings $env:ARGUS_HOOKS @args }";

/// Windows：有裝 PowerShell 7（pwsh）就用它，否則用系統內建的 Windows PowerShell。
#[cfg(windows)]
fn shell(hooks: bool) -> (String, Vec<String>) {
    let shell = crate::sys::find_in_path("pwsh")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "powershell.exe".into());
    let mut args = vec!["-NoLogo".to_string()];
    if hooks {
        // -NoExit：執行完包裝後留在互動模式；使用者的 profile 照常先載入
        args.extend([
            "-NoExit".into(),
            "-Command".into(),
            POWERSHELL_CLAUDE.into(),
        ]);
    }
    (shell, args)
}

fn build_command(
    cwd: &str,
    hooks: bool,
    extra: impl Fn(&str) -> Vec<(String, String)>,
) -> CommandBuilder {
    let (shell, args) = shell(hooks);
    let extra = extra(&shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(args);
    cmd.env_clear();
    for (k, v) in child_env(std::env::vars().filter(|(k, _)| k != "ZDOTDIR"), extra) {
        // Windows：PATH 換成最新的（見 sys::current_path），不用重開 Argus 就找得到剛裝的 agent
        #[cfg(windows)]
        let v = if k.eq_ignore_ascii_case("PATH") {
            crate::sys::current_path()
        } else {
            v
        };
        cmd.env(k, v);
    }
    let dir = if Path::new(cwd).is_dir() {
        cwd.to_string()
    } else {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| if cfg!(windows) { r"C:\" } else { "/" }.into())
    };
    cmd.cwd(dir);
    cmd
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<bool, String> {
    // 資料夾不見了（例如改名）會退回家目錄開啟，回傳 true 讓前端提示使用者
    let cwd_missing = !Path::new(&cwd).is_dir();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // Windows（ConPTY）沒有終端機裝置路徑，hook 改經 named pipe 回報（見 hook.rs）
    #[cfg(unix)]
    let tty = pair.master.tty_name();
    #[cfg(not(unix))]
    let tty: Option<std::path::PathBuf> = None;
    let command = build_command(&cwd, state.integration.is_some(), |shell| {
        argus_env(&id, tty.as_deref(), shell, state.integration.as_ref())
    });
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    // 父行程不保留 slave，shell 結束時 reader 才會收到 EOF。
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let session = Session {
        killer: child.clone_killer(),
        shell_pid: child.process_id(),
        master: pair.master,
        writer,
    };
    if let Some(mut old) = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), session)
    {
        let _ = old.killer.kill();
    }

    // 回收子行程，避免 zombie。
    thread::spawn(move || {
        let _ = child.wait();
    });

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 把零碎輸出合併成批次再送；原始 bytes 交給 xterm 解碼，中文不會被切壞。
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = first;
            let deadline = Instant::now() + FLUSH_INTERVAL;
            while batch.len() < MAX_BATCH {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if on_data.send(InvokeResponseBody::Raw(batch)).is_err() {
                break;
            }
        }
        let _ = app.emit("pty-exit", PtyExit { id });
    });

    Ok(cwd_missing)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(mut s) = removed {
        let _ = s.killer.kill();
    }
    Ok(())
}

/// shell 前景是否有其他程式在跑（例如 claude），關分頁前用來決定要不要確認。
#[tauri::command]
pub fn pty_is_busy(state: State<'_, PtyManager>, id: String) -> Result<bool, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.get(&id).is_some_and(is_busy))
}

/// 前景行程群組不是 shell，就代表有程式（agent、npm run dev…）在跑。
#[cfg(unix)]
fn is_busy(session: &Session) -> bool {
    match (session.master.process_group_leader(), session.shell_pid) {
        (Some(fg), Some(shell)) => fg as u32 != shell,
        _ => false,
    }
}

/// Windows 沒有前景行程群組：shell 還活著、而且底下有子行程（agent、npm run dev…）就算在忙。
/// 已知限制：從 PowerShell 直接開的 GUI 程式（例如 `notepad a.txt`）開著時也會算忙碌。
#[cfg(windows)]
fn is_busy(session: &Session) -> bool {
    session.shell_pid.is_some_and(shell_has_child)
}

/// 一次快照同時確認 shell 本身還在：shell 結束後，Windows 不會改掉它留下的子行程的父行程編號，
/// 只看「父行程是 pid」的話，已關閉的分頁會一直被當成在忙。
#[cfg(windows)]
fn shell_has_child(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY：只讀取行程快照，handle 用完就關；PROCESSENTRY32W 依文件先設好 dwSize。
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut shell_alive = false;
        let mut child = false;
        let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
        while ok {
            if entry.th32ProcessID == pid {
                shell_alive = true;
            } else if entry.th32ParentProcessID == pid && !is_console_host(&entry.szExeFile) {
                child = true;
            }
            ok = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        shell_alive && child
    }
}

/// conhost／OpenConsole 是 ConPTY 自己的輔助行程，不算使用者啟動的程式。
#[cfg(windows)]
fn is_console_host(exe: &[u16]) -> bool {
    let len = exe.iter().position(|&c| c == 0).unwrap_or(exe.len());
    let name = String::from_utf16_lossy(&exe[..len]);
    name.eq_ignore_ascii_case("conhost.exe") || name.eq_ignore_ascii_case("OpenConsole.exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn strips_nested_claude_code_vars() {
        let env = child_env(
            env_of(&[
                ("CLAUDECODE", "1"),
                ("CLAUDE_CODE_ENTRYPOINT", "cli"),
                ("ARGUS_TTY", "/dev/ttys999"),
                ("HOME", "/Users/x"),
            ]),
            vec![],
        );
        assert_eq!(get(&env, "CLAUDECODE"), None);
        assert_eq!(get(&env, "ARGUS_TTY"), None);
        assert_eq!(get(&env, "CLAUDE_CODE_ENTRYPOINT"), None);
        assert_eq!(get(&env, "HOME"), Some("/Users/x"));
    }

    #[test]
    fn sets_terminal_vars_and_extra() {
        let env = child_env(
            env_of(&[("TERM", "dumb")]),
            argus_env("tab1", None, "/bin/bash", None),
        );
        assert_eq!(get(&env, "TERM"), Some("xterm-256color"));
        assert_eq!(env.iter().filter(|(k, _)| k == "TERM").count(), 1);
        assert_eq!(get(&env, "COLORTERM"), Some("truecolor"));
        assert_eq!(get(&env, "ARGUS_TAB_ID"), Some("tab1"));
    }

    // Windows 不補 LANG（見 child_env）
    #[cfg(unix)]
    #[test]
    fn lang_defaults_to_utf8_but_keeps_user_value() {
        let env = child_env(env_of(&[]), vec![]);
        assert_eq!(get(&env, "LANG"), Some("en_US.UTF-8"));
        let env = child_env(env_of(&[("LANG", "zh_TW.UTF-8")]), vec![]);
        assert_eq!(get(&env, "LANG"), Some("zh_TW.UTF-8"));
    }

    /// 用真的 PowerShell 驗證：claude 函式找得到真正的 claude，帶上 --settings 與原本的參數，
    /// 使用者的 alias 不會擋掉它。
    #[cfg(windows)]
    #[test]
    fn powershell_wrapper_adds_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude.cmd"), "@echo ARGS:%*\r\n").unwrap();
        let path = format!(
            "{};{}",
            dir.path().display(),
            std::env::var("PATH").unwrap()
        );
        let script =
            format!("Set-Alias claude Get-Date; {POWERSHELL_CLAUDE}; claude -c 'two words'");
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-Command", &script])
            .env("PATH", path)
            .env("ARGUS_HOOKS", r"C:\x\hooks.json")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains(r#"ARGS:--settings C:\x\hooks.json -c "two words""#),
            "{stdout}\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn argus_env_wraps_zsh_only() {
        let integration = Integration {
            hooks_file: "/d/hooks.json".into(),
            zsh_dir: "/d/zsh".into(),
            pipe: None,
        };
        let tty = Path::new("/dev/ttys004");
        let zsh = argus_env("t", Some(tty), "/bin/zsh", Some(&integration));
        assert_eq!(get(&zsh, "ARGUS_TTY"), Some("/dev/ttys004"));
        assert_eq!(get(&zsh, "ARGUS_HOOKS"), Some("/d/hooks.json"));
        assert_eq!(get(&zsh, "ZDOTDIR"), Some("/d/zsh"));
        let bash = argus_env("t", Some(tty), "/bin/bash", Some(&integration));
        assert_eq!(get(&bash, "ZDOTDIR"), None);
        assert_eq!(get(&bash, "ARGUS_TTY"), Some("/dev/ttys004"));
    }
}
