//! 支援的編輯器：側欄「用編輯器開啟」、終端機 ⌘＋點擊路徑都用這張表。
//! 前端只能傳 id，實際要開哪個 App 由這裡決定，無法指定任意程式。

use std::process::Command;

use serde::Serialize;

pub struct Editor {
    pub id: &'static str,
    pub label: &'static str,
    pub bundle: &'static str,
    /// 預設安裝名稱（Spotlight 關掉時用來找 App，也是 `open -a` 的備案）
    pub app: &'static str,
    /// `<scheme>://file/<路徑>:<行>:<欄>`；沒有的話只能打開檔案，無法跳行號
    pub scheme: Option<&'static str>,
}

/// 依序偏好：使用者沒選過時，用第一個有安裝的。
pub const EDITORS: &[Editor] = &[
    Editor {
        id: "vscode",
        label: "VS Code",
        bundle: "com.microsoft.VSCode",
        app: "Visual Studio Code.app",
        scheme: Some("vscode"),
    },
    Editor {
        id: "cursor",
        label: "Cursor",
        bundle: "com.todesktop.230313mzl4w4u92",
        app: "Cursor.app",
        scheme: Some("cursor"),
    },
    Editor {
        id: "windsurf",
        label: "Windsurf",
        bundle: "com.exafunction.windsurf",
        app: "Windsurf.app",
        scheme: Some("windsurf"),
    },
    Editor {
        id: "antigravity",
        label: "Antigravity",
        bundle: "com.google.antigravity-ide",
        app: "Antigravity IDE.app",
        scheme: Some("antigravity-ide"),
    },
    Editor {
        id: "zed",
        label: "Zed",
        bundle: "dev.zed.Zed",
        app: "Zed.app",
        scheme: None,
    },
];

pub fn find(id: &str) -> Option<&'static Editor> {
    EDITORS.iter().find(|e| e.id == id)
}

fn installed(editor: &Editor) -> bool {
    crate::project::app_installed(editor.bundle, editor.app)
}

/// 使用者選的編輯器有裝就用它，否則用第一個有安裝的。
pub fn pick(
    preferred: Option<&str>,
    is_installed: impl Fn(&Editor) -> bool,
) -> Option<&'static Editor> {
    preferred
        .and_then(find)
        .filter(|e| is_installed(e))
        .or_else(|| EDITORS.iter().find(|e| is_installed(e)))
}

pub fn pick_installed(preferred: Option<&str>) -> Option<&'static Editor> {
    pick(preferred, installed)
}

/// 用這個編輯器打開檔案或資料夾：先依 bundle id，找不到再依 App 名稱。
pub fn open_with(editor: &Editor, target: &str) -> bool {
    let run = |flag: &str, app: &str| {
        Command::new("/usr/bin/open")
            .args([flag, app, target])
            .status()
            .is_ok_and(|s| s.success())
    };
    run("-b", editor.bundle) || run("-a", editor.app.trim_end_matches(".app"))
}

#[derive(Serialize)]
pub struct EditorInfo {
    id: &'static str,
    label: &'static str,
}

#[derive(Serialize)]
pub struct DetectedEditors {
    installed: Vec<EditorInfo>,
    /// 支援的總數；全部都裝了，前端就不必再重新偵測
    total: usize,
}

/// 這台電腦有安裝的編輯器，依偏好順序。
#[tauri::command]
pub async fn detect_apps() -> DetectedEditors {
    DetectedEditors {
        installed: EDITORS
            .iter()
            .filter(|e| installed(e))
            .map(|e| EditorInfo {
                id: e.id,
                label: e.label,
            })
            .collect(),
        total: EDITORS.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        for (i, e) in EDITORS.iter().enumerate() {
            assert!(EDITORS[i + 1..].iter().all(|o| o.id != e.id), "{}", e.id);
        }
    }

    #[test]
    fn pick_prefers_the_chosen_editor_when_installed() {
        let only = |ids: &'static [&'static str]| move |e: &Editor| ids.contains(&e.id);
        assert_eq!(
            pick(Some("cursor"), only(&["vscode", "cursor"])).map(|e| e.id),
            Some("cursor")
        );
        // 選的沒裝、或是不認得的 id：用第一個有裝的
        assert_eq!(
            pick(Some("zed"), only(&["antigravity", "cursor"])).map(|e| e.id),
            Some("cursor")
        );
        assert_eq!(
            pick(Some("notepad"), only(&["antigravity"])).map(|e| e.id),
            Some("antigravity")
        );
        assert_eq!(pick(None, only(&[])).map(|e| e.id), None);
    }
}
