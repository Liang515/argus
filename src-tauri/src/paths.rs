//! 終端機裡的檔案路徑連結：確認路徑存在，⌘＋點擊（Windows：Ctrl＋點擊）時開啟或在 Finder／檔案總管顯示。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::editors::{self, Editor};

/// 一行裡最多檢查幾個候選路徑，避免很長的輸出造成大量檔案系統查詢。
const MAX_CANDIDATES: usize = 64;

/// 點了會執行、安裝或自動開網址的檔案類型：一律改成在 Finder 顯示，不直接打開。
const RUNNABLE_EXTENSIONS: [&str; 22] = [
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
    "dmg",
    "webloc",
    "inetloc",
    "applescript",
    "scptd",
    "appex",
];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPath {
    pub path: String,
    pub is_dir: bool,
}

/// `~/`（Windows 也接受 `~\`）換成家目錄，相對路徑接在 `base`（分頁的專案資料夾）後面。
/// 網路路徑不解析（見 [`crate::sys::is_network_path`]）。
pub fn expand(base: &Path, home: Option<&Path>, raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || crate::sys::is_network_path(raw) {
        return None;
    }
    if raw == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = strip_home(raw) {
        return home.map(|h| h.join(rest));
    }
    let path = Path::new(raw);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

/// `~/x` 的 `x`；Windows 也認 `~\x`。
pub fn strip_home(raw: &str) -> Option<&str> {
    raw.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            raw.strip_prefix("~\\")
        } else {
            None
        }
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

/// .app、腳本、安裝檔或可執行檔：打開等於執行，所以只在 Finder／檔案總管顯示。
/// 可執行檔在 macOS 看執行權限，在 Windows 看副檔名（.exe、.bat、.js… 見 [`crate::sys::WINDOWS_RUNNABLE`]）。
pub fn is_runnable(path: &Path) -> bool {
    let by_extension = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RUNNABLE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    by_extension || crate::sys::is_executable(path)
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

/// Windows 路徑 `C:\a\b` 寫成網址用的 `/C:/a/b`（磁碟代號的冒號保留）；其他路徑照常編碼。
fn url_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let has_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if has_drive {
        format!(
            "/{}:{}",
            &path[..1],
            encode_path(&path[2..].replace('\\', "/"))
        )
    } else {
        encode_path(path)
    }
}

/// `vscode://file/<路徑>:<行>:<欄>`；VS Code 系的編輯器都認得，開著或關著都能用。
pub fn editor_url(scheme: &str, path: &str, line: Option<u32>, column: Option<u32>) -> String {
    let mut url = format!("{scheme}://file{}", url_path(path));
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
    /// 編輯器沒有網址 scheme：直接用它打開檔案（無法跳行號）
    EditorApp(&'static str),
}

/// ⌘⌥＋點擊 → 在 Finder 顯示；文字檔且有編輯器 → 編輯器（只開不執行，腳本也安全）；
/// 會執行的檔案 → 只在 Finder 顯示；其他 → 系統預設 App。
pub fn decide(
    path: &Path,
    is_dir: bool,
    reveal: bool,
    editor: Option<&'static Editor>,
    line: Option<u32>,
    column: Option<u32>,
) -> OpenAction {
    if reveal {
        return OpenAction::Reveal;
    }
    if !is_dir
        && is_text_file(path)
        && let Some(editor) = editor
    {
        return match editor.scheme {
            Some(scheme) => {
                OpenAction::Editor(editor_url(scheme, &path.to_string_lossy(), line, column))
            }
            None => OpenAction::EditorApp(editor.id),
        };
    }
    if is_runnable(path) {
        return OpenAction::Reveal;
    }
    OpenAction::OpenDefault
}

/// 開啟終端機裡被 ⌘＋點擊的路徑，規則見 [`decide`]。
#[tauri::command]
pub async fn open_path(
    path: String,
    reveal: bool,
    line: Option<u32>,
    column: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    if crate::sys::is_network_path(&path) {
        return Err("open_failed".into());
    }
    // 先解開符號連結：名為 pic.png 卻指向某個 .app 的連結，要用實際的目標判斷
    let real = crate::sys::canonicalize(&path).map_err(|_| "file_missing".to_string())?;
    let target = real.as_path();
    let meta = fs::metadata(target).map_err(|_| "file_missing".to_string())?;
    let editor = if !reveal && !meta.is_dir() && is_text_file(target) {
        editors::pick_installed(editor.as_deref())
    } else {
        None
    };
    match decide(target, meta.is_dir(), reveal, editor, line, column) {
        OpenAction::Reveal => crate::sys::reveal(target),
        OpenAction::OpenDefault => crate::sys::open_default(target),
        OpenAction::Editor(url) => crate::sys::open_url(&url),
        OpenAction::EditorApp(id) => {
            let editor = editors::find(id).ok_or("open_failed")?;
            if editors::open_with(editor, &target.to_string_lossy()) {
                Ok(())
            } else {
                Err("open_failed".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editors::find;

    #[test]
    fn network_paths_from_terminal_output_are_never_resolved() {
        let base = Path::new("/proj");
        assert_eq!(expand(base, None, r"\\attacker\share\a.txt"), None);
        assert_eq!(expand(base, None, "//attacker/share/a.txt"), None);
        assert_eq!(resolve(base, None, r"\\attacker\share\a.txt"), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_scripts_without_an_editor_are_only_revealed() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("run.py");
        fs::write(&script, "print(1)").unwrap();
        assert_eq!(
            decide(&script, false, false, None, None, None),
            OpenAction::Reveal
        );
        assert!(matches!(
            decide(&script, false, false, find("vscode"), None, None),
            OpenAction::Editor(_)
        ));
    }

    #[test]
    fn editor_url_handles_windows_drive_paths() {
        assert_eq!(
            editor_url("vscode", r"C:\Users\me\專案\a.ts", Some(3), None),
            "vscode://file/C:/Users/me/%E5%B0%88%E6%A1%88/a.ts:3"
        );
        assert_eq!(
            editor_url("vscode", "/Users/me/a b.ts", None, None),
            "vscode://file/Users/me/a%20b.ts"
        );
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(unix)]
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
            decide(p, false, false, find("vscode"), Some(313), Some(5)),
            OpenAction::Editor(
                "vscode://file/p/%E6%88%91%E7%9A%84%20%E5%B0%88%E6%A1%88/src/App.tsx:313:5".into()
            )
        );
        assert_eq!(
            decide(
                Path::new("/p/README.md"),
                false,
                false,
                find("antigravity"),
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
                find("vscode"),
                Some(3),
                None
            ),
            OpenAction::Editor("vscode://file/p/Makefile:3".into())
        );
    }

    #[test]
    fn editors_without_a_url_scheme_open_the_file_directly() {
        assert_eq!(
            decide(
                Path::new("/p/a.md"),
                false,
                false,
                find("zed"),
                Some(3),
                None
            ),
            OpenAction::EditorApp("zed")
        );
        // ⌘⌥ 與會執行的資料夾仍然只在 Finder 顯示
        assert_eq!(
            decide(Path::new("/p/a.md"), false, true, find("zed"), None, None),
            OpenAction::Reveal
        );
    }

    #[cfg(unix)]
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
                find("vscode"),
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
                find("vscode"),
                None,
                None
            ),
            OpenAction::OpenDefault
        );
        assert_eq!(
            decide(Path::new("/p/src"), true, false, find("vscode"), None, None),
            OpenAction::OpenDefault
        );
        assert_eq!(
            decide(
                Path::new("/p/a.md"),
                false,
                true,
                find("vscode"),
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
                find("vscode"),
                None,
                None
            ),
            OpenAction::Reveal
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_judged_by_their_real_target() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Evil.app");
        fs::create_dir_all(&app).unwrap();
        let disguised = dir.path().join("pic.png");
        std::os::unix::fs::symlink(&app, &disguised).unwrap();
        // 只看連結本身會被當成圖片直接打開
        assert_eq!(
            decide(&disguised, true, false, None, None, None),
            OpenAction::OpenDefault
        );
        // open_path 用的是解開後的實際路徑
        let real = fs::canonicalize(&disguised).unwrap();
        assert_eq!(
            decide(&real, true, false, None, None, None),
            OpenAction::Reveal
        );
        assert!(is_runnable(Path::new("/tmp/Installer.dmg")));
        assert!(is_runnable(Path::new("/tmp/site.webloc")));
    }
}
