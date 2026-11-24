//! 平台差異集中在這裡：啟動子行程、找執行檔、打開檔案或網址、在檔案管理員顯示。
//! macOS 沿用 `/usr/bin/open`；Windows 用 opener 套件（ShellExecute）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 建立子行程。Windows 的 GUI App 啟動主控台程式（git 等）時預設會閃出黑色視窗，要加旗標關掉。
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Windows 的 `canonicalize` 會回傳 `\\?\C:\…`，git 與顯示都不認得，改用一般格式。
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// 網路路徑（`\\server\share`、`//server/share`）與 Windows 裝置路徑（`\\?\`、`\\.\`）。
/// 光是查詢這種路徑存不存在，Windows 就會連到那台主機（可能送出登入憑證、或卡住數十秒），
/// 終端機輸出裡出現的這類字串一律不解析、不打開。
pub fn is_network_path(raw: &str) -> bool {
    let raw = raw.trim_start();
    raw.starts_with("\\\\")
        || raw.starts_with("//")
        || raw.starts_with("\\/")
        || raw.starts_with("/\\")
}

/// PATH 的分隔字元：macOS 是冒號，Windows 是分號（Windows 路徑本身含冒號）。
pub const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Windows 上能直接執行的副檔名（PATHEXT 沒設定時的預設值）。
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// 在 `path_var` 列的資料夾裡找可執行的 `name`。Windows 會依 PATHEXT 補副檔名（`code` → `code.cmd`）。
pub fn find_in(path_var: &str, name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.into());
        pathext
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    path_var
        .split(PATH_SEPARATOR)
        // Windows 的 PATH 項目可以用引號包住（例如 "C:\Program Files\…\bin"）
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| !d.is_empty())
        .flat_map(|dir| {
            exts.iter()
                .map(move |ext| Path::new(dir).join(format!("{name}{ext}")))
        })
        .find(|file| is_executable(file))
}

/// 在目前 App 的 PATH 裡找執行檔（macOS 改問 login shell，見 `project::detect_agents`）。
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    find_in(&std::env::var("PATH").unwrap_or_default(), name)
}

/// 是可以執行的檔案：macOS 看執行權限，Windows 看副檔名。
pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        // 系統 PATHEXT 裡的副檔名（使用者可能加了 .PY 等）也算可執行
        let pathext = std::env::var("PATHEXT")
            .unwrap_or_default()
            .to_ascii_lowercase();
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .is_some_and(|e| {
                WINDOWS_RUNNABLE.contains(&e.as_str())
                    || pathext.split(';').any(|p| p.trim_start_matches('.') == e)
            })
    }
}

/// Windows 上點開就會執行、安裝、掛載、連線，或交給腳本直譯器的檔案類型。
/// 程式碼檔（.py、.js…）有編輯器時一樣用編輯器打開（[`crate::paths::decide`] 先判斷文字檔），
/// 沒有編輯器時才會落到這裡，只在檔案總管顯示，不交給系統預設的直譯器執行。
#[cfg_attr(unix, allow(dead_code))]
pub const WINDOWS_RUNNABLE: &[&str] = &[
    // 執行檔與安裝檔
    "exe",
    "com",
    "scr",
    "pif",
    "cpl",
    "msc",
    "msi",
    "msix",
    "msixbundle",
    "msp",
    "mst",
    "msu",
    "appx",
    "appxbundle",
    "appinstaller",
    "appref-ms",
    "application",
    "gadget",
    "xbap",
    "xll",
    "inf",
    "reg",
    "diagcab",
    "chm",
    "hta",
    // 捷徑、遠端連線、殼層物件
    "lnk",
    "url",
    "website",
    "rdp",
    "scf",
    "settingcontent-ms",
    "library-ms",
    "searchconnector-ms",
    // 磁碟映像（打開會自動掛載）
    "iso",
    "img",
    "vhd",
    "vhdx",
    // 腳本（Windows Script Host、PowerShell、cmd）
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "psc1",
    "js",
    "jse",
    "vbs",
    "vbe",
    "vb",
    "wsf",
    "wsh",
    "wsc",
    "sct",
    // 有裝直譯器時，預設動作就是執行
    "py",
    "pyw",
    "pyz",
    "rb",
    "rbw",
    "pl",
    "php",
    "lua",
    "tcl",
    "mjs",
    "cjs",
    "sh",
    "bash",
    "zsh",
    "fish",
    "jar",
];

fn ok_or_open_failed<E>(result: Result<(), E>) -> Result<(), String> {
    result.map_err(|_| "open_failed".to_string())
}

/// 用系統預設的 App 打開（資料夾開在 Finder／檔案總管）。
pub fn open_default(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        run_open(command("/usr/bin/open").arg(path))
    } else {
        ok_or_open_failed(tauri_plugin_opener::open_path(path, None::<&str>))
    }
}

/// 在 Finder／檔案總管顯示並選取。
pub fn reveal(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        run_open(command("/usr/bin/open").arg("-R").arg(path))
    } else {
        ok_or_open_failed(tauri_plugin_opener::reveal_item_in_dir(path))
    }
}

/// 打開網址（例如 `vscode://file/…`）。
pub fn open_url(url: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        run_open(command("/usr/bin/open").arg(url))
    } else {
        ok_or_open_failed(tauri_plugin_opener::open_url(url, None::<&str>))
    }
}

fn run_open(cmd: &mut Command) -> Result<(), String> {
    let status = cmd.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("open_failed".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_in_skips_missing_and_non_executable() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        let file = dir.path().join(name);
        fs::write(&file, "x").unwrap();
        #[cfg(unix)]
        {
            assert_eq!(
                find_in(&dir.path().to_string_lossy(), "tool"),
                None,
                "沒有執行權限"
            );
            fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
        }
        let path_var = format!(
            "{}{PATH_SEPARATOR}{}",
            "/nope",
            dir.path().to_string_lossy()
        );
        assert_eq!(find_in(&path_var, "tool"), Some(file));
        assert_eq!(find_in(&path_var, "other"), None);
    }

    #[test]
    fn network_and_device_paths_are_detected() {
        for raw in [
            r"\\attacker\share\readme.txt",
            "//attacker/share/x",
            r"\\?\C:\x",
            r"\\.\pipe\x",
            r"\/attacker/x",
        ] {
            assert!(is_network_path(raw), "{raw}");
        }
        for raw in ["/Users/me/x", r"C:\x", r"src\a.ts", "~/x", "a//b"] {
            assert!(!is_network_path(raw), "{raw}");
        }
    }

    #[test]
    fn find_in_accepts_quoted_path_entries() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "tool.exe" } else { "tool" };
        let file = dir.path().join(name);
        fs::write(&file, "x").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let quoted = format!("\"{}\"", dir.path().to_string_lossy());
        assert_eq!(find_in(&quoted, "tool"), Some(file));
    }

    #[cfg(windows)]
    #[test]
    fn windows_runnable_types_are_executable() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "a.exe", "a.ps1", "a.js", "a.py", "a.iso", "a.lnk", "a.rdp", "a.chm",
        ] {
            let file = dir.path().join(name);
            fs::write(&file, "x").unwrap();
            assert!(is_executable(&file), "{name}");
        }
        let text = dir.path().join("a.md");
        fs::write(&text, "x").unwrap();
        assert!(!is_executable(&text));
    }

    #[test]
    fn canonicalize_has_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let real = canonicalize(dir.path()).unwrap();
        assert!(!real.to_string_lossy().starts_with(r"\\?\"));
    }
}
