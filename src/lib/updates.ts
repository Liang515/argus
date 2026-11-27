import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** 啟動後隔多久檢查一次新版。 */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

/** 有正式發佈的新版就回傳它；網路不通、沒有新版都回傳 null（不打擾使用者）。 */
export async function findUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch {
    return null;
  }
}

/**
 * 下載、安裝並重開 Argus。安裝走 Rust 的 `install_update`：macOS 只換 `Argus.app/Contents`，
 * Dock 上釘選的 Argus 才不會在更新後變成另一個圖示。
 */
export async function installAndRelaunch(update: Update): Promise<void> {
  await invoke("install_update", { rid: update.rid });
  await relaunch();
}
