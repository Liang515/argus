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

/// 程式碼與文字檔：有裝 VS Code／Antigravity 時用它打開（還能跳到行號），不交給系統預設 App。
const TEXT_EXTENSIONS: [&str; 52] = [
    "md", "markdown", "mdx", "txt", "rst", "adoc", "json", "jsonc", "json5", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "env", "xml", "csv", "tsv", "log", "ts", "tsx", "js", "jsx", "mjs",
    "cjs", "rs", "go", "py", "rb", "php", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
    "cs", "css", "scss", "html", "vue", "svelte", "sql", "lua", "sh", "zsh", "bash", "fish",
    "lock",
];

/// 沒有副檔名但通常是文字的檔名。
const TEXT_FILE_NAMES: [&str; 8] = [
    "Makefile",
    "Dockerfile",
    "LICENSE",
    "README",
    "Gemfile",
    "Procfile",
    ".gitignore",
    ".editorconfig",
];

pub fn is_text_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    TEXT_FILE_NAMES.contains(&name)
        || name.starts_with(".env")
        || path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// 依序偏好的編輯器：(bundle id, 預設安裝名稱, 網址 scheme)
const EDITORS: [(&str, &str, &str); 2] = [
    ("com.microsoft.VSCode", "Visual Studio Code.app", "vscode"),
    (
        "com.google.antigravity-ide",
        "Antigravity IDE.app",
        "antigravity-ide",
    ),
];

/// 網址路徑用的百分比編碼：保留英數與 `/-._~`，其餘（空白、中文等）逐位元組編碼。
fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `vscode://file/<路徑>:<行>:<欄>`；VS Code 系的編輯器都認得，開著或關著都能用。
pub fn editor_url(scheme: &str, path: &str, line: Option<u32>, column: Option<u32>) -> String {
    let mut url = format!("{scheme}://file{}", encode_path(path));
    if let Some(line) = line {
        url.push_str(&format!(":{line}"));
        if let Some(column) = column {
            url.push_str(&format!(":{column}"));
        }
    }
    url
}

#[derive(Debug, PartialEq)]
pub enum OpenAction {
    /// 在 Finder 選取它
    Reveal,
    /// 交給系統預設 App（資料夾開在 Finder）
    OpenDefault,
    /// 用編輯器打開這個網址
    Editor(String),
}

/// ⌘⌥＋點擊 → 在 Finder 顯示；文字檔且有編輯器 → 編輯器（只開不執行，腳本也安全）；
/// 會執行的檔案 → 只在 Finder 顯示；其他 → 系統預設 App。
pub fn decide(
    path: &Path,
    is_dir: bool,
    reveal: bool,
    editor_scheme: Option<&str>,
    line: Option<u32>,
    column: Option<u32>,
) -> OpenAction {
    if reveal {
        return OpenAction::Reveal;
    }
    if !is_dir
        && is_text_file(path)
        && let Some(scheme) = editor_scheme
    {
        return OpenAction::Editor(editor_url(scheme, &path.to_string_lossy(), line, column));
    }
    if is_runnable(path) {
        return OpenAction::Reveal;
    }
    OpenAction::OpenDefault
}

fn installed_editor() -> Option<&'static str> {
    EDITORS
        .iter()
        .find(|(bundle, app, _)| crate::project::app_installed(bundle, app))
        .map(|(_, _, scheme)| *scheme)
}

/// 開啟終端機裡被 ⌘＋點擊的路徑，規則見 [`decide`]。
#[tauri::command]
pub async fn open_path(
    path: String,
    reveal: bool,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let target = Path::new(&path);
    let meta = fs::metadata(target).map_err(|_| "檔案不存在".to_string())?;
    let editor = if !reveal && !meta.is_dir() && is_text_file(target) {
        installed_editor()
    } else {
        None
    };
    let mut cmd = Command::new("/usr/bin/open");
    match decide(target, meta.is_dir(), reveal, editor, line, column) {
        OpenAction::Reveal => cmd.arg("-R").arg(target),
        OpenAction::OpenDefault => cmd.arg(target),
        OpenAction::Editor(url) => cmd.arg(url),
    };
    let status = cmd.status().map_err(|e| e.to_string())?;
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

    #[test]
    fn text_files_go_to_the_editor_with_line_and_column() {
        let p = Path::new("/p/我的 專案/src/App.tsx");
        assert_eq!(
            decide(p, false, false, Some("vscode"), Some(313), Some(5)),
            OpenAction::Editor(
                "vscode://file/p/%E6%88%91%E7%9A%84%20%E5%B0%88%E6%A1%88/src/App.tsx:313:5".into()
            )
        );
        assert_eq!(
            decide(
                Path::new("/p/README.md"),
                false,
                false,
                Some("antigravity-ide"),
                None,
                None
            ),
            OpenAction::Editor("antigravity-ide://file/p/README.md".into())
        );
        assert_eq!(
            decide(
                Path::new("/p/Makefile"),
                false,
                false,
                Some("vscode"),
                Some(3),
                None
            ),
            OpenAction::Editor("vscode://file/p/Makefile:3".into())
        );
    }

    #[test]
    fn falls_back_to_reveal_or_default_app() {
        // 沒有編輯器：文字檔用系統預設 App，腳本只在 Finder 顯示
        assert_eq!(
            decide(Path::new("/p/a.md"), false, false, None, None, None),
            OpenAction::OpenDefault
        );
        assert_eq!(
            decide(Path::new("/p/run.sh"), false, false, None, None, None),
            OpenAction::Reveal
        );
        // 有編輯器時腳本用編輯器打開（只開不執行）
        assert!(matches!(
            decide(
                Path::new("/p/run.sh"),
                false,
                false,
                Some("vscode"),
                None,
                None
            ),
            OpenAction::Editor(_)
        ));
        // 圖片、資料夾、⌘⌥
        assert_eq!(
            decide(
                Path::new("/p/a.png"),
                false,
                false,
                Some("vscode"),
                None,
                None
            ),
            OpenAction::OpenDefault
        );
        assert_eq!(
            decide(Path::new("/p/src"), true, false, Some("vscode"), None, None),
            OpenAction::OpenDefault
        );
        assert_eq!(
            decide(
                Path::new("/p/a.md"),
                false,
                true,
                Some("vscode"),
                None,
                None
            ),
            OpenAction::Reveal
        );
        assert_eq!(
            decide(
                Path::new("/Applications/X.app"),
                true,
                false,
                Some("vscode"),
                None,
                None
            ),
            OpenAction::Reveal
        );
    }
}
