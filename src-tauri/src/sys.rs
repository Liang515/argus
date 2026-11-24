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
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| WINDOWS_RUNNABLE.contains(&e.to_ascii_lowercase().as_str()))
    }
}

/// Windows 上點開就會執行、安裝、或交給腳本引擎的檔案類型。
/// `.js`、`.vbs` 預設由 Windows Script Host 執行，不能當成一般文字檔打開。
#[cfg_attr(unix, allow(dead_code))]
pub const WINDOWS_RUNNABLE: [&str; 30] = [
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "msi",
    "msix",
    "msp",
    "appx",
    "appxbundle",
    "appinstaller",
    "appref-ms",
    "application",
    "lnk",
    "url",
    "scr",
    "pif",
    "cpl",
    "msc",
    "reg",
    "hta",
    "js",
    "jse",
    "vbs",
    "vbe",
    "wsf",
    "wsh",
    "jar",
    "inf",
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
    fn canonicalize_has_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let real = canonicalize(dir.path()).unwrap();
        assert!(!real.to_string_lossy().starts_with(r"\\?\"));
    }
}
