//! 安裝自動更新，並讓 Dock 上釘選的 Argus 在更新後仍指向同一個 App。
//!
//! `tauri-plugin-updater` 在 macOS 會把整個 `Argus.app` 跟新版對調。Dock 釘選的項目靠書籤
//! （資料夾的檔案 ID）找 App，對調後書籤跟著舊資料夾搬進暫存區，新版重開時 Dock 認不得，
//! 就在旁邊多開一個圖示。所以 macOS 改成只對調 `Argus.app/Contents`，外層資料夾不動；
//! 簽名在 `Contents/_CodeSignature` 裡，跟著一起換。做不到時（檔案系統不支援交換、
//! 沒有寫入權限等）退回外掛原本的安裝方式。其他平台直接用外掛安裝。

use tauri::Manager;
use tauri::ResourceId;
use tauri::Webview;
use tauri_plugin_updater::Update;

/// 下載（外掛會驗證更新簽名）並安裝前端 `check()` 拿到的那個更新；裝好後由前端重開。
#[tauri::command]
pub async fn install_update(webview: Webview, rid: ResourceId) -> Result<(), String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|e| e.to_string())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        match current_bundle().and_then(|bundle| macos::install_contents(&bundle, &bytes)) {
            Ok(()) => return Ok(()),
            Err(e) => eprintln!("只換 Contents 的更新失敗，改用外掛安裝：{e}"),
        }
    }
    update.install(&bytes).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn current_bundle() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle =
        tauri_plugin_updater::extract_path_from_executable(&exe).map_err(|e| e.to_string())?;
    if bundle.extension().is_some_and(|ext| ext == "app") {
        Ok(bundle)
    } else {
        Err(format!("不是從 .app 執行：{}", bundle.display()))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::fs;
    use std::io::Cursor;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path, PathBuf};

    /// 把更新包（`Argus.app/Contents/...` 的 tar.gz）的 `Contents` 換進 `bundle`。
    /// 失敗時 `bundle` 保持原樣，呼叫端可以再改用外掛安裝。
    pub fn install_contents(bundle: &Path, archive: &[u8]) -> Result<(), String> {
        let contents = bundle.join("Contents");
        // rename 只能在同一個磁碟區裡，暫存資料夾放系統暫存區或 App 旁邊
        let dev = fs::symlink_metadata(bundle)
            .map_err(|e| e.to_string())?
            .dev();
        let tmp_root = [
            Some(std::env::temp_dir()),
            bundle.parent().map(Path::to_path_buf),
        ]
        .into_iter()
        .flatten()
        .find(|dir| dir.metadata().is_ok_and(|m| m.dev() == dev))
        .ok_or("找不到和 App 同一個磁碟區的暫存位置")?;
        let staging = tempfile::Builder::new()
            .prefix("argus_update")
            .tempdir_in(&tmp_root)
            .map_err(|e| e.to_string())?;

        extract(archive, staging.path())?;
        let staged = staging.path().join("Contents");
        if !staged.join("Info.plist").is_file() {
            return Err("更新包裡沒有 Contents/Info.plist".into());
        }

        // 對調後舊的 Contents 留在暫存資料夾，staging 結束時一起刪掉
        swap(&staged, &contents).map_err(|e| format!("無法對調 Contents：{e}"))?;
        // 讓 LaunchServices 重新讀 Info.plist（版本號等）
        let _ = std::process::Command::new("touch").arg(bundle).status();
        Ok(())
    }

    /// 解開 tar.gz，去掉最外層的 `Argus.app/`，只接受一般的相對路徑。
    fn extract(archive: &[u8], dest: &Path) -> Result<(), String> {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(archive)));
        tar.set_preserve_permissions(true);
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?.into_owned();
            let mut parts = path.components();
            match parts.next() {
                Some(Component::Normal(top))
                    if Path::new(top).extension().is_some_and(|e| e == "app") => {}
                _ => {
                    return Err(format!(
                        "更新包裡有不在 .app 底下的檔案：{}",
                        path.display()
                    ));
                }
            }
            let rest: PathBuf = parts.collect();
            if rest.as_os_str().is_empty() {
                continue;
            }
            if !rest.components().all(|c| matches!(c, Component::Normal(_))) {
                return Err(format!("更新包裡有不安全的路徑：{}", path.display()));
            }
            // Argus 的 bundle 只有一般檔案與資料夾；連結可能把後面的檔案導到暫存區外面
            let kind = entry.header().entry_type();
            if !(kind.is_file() || kind.is_dir()) {
                return Err(format!("更新包裡有不支援的檔案類型：{}", path.display()));
            }
            let target = dest.join(&rest);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&target).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 原子對調兩個路徑（APFS 支援；HFS+ 等會回錯誤）。
    fn swap(a: &Path, b: &Path) -> std::io::Result<()> {
        let a = CString::new(a.as_os_str().as_bytes())?;
        let b = CString::new(b.as_os_str().as_bytes())?;
        // SAFETY: 兩個都是有效、以 NUL 結尾的字串，呼叫期間都還活著，renamex_np 只讀它們
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn archive(files: &[(&str, &str)]) -> Vec<u8> {
            let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            for (path, body) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                // set_path 會擋 `..`，測試惡意路徑要直接寫進 header
                header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
                header.set_cksum();
                tar.append(&header, body.as_bytes()).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap()
        }

        fn old_bundle(root: &Path) -> PathBuf {
            let bundle = root.join("Argus.app");
            fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
            fs::write(bundle.join("Contents/Info.plist"), "old").unwrap();
            fs::write(bundle.join("Contents/MacOS/argus"), "old-bin").unwrap();
            bundle
        }

        #[test]
        fn swaps_contents_and_keeps_bundle_identity() {
            let root = tempfile::tempdir().unwrap();
            let bundle = old_bundle(root.path());
            let ino = fs::metadata(&bundle).unwrap().ino();

            let bytes = archive(&[
                ("Argus.app/Contents/Info.plist", "new"),
                ("Argus.app/Contents/Resources/icon.icns", "icon"),
            ]);
            install_contents(&bundle, &bytes).unwrap();

            assert_eq!(fs::metadata(&bundle).unwrap().ino(), ino);
            assert_eq!(
                fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap(),
                "new"
            );
            assert!(bundle.join("Contents/Resources/icon.icns").is_file());
            assert!(!bundle.join("Contents/MacOS/argus").exists());
        }

        #[test]
        fn rejects_archive_without_contents() {
            let root = tempfile::tempdir().unwrap();
            let bundle = old_bundle(root.path());
            let bytes = archive(&[("Argus.app/README", "x")]);

            assert!(install_contents(&bundle, &bytes).is_err());
            assert_eq!(
                fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap(),
                "old"
            );
        }

        #[test]
        fn rejects_unsafe_paths() {
            let root = tempfile::tempdir().unwrap();
            let bundle = old_bundle(root.path());
            let bytes = archive(&[
                ("Argus.app/Contents/Info.plist", "new"),
                ("Argus.app/../../escaped", "x"),
            ]);

            assert!(install_contents(&bundle, &bytes).is_err());
            assert_eq!(
                fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap(),
                "old"
            );
        }

        #[test]
        fn rejects_files_outside_app() {
            let root = tempfile::tempdir().unwrap();
            let bundle = old_bundle(root.path());
            let bytes = archive(&[("Contents/Info.plist", "new")]);

            assert!(install_contents(&bundle, &bytes).is_err());
        }

        #[test]
        fn rejects_links() {
            let root = tempfile::tempdir().unwrap();
            let bundle = old_bundle(root.path());
            let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut tar = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            tar.append_link(&mut header, "Argus.app/Contents", "/tmp")
                .unwrap();
            let bytes = tar.into_inner().unwrap().finish().unwrap();

            assert!(install_contents(&bundle, &bytes).is_err());
            assert_eq!(
                fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap(),
                "old"
            );
        }
    }
}
