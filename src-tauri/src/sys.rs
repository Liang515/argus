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

/// agent 官方安裝程式放執行檔的位置（相對於家目錄），預設不會加進 PATH：
/// Claude Code → `~\.local\bin`；Antigravity CLI → `%LOCALAPPDATA%\agy\bin`。
#[cfg_attr(not(windows), allow(dead_code))]
const AGENT_DIRS: [&str; 2] = [r".local\bin", r"AppData\Local\agy\bin"];

/// 把存在、但還不在 PATH 裡的 agent 安裝位置接在後面。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn with_agent_dirs(path_var: &str, home: &Path) -> String {
    let mut out = path_var.trim_end_matches(PATH_SEPARATOR).to_string();
    for rel in AGENT_DIRS {
        let dir = home.join(rel);
        let dir_str = dir.to_string_lossy();
        let present = path_var
            .split(PATH_SEPARATOR)
            .any(|d| d.trim().trim_matches('"').eq_ignore_ascii_case(&dir_str));
        if !present && dir.is_dir() {
            if !out.is_empty() {
                out.push(PATH_SEPARATOR);
            }
            out.push_str(&dir_str);
        }
    }
    out
}

/// Windows：新分頁與 agent 偵測用的 PATH。
/// 程式啟動時拿到的 PATH 是當時的副本，使用者之後改了 PATH（或剛裝好 agent）要重開 Argus 才看得到；
/// 所以和 Windows Terminal 一樣，每次都從登錄檔讀系統＋使用者的最新值，再補上 agent 安裝位置。
#[cfg(windows)]
pub fn current_path() -> String {
    let fresh = [
        registry_path(
            true,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        registry_path(false, "Environment"),
    ]
    .into_iter()
    .flatten()
    .filter(|p| !p.is_empty())
    .collect::<Vec<_>>()
    .join(";");
    let base = if fresh.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        fresh
    };
    match dirs::home_dir() {
        Some(home) => with_agent_dirs(&base, &home),
        None => base,
    }
}

/// 讀登錄檔裡的 Path 值；`%USERPROFILE%` 這類變數由 RegGetValueW 展開。
#[cfg(windows)]
fn registry_path(machine: bool, subkey: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW,
    };
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let key = if machine {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    };
    let (subkey, value) = (wide(subkey), wide("Path"));
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut size: u32 = 0;
    // SAFETY：先問需要的大小，再用足夠的緩衝區讀；字串都以 0 結尾。
    unsafe {
        if RegGetValueW(
            key,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        ) != 0
        {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut bytes = (buf.len() * 2) as u32;
        if RegGetValueW(
            key,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut bytes,
        ) != 0
        {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
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

/// 在最新的 PATH 裡找執行檔（Windows 用；macOS 改問 login shell，見 `project::detect_agents`）。
#[cfg(windows)]
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    find_in(&current_path(), name)
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
    fn agent_dirs_are_appended_once_and_only_if_present() {
        let home = tempfile::tempdir().unwrap();
        let claude_dir = home.path().join(AGENT_DIRS[0]);
        let base = format!("/usr/bin{PATH_SEPARATOR}");
        // 還沒裝：不加
        assert_eq!(with_agent_dirs(&base, home.path()), "/usr/bin");
        fs::create_dir_all(&claude_dir).unwrap();
        let added = with_agent_dirs(&base, home.path());
        assert_eq!(
            added,
            format!("/usr/bin{PATH_SEPARATOR}{}", claude_dir.to_string_lossy())
        );
        // 已經在 PATH 裡（含引號）：不重複
        let quoted = format!("\"{}\"", claude_dir.to_string_lossy());
        assert_eq!(with_agent_dirs(&quoted, home.path()), quoted);
    }

    #[test]
    fn canonicalize_has_no_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let real = canonicalize(dir.path()).unwrap();
        assert!(!real.to_string_lossy().starts_with(r"\\?\"));
    }
}
