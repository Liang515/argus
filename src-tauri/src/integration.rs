//! Claude Code 狀態回報整合。
//!
//! Argus 啟動時把以下檔案寫進 `~/.argus/`，不動使用者自己的設定：
//! - `hook.sh`：Claude Code hook，把狀態以 OSC 7777 寫進該分頁的終端機裝置（`$ARGUS_TTY`）。
//!   hook 子行程沒有 controlling tty，所以不能寫 `/dev/tty`，改用 PTY 啟動時記下的裝置路徑。
//! - `hooks.json`：給 `claude --settings` 用的 hooks 設定，只在 Argus 裡生效。
//! - `zsh/`：ZDOTDIR 包裝，照常載入使用者原本的 zsh 設定，最後定義 `claude` 函式自動帶上 `--settings`。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;

/// 分頁裡 shell 需要的整合資訊。
pub struct Integration {
    pub hooks_file: PathBuf,
    pub zsh_dir: PathBuf,
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
# 寫入最多等 1 秒：終端機卡住時放棄這次燈號，不拖住 Claude（hook 跑完 Claude 才會繼續）
printf '\033]7777;argus;%s\007' "$state" > "$target" 2>/dev/null &
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
# Argus：把 agy 狀態寫回所屬分頁（由 Argus 自動產生，請勿手動修改）
# 不在 Argus 裡（沒有 ARGUS_TTY）時什麼都不做。
cat > /dev/null
if [ -n "$ARGUS_TTY" ]; then
__ARGUS_TARGET__
  # 寫入最多等 1 秒，終端機卡住時不拖住 agy
  printf '\033]7777;argus;%s;agy\007' "$1" > "$target" 2>/dev/null &
  writer=$!
  ( sleep 1; kill "$writer" 2>/dev/null ) > /dev/null 2>&1 &
  watchdog=$!
  wait "$writer"
  kill "$watchdog" 2>/dev/null
fi
echo '{}'
"#;

/// 不註冊 PreToolUse：它的回傳值會影響 agy 的權限判斷。
const AGY_HOOKS_JSON: &str = r#"{
  "argus-status": {
    "SessionStart": [{ "type": "command", "command": "sh ./argus-hook.sh idle", "timeout": 5 }],
    "PreInvocation": [{ "type": "command", "command": "sh ./argus-hook.sh running", "timeout": 5 }],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "sh ./argus-hook.sh running", "timeout": 5 }] }
    ],
    "Stop": [{ "type": "command", "command": "sh ./argus-hook.sh done", "timeout": 5 }]
  }
}
"#;

/// 只有已經裝了 agy（有 `~/.gemini/config`）才安裝，回傳是否有安裝。
pub fn install_agy_plugin(gemini_config: &Path) -> io::Result<bool> {
    if !gemini_config.is_dir() {
        return Ok(false);
    }
    let plugins = gemini_config.join("plugins");
    let dir = plugins.join("argus");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("plugin.json"), AGY_PLUGIN_JSON)?;
    fs::write(dir.join("hooks.json"), AGY_HOOKS_JSON)?;
    fs::write(
        dir.join("argus-hook.sh"),
        with_target_lookup(AGY_HOOK_SCRIPT),
    )?;
    Ok(true)
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
            "Notification": hook("notify"),
            "Stop": hook("done"),
            "SessionEnd": hook("off"),
        }
    })
}

/// 把整合檔案寫到 `dir`（每次啟動覆寫，確保跟目前版本一致）。
pub fn install_to(dir: &Path) -> io::Result<Integration> {
    let zsh_dir = dir.join("zsh");
    fs::create_dir_all(&zsh_dir)?;

    let hook_script = dir.join("hook.sh");
    fs::write(&hook_script, with_target_lookup(HOOK_SCRIPT))?;

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
    })
}

pub fn install() -> io::Result<Integration> {
    let home =
        dirs::home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "找不到家目錄"))?;
    if let Err(e) = install_agy_plugin(&home.join(".gemini").join("config")) {
        eprintln!("agy 狀態外掛安裝失敗：{e}");
    }
    install_to(&home.join(".argus"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn hooks_cover_every_status_event() {
        let settings = hooks_settings(Path::new("/x/it's/hook.sh"));
        let hooks = settings["hooks"].as_object().unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
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
        use std::io::Read;

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
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
                if out.windows(4).any(|w| w == b"7777") {
                    break;
                }
            }
            let _ = tx.send(out);
        });
        let out = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("終端機沒收到燈號訊號");
        let _ = child.wait();
        assert!(
            String::from_utf8_lossy(&out).contains("\x1b]7777;argus;running\x07"),
            "{out:?}"
        );
        assert_eq!(fs::read_to_string(&stale).unwrap(), "", "不該寫到舊的分頁");
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
}
