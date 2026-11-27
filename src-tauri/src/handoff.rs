//! 交接後清除對話，讓新對話自動讀 HANDOFF.md。
//!
//! 使用者交接完按「清除對話」時，前端先呼叫 [`handoff_mark`] 在 `~/.argus/handoff/<分頁 id>`
//! 留一個記號，再送 `/clear`。Claude 清除後觸發 SessionStart（matcher `clear`）hook，
//! 執行 `argus --handoff-context`：同一個分頁有剛留下的記號才請 Claude 先讀 HANDOFF.md，
//! 讀完就刪掉記號。平常按「新對話」或自己打 `/clear` 沒有記號，什麼都不加。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::hook::TAB_ENV;

/// 記號留太久（例如按了清除但 `/clear` 沒送出去）就不算數，免得之後隨便一次清除被當成交接。
const MARK_TTL: Duration = Duration::from_secs(120);

/// 給新對話的說明：只請它先讀，不把整份檔案塞進來（HANDOFF.md 可能很長，標題寫法也因人而異）。
const CONTEXT: &str = "This conversation was started right after a handoff (the user cleared the previous conversation in Argus). \
Before working on the user's first request, read HANDOFF.md in the project root, focusing on the next steps and any in-progress section, \
and continue from there. Reply in the user's language.";

fn marks_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".argus").join("handoff"))
}

/// 分頁 id 是 Argus 產生的 UUID；只收英數與連字號，不讓它變成任意路徑。
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn mark_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("無效的分頁 id".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(id), "").map_err(|e| e.to_string())
}

/// 取出記號（一定刪掉），回傳它是不是在有效時間內留下的。
fn take_in(dir: &Path, id: &str, now: SystemTime) -> bool {
    if !valid_id(id) {
        return false;
    }
    let path = dir.join(id);
    let Ok(modified) = fs::metadata(&path).and_then(|m| m.modified()) else {
        return false;
    };
    let _ = fs::remove_file(&path);
    now.duration_since(modified)
        .map(|age| age <= MARK_TTL)
        .unwrap_or(true)
}

/// 前端在送 `/clear` 前呼叫：記下這個分頁接下來的清除是交接後的清除。
#[tauri::command]
pub fn handoff_mark(id: String) -> Result<(), String> {
    let dir = marks_dir().ok_or("找不到家目錄")?;
    mark_in(&dir, &id)
}

/// `argus --handoff-context`：SessionStart（clear）hook。有記號就在 stdout 回傳要加進新對話的說明。
pub fn context_main() {
    let id = std::env::var(TAB_ENV).unwrap_or_default();
    let Some(dir) = marks_dir() else { return };
    if take_in(&dir, &id, SystemTime::now()) {
        print!("{}", context_json());
    }
}

fn context_json() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": CONTEXT,
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "27367c82-1620-4c36-a2cb-25ca42997e7f";

    #[test]
    fn mark_is_used_once() {
        let dir = tempfile::tempdir().unwrap();
        mark_in(dir.path(), ID).unwrap();
        assert!(take_in(dir.path(), ID, SystemTime::now()));
        // 讀過就刪掉：之後一般的 /clear 不會再觸發
        assert!(!take_in(dir.path(), ID, SystemTime::now()));
        assert!(!dir.path().join(ID).exists());
    }

    #[test]
    fn other_tabs_and_missing_marks_do_nothing() {
        let dir = tempfile::tempdir().unwrap();
        mark_in(dir.path(), ID).unwrap();
        assert!(!take_in(dir.path(), "other-tab", SystemTime::now()));
        assert!(!take_in(dir.path(), "", SystemTime::now()));
        assert!(dir.path().join(ID).exists());
    }

    #[test]
    fn stale_marks_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        mark_in(dir.path(), ID).unwrap();
        let later = SystemTime::now() + MARK_TTL + Duration::from_secs(1);
        assert!(!take_in(dir.path(), ID, later));
        assert!(!dir.path().join(ID).exists());
    }

    #[test]
    fn ids_cannot_escape_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../x", "a/b", "..", r"a\b", ""] {
            assert!(mark_in(dir.path(), bad).is_err(), "{bad}");
            assert!(!take_in(dir.path(), bad, SystemTime::now()), "{bad}");
        }
    }

    #[test]
    fn context_is_session_start_json() {
        let v: serde_json::Value = serde_json::from_str(&context_json()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert!(
            v["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap()
                .contains("HANDOFF.md")
        );
    }
}
