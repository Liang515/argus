//! Claude Code 狀態回報整合。
//!
//! Argus 啟動時把以下檔案寫進 `~/.argus/`，不動使用者自己的設定：
//! - `hook.sh`：Claude Code hook，把狀態以 OSC 7777 寫進該分頁的終端機裝置（`$ARGUS_TTY`）。
//!   hook 子行程沒有 controlling tty，所以不能寫 `/dev/tty`，改用 PTY 啟動時記下的裝置路徑。
//! - `hooks.json`：給 `claude --settings` 用的 hooks 設定，只在 Argus 裡生效。
//! - `zsh/`：ZDOTDIR 包裝，照常載入使用者原本的 zsh 設定，最後定義 `claude` 函式自動帶上 `--settings`。
//!
//! Windows 沒有終端機裝置可寫：`hooks.json` 改成直接執行 `argus.exe --hook`（見 [`crate::hook`]），
//! `claude` 函式由 PowerShell 啟動參數定義（見 `pty.rs`）。

// shell 腳本與 zsh 包裝只有 macOS 用得到
#![cfg_attr(windows, allow(dead_code))]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;

/// 分頁裡 shell 需要的整合資訊。
pub struct Integration {
    pub hooks_file: PathBuf,
    pub zsh_dir: PathBuf,
    /// Windows：hook 回報狀態用的 named pipe（見 [`crate::hook`]）
    pub pipe: Option<String>,
}

/// 找出要寫燈號的終端機，兩個 hook 共用（安裝時代入 `__ARGUS_TARGET__`）。
///
/// 寫到 agent 自己所在的終端機：在 Argus 分頁裡就是那個分頁；Claude 轉到背景後
/// 被 `claude attach` 接回時，背景終端機的輸出（含燈號訊號）會轉送到接上的分頁。
/// hook 本身沒有 controlling tty，所以往上找祖先行程；找不到才用啟動時記下的 ARGUS_TTY。
/// `ARGUS_NO_TTY_LOOKUP` 給測試用，避免寫到跑測試的終端機。
const TARGET_LOOKUP: &str = r#"target="$ARGUS_TTY"
if [ -z "$ARGUS_NO_TTY_LOOKUP" ]; then
  pid=$PPID
  n=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$n" -lt 8 ]; do
    t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$t" in
      ""|"?"|"??") ;;
      *) target="/dev/$t"; break ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    n=$((n + 1))
  done
fi"#;

fn with_target_lookup(script: &str) -> String {
    script.replace("__ARGUS_TARGET__", TARGET_LOOKUP)
}

/// 把目標終端機查詢與 Argus 執行檔路徑代入 hook 腳本（沒有執行檔就不送活動摘要）。
fn hook_script_with(script: &str, argus_bin: Option<&Path>) -> String {
    let bin = argus_bin
        .map(|p| shell_quote(&p.to_string_lossy()))
        .unwrap_or_else(|| "''".into());
    with_target_lookup(script).replace("__ARGUS_BIN__", &bin)
}

const HOOK_SCRIPT: &str = r#"#!/bin/sh
# Argus hook：把 Claude Code 狀態寫回所屬分頁（由 Argus 自動產生，請勿手動修改）
state="$1"
payload=$(cat)
[ -n "$ARGUS_TTY" ] || exit 0
if [ "$state" = "notify" ]; then
  case "$payload" in
    *idle_prompt*|*"waiting for your input"*) state="done" ;;
    *) state="needs-input" ;;
  esac
fi
__ARGUS_TARGET__
osc=$(printf '\033]7777;argus;%s\007' "$state")
# 側欄「活動」面板：請 Argus 執行檔把原始資料整理成一行摘要，和燈號一起送
argus_bin=__ARGUS_BIN__
if [ -x "$argus_bin" ]; then
  summary=$(printf '%s' "$payload" | "$argus_bin" --hook-summary 2>/dev/null)
  [ -n "$summary" ] && osc="$osc$(printf '\033]7777;argus-activity;%s\007' "$summary")"
fi
# 寫入最多等 1 秒：終端機卡住時放棄這次燈號，不拖住 Claude（hook 跑完 Claude 才會繼續）
printf '%s' "$osc" > "$target" 2>/dev/null &
writer=$!
# 計時器 1 秒後還沒寫完就中止；輸出導向 /dev/null，Claude 才不會等它的 stdout
( sleep 1; kill "$writer" 2>/dev/null ) > /dev/null 2>&1 &
watchdog=$!
wait "$writer"
kill "$watchdog" 2>/dev/null
exit 0
"#;

/// agy（Antigravity CLI）的狀態回報外掛，放在 `~/.gemini/config/plugins/argus/`。
/// agy 沒有「等待確認」事件，只回報 待命／執行中／完成。hook 必須在 stdout 回 JSON。
const AGY_PLUGIN_JSON: &str = r#"{
  "name": "argus",
  "author": "Argus"
}
"#;

const AGY_HOOK_SCRIPT: &str = r#"#!/bin/sh
# Argus：把 agy 狀態與活動摘要寫回所屬分頁（由 Argus 自動產生，請勿手動修改）
# 不在 Argus 裡（沒有 ARGUS_TTY）時什麼都不做。
payload=$(cat)
if [ -n "$ARGUS_TTY" ]; then
__ARGUS_TARGET__
  osc=$(printf '\033]7777;argus;%s;agy\007' "$1")
  # 側欄「活動」面板：請 Argus 執行檔把原始資料整理成一行摘要，和燈號一起送
  argus_bin=__ARGUS_BIN__
  if [ -x "$argus_bin" ]; then
    summary=$(printf '%s' "$payload" | "$argus_bin" --hook-summary 2>/dev/null)
    [ -n "$summary" ] && osc="$osc$(printf '\033]7777;argus-activity;%s\007' "$summary")"
  fi
  # 寫入最多等 1 秒，終端機卡住時不拖住 agy
  printf '%s' "$osc" > "$target" 2>/dev/null &
  writer=$!
  ( sleep 1; kill "$writer" 2>/dev/null ) > /dev/null 2>&1 &
  watchdog=$!
  wait "$writer"
  kill "$watchdog" 2>/dev/null
fi
echo '{}'
"#;

/// agy 外掛的 hooks 設定，`command` 是每個狀態要執行的指令。
/// 不註冊 PreToolUse：它的回傳值會影響 agy 的權限判斷。
fn agy_hooks_json(command: impl Fn(&str) -> String) -> String {
    let hook = |state: &str| json!({ "type": "command", "command": command(state), "timeout": 5 });
    let spec = json!({
        "argus-status": {
            "SessionStart": [hook("idle")],
            "PreInvocation": [hook("running")],
            "PostToolUse": [{ "matcher": "*", "hooks": [hook("running")] }],
            "Stop": [hook("done")],
        }
    });
    serde_json::to_string_pretty(&spec).unwrap_or_default()
}

/// 只有已經裝了 agy（有 `~/.gemini/config`）才安裝，回傳是否有安裝。
#[cfg(test)]
pub fn install_agy_plugin(gemini_config: &Path) -> io::Result<bool> {
    install_agy_plugin_with_bin(gemini_config, None)
}

pub fn install_agy_plugin_with_bin(
    gemini_config: &Path,
    argus_bin: Option<&Path>,
) -> io::Result<bool> {
    if !gemini_config.is_dir() {
        return Ok(false);
    }
    let plugins = gemini_config.join("plugins");
    let dir = plugins.join("argus");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("plugin.json"), AGY_PLUGIN_JSON)?;
    fs::write(
        dir.join("hooks.json"),
        agy_hooks_json(|state| format!("sh ./argus-hook.sh {state}")),
    )?;
    fs::write(
        dir.join("argus-hook.sh"),
        hook_script_with(AGY_HOOK_SCRIPT, argus_bin),
    )?;
    Ok(true)
}

/// Windows：agy 外掛直接呼叫 `argus.exe --hook <狀態> agy`（印出 agy 要的 `{}`）。
/// agy 用哪個 shell 執行指令沒有文件，`exe` 要在 cmd 與 PowerShell 都能用（見 [`portable_exe`]）。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn install_agy_plugin_exe(gemini_config: &Path, exe: &str) -> io::Result<bool> {
    if !gemini_config.is_dir() {
        return Ok(false);
    }
    let dir = gemini_config.join("plugins").join("argus");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("plugin.json"), AGY_PLUGIN_JSON)?;
    fs::write(
        dir.join("hooks.json"),
        agy_hooks_json(|state| format!("{exe} --hook {state} agy")),
    )?;
    // 舊版留下的 sh 腳本 Windows 用不到
    let _ = fs::remove_file(dir.join("argus-hook.sh"));
    Ok(true)
}

/// 執行檔路徑寫成 cmd 與 PowerShell 都看得懂的樣子：反斜線（cmd 會把 `/` 當成參數開關）、
/// 不加引號（PowerShell 要 `&` 才會執行加了引號的路徑）。呼叫端先換成 8.3 短檔名去掉空白；
/// 還有空白或 shell 特殊字元（`&`、`(`、`%`…）時只能加雙引號（cmd 可以，PowerShell 不行）。
/// Git Bash 會吃掉反斜線，不支援。
#[cfg_attr(not(windows), allow(dead_code))]
fn portable_exe(path: &str) -> String {
    let safe = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '\\' | ':' | '.' | '_' | '-' | '~'));
    if safe {
        path.to_string()
    } else {
        format!("\"{path}\"")
    }
}

/// 使用者原本的 zsh 啟動檔照順序載入；ZDOTDIR 可能在 .zshenv 裡被改，所以每次都更新。
fn zsh_passthrough(file: &str) -> String {
    format!(
        r#"# Argus shell integration（自動產生）
ZDOTDIR="$_argus_user_zdotdir"
[[ -f "$ZDOTDIR/{file}" ]] && source "$ZDOTDIR/{file}"
_argus_user_zdotdir="$ZDOTDIR"
ZDOTDIR="$_argus_zdotdir"
"#
    )
}

fn zsh_files() -> Vec<(&'static str, String)> {
    let zshenv = r#"# Argus shell integration（自動產生）
_argus_zdotdir="$ZDOTDIR"
_argus_user_zdotdir="${ARGUS_USER_ZDOTDIR:-$HOME}"
ZDOTDIR="$_argus_user_zdotdir"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
_argus_user_zdotdir="$ZDOTDIR"
ZDOTDIR="$_argus_zdotdir"
"#
    .to_string();

    let zshrc = format!(
        r#"{}
# 在 Argus 裡執行 claude 時自動帶上狀態回報 hooks
# 使用者若有 alias claude=…，`claude()` 會被 alias 展開而定義失敗，hook 就默默沒套上
unalias claude 2>/dev/null
function claude {{ command claude --settings "$ARGUS_HOOKS" "$@"; }}
"#,
        zsh_passthrough(".zshrc")
    );

    // .zlogin 是 login shell 最後讀的檔，在這裡把 ZDOTDIR 還給使用者
    let zlogin = format!(
        r#"{}
if [[ -n "$ARGUS_USER_ZDOTDIR" || "$_argus_user_zdotdir" != "$HOME" ]]; then
  ZDOTDIR="$_argus_user_zdotdir"
else
  unset ZDOTDIR
fi
unset _argus_zdotdir _argus_user_zdotdir ARGUS_USER_ZDOTDIR
"#,
        zsh_passthrough(".zlogin")
    );

    vec![
        (".zshenv", zshenv),
        (".zprofile", zsh_passthrough(".zprofile")),
        (".zshrc", zshrc),
        (".zlogin", zlogin),
    ]
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub fn hooks_settings(hook_script: &Path) -> serde_json::Value {
    let hook = |state: &str| {
        json!([{
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": format!("sh {} {state}", shell_quote(&hook_script.to_string_lossy())),
            }],
        }])
    };
    json!({
        "hooks": {
            "SessionStart": hook("idle"),
            "UserPromptSubmit": hook("running"),
            "PreToolUse": hook("running"),
            "PostToolUse": hook("running"),
            "PostToolUseFailure": hook("running"),
            "Notification": hook("notify"),
            "Stop": hook("done"),
            "SessionEnd": hook("off"),
        }
    })
}

/// Windows 的 Claude hooks：exec 形式（有 `args`）直接啟動 argus.exe，不經 shell，
/// 路徑有空白或特殊字元都不用處理引號。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn exec_hooks_settings(argus_exe: &Path) -> serde_json::Value {
    let exe = argus_exe.to_string_lossy();
    let hook = |state: &str| {
        json!([{
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": exe,
                "args": ["--hook", state],
            }],
        }])
    };
    json!({
        "hooks": {
            "SessionStart": hook("idle"),
            "UserPromptSubmit": hook("running"),
            "PreToolUse": hook("running"),
            "PostToolUse": hook("running"),
            "PostToolUseFailure": hook("running"),
            "Notification": hook("notify"),
            "Stop": hook("done"),
            "SessionEnd": hook("off"),
        }
    })
}

/// 把整合檔案寫到 `dir`（每次啟動覆寫，確保跟目前版本一致）。
#[cfg(test)]
pub fn install_to(dir: &Path) -> io::Result<Integration> {
    install_with_bin(dir, None)
}

/// `argus_bin` 是 Argus 自己的執行檔，hook 用它整理活動摘要（`--hook-summary`）。
pub fn install_with_bin(dir: &Path, argus_bin: Option<&Path>) -> io::Result<Integration> {
    let zsh_dir = dir.join("zsh");
    fs::create_dir_all(&zsh_dir)?;

    let hook_script = dir.join("hook.sh");
    fs::write(&hook_script, hook_script_with(HOOK_SCRIPT, argus_bin))?;

    let hooks_file = dir.join("hooks.json");
    fs::write(
        &hooks_file,
        serde_json::to_string_pretty(&hooks_settings(&hook_script))?,
    )?;

    for (name, content) in zsh_files() {
        fs::write(zsh_dir.join(name), content)?;
    }
    Ok(Integration {
        hooks_file,
        zsh_dir,
        pipe: None,
    })
}

/// Windows：hooks.json 指向 argus.exe，agy 外掛也改呼叫 argus.exe。
#[cfg(windows)]
pub fn install(pipe: String) -> io::Result<Integration> {
    let home =
        dirs::home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "找不到家目錄"))?;
    // 很長的路徑可能帶 `\\?\` 前綴，寫進設定檔前去掉
    let exe = dunce::simplified(&std::env::current_exe()?).to_path_buf();
    let dir = home.join(".argus");
    fs::create_dir_all(&dir)?;
    let short = crate::sys::short_path(&exe);
    if let Err(e) = install_agy_plugin_exe(
        &home.join(".gemini").join("config"),
        &portable_exe(&short.to_string_lossy()),
    ) {
        eprintln!("agy 狀態外掛安裝失敗：{e}");
    }
    let hooks_file = dir.join("hooks.json");
    fs::write(
        &hooks_file,
        serde_json::to_string_pretty(&exec_hooks_settings(&exe))?,
    )?;
    Ok(Integration {
        hooks_file,
        zsh_dir: dir.join("zsh"),
        pipe: Some(pipe),
    })
}

#[cfg(not(windows))]
pub fn install() -> io::Result<Integration> {
    let home =
        dirs::home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "找不到家目錄"))?;
    let exe = std::env::current_exe().ok();
    if let Err(e) =
        install_agy_plugin_with_bin(&home.join(".gemini").join("config"), exe.as_deref())
    {
        eprintln!("agy 狀態外掛安裝失敗：{e}");
    }
    install_with_bin(&home.join(".argus"), exe.as_deref())
}

#[cfg(test)]
mod portable_tests {
    use super::*;

    #[test]
    fn exec_hooks_pass_the_path_untouched() {
        let settings = exec_hooks_settings(Path::new(r"C:\Program Files\Argus\argus.exe"));
        let hook = &settings["hooks"]["Notification"][0]["hooks"][0];
        assert_eq!(hook["command"], r"C:\Program Files\Argus\argus.exe");
        assert_eq!(hook["args"], json!(["--hook", "notify"]));
        assert_eq!(settings["hooks"].as_object().unwrap().len(), 8);
    }

    #[test]
    fn portable_exe_is_bare_only_when_every_character_is_safe() {
        assert_eq!(
            portable_exe(r"C:\Users\ARGUS~1\AppData\Local\Argus\argus.exe"),
            r"C:\Users\ARGUS~1\AppData\Local\Argus\argus.exe"
        );
        for odd in [
            r"C:\My Apps\argus.exe",
            r"D:\A&B\argus.exe",
            r"D:\x(1)\argus.exe",
        ] {
            assert_eq!(portable_exe(odd), format!("\"{odd}\""));
        }
    }

    #[test]
    fn windows_agy_plugin_calls_the_exe() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        assert!(!install_agy_plugin_exe(&config, r"C:\a\argus.exe").unwrap());
        fs::create_dir_all(config.join("plugins/argus")).unwrap();
        fs::write(config.join("plugins/argus/argus-hook.sh"), "old").unwrap();
        assert!(install_agy_plugin_exe(&config, r"C:\a\argus.exe").unwrap());
        let plugin = config.join("plugins/argus");
        let hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap();
        assert_eq!(
            hooks["argus-status"]["Stop"][0]["command"],
            r"C:\a\argus.exe --hook done agy"
        );
        assert_eq!(
            hooks["argus-status"]["PostToolUse"][0]["hooks"][0]["command"],
            r"C:\a\argus.exe --hook running agy"
        );
        assert!(!plugin.join("argus-hook.sh").exists());
    }
}

// hook 是 POSIX shell 腳本（Windows 走 argus.exe，見 portable_tests 與 hook.rs）
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::Command;
    use std::time::Duration;

    /// 讀終端機輸出直到看到 `marker`。看到後背景執行緒仍繼續讀到結束：
    /// macOS 上終端機還有沒讀的輸出時，子行程關閉終端機會一直等，測試就卡住。
    fn read_until(
        mut reader: Box<dyn Read + Send>,
        marker: &'static [u8],
        limit: Duration,
    ) -> Option<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            let mut sent = false;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if !sent {
                    out.extend_from_slice(&buf[..n]);
                    if out.windows(marker.len()).any(|w| w == marker) {
                        let _ = tx.send(std::mem::take(&mut out));
                        sent = true;
                    }
                }
            }
            if !sent {
                let _ = tx.send(out);
            }
        });
        rx.recv_timeout(limit)
            .ok()
            .filter(|out| out.windows(marker.len()).any(|w| w == marker))
    }

    /// 等子行程結束，最多等 `limit`，逾時就結束它，測試不會永遠卡住。
    fn wait_or_kill(child: &mut dyn portable_pty::Child, limit: Duration) {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn hooks_cover_every_status_event() {
        let settings = hooks_settings(Path::new("/x/it's/hook.sh"));
        let hooks = settings["hooks"].as_object().unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "Notification",
            "Stop",
            "SessionEnd",
        ] {
            assert!(hooks.contains_key(event), "missing {event}");
        }
        let cmd = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(cmd, r"sh '/x/it'\''s/hook.sh' done");
    }

    fn run_hook(dir: &Path, state: &str, payload: &str) -> String {
        let tty = dir.join("fake-tty");
        fs::write(&tty, "").unwrap();
        let mut child = Command::new("sh")
            .arg(dir.join("hook.sh"))
            .arg(state)
            .env("ARGUS_TTY", &tty)
            .env("ARGUS_NO_TTY_LOOKUP", "1")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        fs::read_to_string(tty).unwrap()
    }

    #[test]
    fn hook_script_writes_osc_and_classifies_notifications() {
        let dir = tempfile::tempdir().unwrap();
        install_to(dir.path()).unwrap();
        assert_eq!(
            run_hook(dir.path(), "running", "{}"),
            "\x1b]7777;argus;running\x07"
        );
        assert_eq!(
            run_hook(
                dir.path(),
                "notify",
                r#"{"notification_type":"permission_prompt"}"#
            ),
            "\x1b]7777;argus;needs-input\x07"
        );
        assert_eq!(
            run_hook(
                dir.path(),
                "notify",
                r#"{"notification_type":"idle_prompt"}"#
            ),
            "\x1b]7777;argus;done\x07"
        );
    }

    /// 寫入卡住時（這裡用沒有讀取端的 FIFO，開檔會一直等），hook 要在時限內結束，不能拖住 agent。
    fn assert_returns_quickly_when_tty_blocks(script: &Path, extra_args: &[&str]) {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("stuck-tty");
        assert!(
            Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let start = std::time::Instant::now();
        let mut child = Command::new("sh")
            .arg(script)
            .args(extra_args)
            .env("ARGUS_TTY", &fifo)
            .env("ARGUS_NO_TTY_LOOKUP", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        while child.try_wait().unwrap().is_none() {
            if start.elapsed() > std::time::Duration::from_secs(5) {
                child.kill().unwrap();
                panic!("hook 被卡住的寫入拖住超過 5 秒");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn hook_does_not_hang_when_tty_write_blocks() {
        let dir = tempfile::tempdir().unwrap();
        install_to(dir.path()).unwrap();
        assert_returns_quickly_when_tty_blocks(&dir.path().join("hook.sh"), &["running"]);

        let config = dir.path().join("config");
        fs::create_dir_all(&config).unwrap();
        install_agy_plugin(&config).unwrap();
        assert_returns_quickly_when_tty_blocks(
            &config.join("plugins/argus/argus-hook.sh"),
            &["running"],
        );
    }

    /// 在真的終端機（PTY）裡跑 hook：燈號要寫到 agent 所在的終端機，而不是 ARGUS_TTY。
    /// 背景對話被 `claude attach` 接回時，就是靠這個讓訊號轉送到接上的分頁。
    #[test]
    fn hook_writes_to_the_agents_own_terminal() {
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};

        let dir = tempfile::tempdir().unwrap();
        install_to(dir.path()).unwrap();
        let stale = dir.path().join("stale-tty");
        fs::write(&stale, "").unwrap();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("sh");
        let hook = dir.path().join("hook.sh");
        cmd.args([
            "-c",
            &format!("echo '{{}}' | sh '{}' running", hook.display()),
        ]);
        cmd.env("ARGUS_TTY", &stale);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().unwrap();
        let out =
            read_until(reader, b"7777", Duration::from_secs(5)).expect("終端機沒收到燈號訊號");
        wait_or_kill(&mut *child, Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&out).contains("\x1b]7777;argus;running\x07"),
            "{out:?}"
        );
        assert_eq!(fs::read_to_string(&stale).unwrap(), "", "不該寫到舊的分頁");
    }

    /// 給了 Argus 執行檔時，hook 會把它的摘要接在燈號後面送出。
    #[test]
    fn hook_appends_the_activity_summary() {
        let dir = tempfile::tempdir().unwrap();
        // 假的 Argus 執行檔：收到 --hook-summary 就印一行固定的摘要
        let fake_bin = dir.path().join("argus");
        fs::write(
            &fake_bin,
            "#!/bin/sh\ncat > /dev/null\necho '{\"k\":\"stop\"}'\n",
        )
        .unwrap();
        fs::set_permissions(
            &fake_bin,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        install_with_bin(dir.path(), Some(&fake_bin)).unwrap();
        assert_eq!(
            run_hook(dir.path(), "done", "{}"),
            "\x1b]7777;argus;done\x07\x1b]7777;argus-activity;{\"k\":\"stop\"}\x07"
        );

        let config = dir.path().join("config");
        fs::create_dir_all(&config).unwrap();
        install_agy_plugin_with_bin(&config, Some(&fake_bin)).unwrap();
        let tty = dir.path().join("agy-tty");
        fs::write(&tty, "").unwrap();
        let out = Command::new("sh")
            .arg(config.join("plugins/argus/argus-hook.sh"))
            .arg("running")
            .env("ARGUS_TTY", &tty)
            .env("ARGUS_NO_TTY_LOOKUP", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "{}");
        assert_eq!(
            fs::read_to_string(&tty).unwrap(),
            "\x1b]7777;argus;running;agy\x07\x1b]7777;argus-activity;{\"k\":\"stop\"}\x07"
        );
    }

    #[test]
    fn hook_is_silent_outside_argus() {
        let dir = tempfile::tempdir().unwrap();
        install_to(dir.path()).unwrap();
        let status = Command::new("sh")
            .arg(dir.path().join("hook.sh"))
            .arg("running")
            .env_remove("ARGUS_TTY")
            .stdin(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// 用真的 zsh 驗證：使用者原本的 .zshrc 有載入、claude 函式有定義、ZDOTDIR 最後還原。
    #[test]
    fn zsh_wrapper_sources_user_config_and_defines_claude() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let integration = install_to(&dir.path().join("argus")).unwrap();
        let user_home = dir.path().join("home");
        fs::create_dir_all(&user_home).unwrap();
        // 使用者自己的 alias 不能擋掉 Argus 的 claude 函式
        fs::write(
            user_home.join(".zshrc"),
            "export FROM_USER_RC=yes\nalias claude='echo from-alias'\n",
        )
        .unwrap();

        let out = Command::new("/bin/zsh")
            .args(["-l", "-i", "-c"])
            .arg(r#"print -r -- "$FROM_USER_RC|$(whence -w claude)|${ZDOTDIR-unset}""#)
            .env_clear()
            .env("HOME", &user_home)
            .env("ZDOTDIR", &integration.zsh_dir)
            .env("ARGUS_HOOKS", &integration.hooks_file)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(stdout.trim(), "yes|claude: function|unset", "{stdout}");
    }

    #[test]
    fn agy_plugin_only_installs_when_agy_present() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        assert!(!install_agy_plugin(&config).unwrap());
        assert!(!config.exists());

        fs::create_dir_all(&config).unwrap();
        assert!(install_agy_plugin(&config).unwrap());
        let plugin = config.join("plugins/argus");
        let hooks: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(plugin.join("hooks.json")).unwrap()).unwrap();
        let spec = &hooks["argus-status"];
        for event in ["SessionStart", "PreInvocation", "PostToolUse", "Stop"] {
            assert!(spec.get(event).is_some(), "missing {event}");
        }
        assert!(spec.get("PreToolUse").is_none());
        serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(plugin.join("plugin.json")).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn agy_hook_writes_osc_and_always_answers_json() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        fs::create_dir_all(&config).unwrap();
        install_agy_plugin(&config).unwrap();
        let script = config.join("plugins/argus/argus-hook.sh");
        let tty = dir.path().join("tty");
        fs::write(&tty, "").unwrap();

        let out = Command::new("sh")
            .arg(&script)
            .arg("running")
            .env("ARGUS_TTY", &tty)
            .env("ARGUS_NO_TTY_LOOKUP", "1")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "{}");
        assert_eq!(
            fs::read_to_string(&tty).unwrap(),
            "\x1b]7777;argus;running;agy\x07"
        );

        let outside = Command::new("sh")
            .arg(&script)
            .arg("done")
            .env_remove("ARGUS_TTY")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&outside.stdout).trim(), "{}");
    }

    /// 看到訊號後不再讀、子行程又多印了東西時，macOS 會卡在等子行程結束（CI 曾卡 50 分鐘）。
    #[test]
    fn reading_continues_after_the_marker_so_the_child_can_exit() {
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("sh");
        cmd.args([
            "-c",
            "printf 7777; sleep 0.3; printf 'more output after the marker'",
        ]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().unwrap();
        assert!(read_until(reader, b"7777", Duration::from_secs(5)).is_some());
        let start = std::time::Instant::now();
        wait_or_kill(&mut *child, Duration::from_secs(5));
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "子行程沒有自己結束"
        );
    }
}
