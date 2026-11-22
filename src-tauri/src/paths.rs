//! 終端機裡的檔案路徑連結：確認路徑存在，⌘＋點擊時開啟或在 Finder 顯示。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// 一行裡最多檢查幾個候選路徑，避免很長的輸出造成大量檔案系統查詢。
const MAX_CANDIDATES: usize = 64;

/// 點了會執行程式的檔案類型：一律改成在 Finder 顯示，不直接打開。
const RUNNABLE_EXTENSIONS: [&str; 16] = [
    "app",
    "command",
    "tool",
    "sh",
    "zsh",
    "bash",
    "pkg",
    "mpkg",
    "workflow",
    "scpt",
    "jar",
    "terminal",
    "fileloc",
    "prefpane",
    "mobileconfig",
    "action",
];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    pub path: String,
    pub is_dir: bool,
}

/// `~/` 換成家目錄，相對路徑接在 `base`（分頁的專案資料夾）後面。
pub fn expand(base: &Path, home: Option<&Path>, raw: &str) -> Option<PathBuf> {
    if raw.is_empty() {
        return None;
    }
    if raw == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.map(|h| h.join(rest));
    }
    let path = Path::new(raw);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

pub fn resolve(base: &Path, home: Option<&Path>, raw: &str) -> Option<ResolvedPath> {
    let path = expand(base, home, raw)?;
    let meta = fs::metadata(&path).ok()?;
    Some(ResolvedPath {
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.is_dir(),
    })
}

/// 依序回傳每個候選路徑解析後的結果；不存在的是 None。
#[tauri::command]
pub fn resolve_paths(base: String, candidates: Vec<String>) -> Vec<Option<ResolvedPath>> {
    let home = dirs::home_dir();
    candidates
        .iter()
        .take(MAX_CANDIDATES)
        .map(|raw| resolve(Path::new(&base), home.as_deref(), raw))
        .collect()
}

/// .app、腳本、安裝檔或可執行檔：打開等於執行，所以只在 Finder 顯示。
pub fn is_runnable(path: &Path) -> bool {
    let by_extension = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    let executable_file = fs::metadata(path).is_ok_and(|m| {
        m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0
    });
    by_extension || executable_file
}

/// 開啟檔案或資料夾（資料夾開在 Finder），`reveal` 或可執行的檔案則在 Finder 選取它。
#[tauri::command]
pub fn open_path(path: String, reveal: bool) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("檔案不存在".into());
    }
    let mut cmd = Command::new("/usr/bin/open");
    if reveal || is_runnable(target) {
        cmd.arg("-R");
    }
    let status = cmd.arg(target).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("無法開啟".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_relative_and_absolute_paths() {
        let base = Path::new("/proj");
        let home = Some(Path::new("/home/me"));
        assert_eq!(
            expand(base, home, "~/x.md"),
            Some(PathBuf::from("/home/me/x.md"))
        );
        assert_eq!(expand(base, home, "~"), Some(PathBuf::from("/home/me")));
        assert_eq!(
            expand(base, home, "src/a.ts"),
            Some(PathBuf::from("/proj/src/a.ts"))
        );
        assert_eq!(
            expand(base, home, "/etc/hosts"),
            Some(PathBuf::from("/etc/hosts"))
        );
        assert_eq!(expand(base, None, "~/x"), None);
        assert_eq!(expand(base, home, ""), None);
    }

    #[test]
    fn resolves_only_existing_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/a.ts"), "").unwrap();
        let base = dir.path().to_string_lossy().into_owned();
        let out = resolve_paths(
            base,
            vec!["src/a.ts".into(), "src".into(), "nope.md".into()],
        );
        assert_eq!(
            out[0],
            Some(ResolvedPath {
                path: dir.path().join("src/a.ts").to_string_lossy().into_owned(),
                is_dir: false
            })
        );
        assert!(out[1].as_ref().unwrap().is_dir);
        assert_eq!(out[2], None);
    }

    #[test]
    fn apps_scripts_and_executables_are_only_revealed() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        fs::write(&note, "").unwrap();
        assert!(!is_runnable(&note));

        let script = dir.path().join("run");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(is_runnable(&script));

        assert!(is_runnable(Path::new("/Applications/Safari.app")));
        assert!(is_runnable(Path::new("/tmp/Install.PKG")));
        assert!(is_runnable(Path::new("/tmp/deploy.sh")));
        assert!(is_runnable(Path::new("/tmp/evil.terminal")));
        assert!(is_runnable(Path::new("/tmp/Profile.mobileconfig")));
    }
}
