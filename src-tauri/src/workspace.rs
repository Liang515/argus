//! 分頁清單持久化到 `~/.argus/workspaces.json`。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    pub id: String,
    pub path: String,
    /// 這個分頁預設啟動的 agent（claude / agy / codex），沒選過就是 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<TabEntry>,
    pub active_id: Option<String>,
    /// 最近開過的專案路徑（新的在前），給專案切換器用。
    #[serde(default)]
    pub recent: Vec<String>,
}

fn workspace_file() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".argus").join("workspaces.json"))
        .ok_or_else(|| "找不到家目錄".to_string())
}

/// 檔案不存在或內容壞掉時回傳空工作區，不讓 App 開不起來。
pub fn load_from(path: &Path) -> Workspace {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 先寫暫存檔再 rename，寫到一半當掉也不會留下壞檔。
pub fn save_to(path: &Path, ws: &Workspace) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(ws)?)?;
    fs::rename(tmp, path)
}

#[tauri::command]
pub fn workspace_load() -> Result<Workspace, String> {
    Ok(load_from(&workspace_file()?))
}

#[tauri::command]
pub fn workspace_save(workspace: Workspace) -> Result<(), String> {
    save_to(&workspace_file()?, &workspace).map_err(|e| e.to_string())
}

/// 把使用者輸入的路徑（可用 `~`）轉成存在的資料夾絕對路徑，不是資料夾就回傳 None。
pub fn resolve_dir_in(input: &str, home: &Path) -> Option<PathBuf> {
    let input = input.trim();
    let path = if input == "~" {
        home.to_path_buf()
    } else if let Some(rest) = input.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(input)
    };
    if !path.is_absolute() {
        return None;
    }
    let path = path.canonicalize().ok()?;
    path.is_dir().then_some(path)
}

#[tauri::command]
pub fn resolve_dir(path: String) -> Option<String> {
    let home = dirs::home_dir()?;
    resolve_dir_in(&path, &home).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_gives_empty_workspace() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load_from(&dir.path().join("nope.json")),
            Workspace::default()
        );
    }

    #[test]
    fn corrupt_file_gives_empty_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(load_from(&path), Workspace::default());
    }

    #[test]
    fn old_file_without_recent_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w.json");
        fs::write(&path, r#"{"tabs":[{"id":"a","path":"/p"}],"activeId":"a"}"#).unwrap();
        let ws = load_from(&path);
        assert_eq!(ws.tabs.len(), 1);
        assert!(ws.recent.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_creates_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("w.json");
        let ws = Workspace {
            tabs: vec![TabEntry {
                id: "a".into(),
                path: "/tmp/專案".into(),
                agent: Some("agy".into()),
            }],
            active_id: Some("a".into()),
            recent: vec!["/tmp/專案".into()],
        };
        save_to(&path, &ws).unwrap();
        assert_eq!(load_from(&path), ws);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("activeId"));
    }

    #[test]
    fn resolves_tilde_and_rejects_files_and_relative() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        fs::create_dir_all(home.join("proj")).unwrap();
        fs::write(home.join("file.txt"), "").unwrap();
        assert_eq!(resolve_dir_in("~/proj", &home), Some(home.join("proj")));
        assert_eq!(resolve_dir_in(" ~ ", &home), Some(home.clone()));
        let abs = home.join("proj/");
        assert_eq!(
            resolve_dir_in(&abs.to_string_lossy(), &home),
            Some(home.join("proj"))
        );
        assert_eq!(resolve_dir_in("~/file.txt", &home), None);
        assert_eq!(resolve_dir_in("~/missing", &home), None);
        assert_eq!(resolve_dir_in("proj", &home), None);
    }
}
