//! 自訂啟動指令：`~/.argus/agents.json`。內容由前端解析與檢查（`src/lib/customAgents.ts`）。

use std::fs;
use std::path::{Path, PathBuf};

/// 比這大的檔案不讀，正常只有幾行。
const MAX_FILE: u64 = 64 * 1024;

const EXAMPLES: &str = r#"[
    {
      "name": "Claude (local Ollama)",
      "command": "ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama claude --model qwen3-coder"
    },
    {
      "name": "Codex (local)",
      "command": "codex --oss"
    }
  ]"#;

/// 第一次編輯時建立的範本，說明依介面語言；`help`、`example` 不會被讀，搬到 `agents` 才會出現在選單。
fn template(lang: &str) -> String {
    let help = if lang.starts_with("zh") {
        "把 example 裡的項目搬到 agents 才會出現在 Argus 的 agent 選單。也可以請你的 agent 幫你改這個檔案。"
    } else {
        "Move entries from example into agents to show them in Argus's agent menu. You can also ask your agent to edit this file for you."
    };
    format!("{{\n  \"help\": \"{help}\",\n\n  \"agents\": [],\n\n  \"example\": {EXAMPLES}\n}}\n")
}

fn file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".argus").join("agents.json"))
}

fn read_from(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// 沒有檔案就建立範本；已經有的不動。
fn ensure_template(path: &Path, lang: &str) -> std::io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, template(lang))
}

/// 自訂指令檔的內容；沒有檔案或太大時是 None。
#[tauri::command]
pub fn read_custom_agents() -> Option<String> {
    read_from(&file()?)
}

/// 用預設的文字編輯器打開自訂指令檔，第一次會先建立範本。
#[tauri::command]
pub fn edit_custom_agents(lang: Option<String>) -> Result<(), String> {
    let path = file().ok_or("open_failed")?;
    ensure_template(&path, lang.as_deref().unwrap_or("en"))
        .map_err(|e| format!("write_custom_agents: {e}"))?;
    // macOS：預設文字編輯器（-t）；Windows：記事本（.json 可能沒有預設 App，或被設成瀏覽器）
    let ok = if cfg!(target_os = "macos") {
        crate::sys::command("/usr/bin/open")
            .arg("-t")
            .arg(&path)
            .status()
            .is_ok_and(|s| s.success())
    } else {
        crate::sys::command("notepad.exe")
            .arg(&path)
            .spawn()
            .is_ok()
    };
    if ok {
        Ok(())
    } else {
        Err("open_failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_is_created_once_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("agents.json");
        ensure_template(&path, "en").unwrap();
        assert_eq!(read_from(&path), Some(template("en")));
        fs::write(&path, "{\"agents\":[]}").unwrap();
        ensure_template(&path, "zh").unwrap();
        assert_eq!(read_from(&path).as_deref(), Some("{\"agents\":[]}"));
    }

    #[test]
    fn template_is_valid_json_with_a_note_in_the_users_language() {
        for (lang, word) in [("zh", "搬到"), ("en", "Move")] {
            let value: serde_json::Value = serde_json::from_str(&template(lang)).unwrap();
            assert_eq!(value["agents"], serde_json::json!([]));
            assert_eq!(value["example"].as_array().map(Vec::len), Some(2));
            assert!(value["help"].as_str().unwrap().contains(word), "{lang}");
        }
    }

    #[test]
    fn missing_or_huge_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_from(&dir.path().join("none.json")), None);
        let big = dir.path().join("big.json");
        fs::write(&big, vec![b' '; (MAX_FILE + 1) as usize]).unwrap();
        assert_eq!(read_from(&big), None);
    }
}
