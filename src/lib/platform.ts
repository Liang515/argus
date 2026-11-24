/**
 * 平台差異：macOS 用 ⌘ 快捷鍵；Windows 照 Windows Terminal 的慣例用 Ctrl+Shift 系列
 * （單純的 Ctrl+C、Ctrl+K、Ctrl+W 在終端機與 agent 裡都有用途，不能拿來當 App 快捷鍵）。
 */

export type Platform = "mac" | "windows";

export function detectPlatform(platformName: string, userAgent: string): Platform {
  // 只看開頭：「darwin」裡也有 win
  return /^win/i.test(platformName) || /\bWindows NT\b/.test(userAgent) ? "windows" : "mac";
}

export const platform: Platform =
  typeof navigator === "undefined"
    ? "mac"
    : detectPlatform(navigator.platform ?? "", navigator.userAgent ?? "");

export const isMac = platform === "mac";

/**
 * 介面文字裡的 macOS 按鍵 → Windows 按鍵。長的放前面，避免 ⌘⇧T 先被 ⌘T 換掉。
 * 這些是語意對應（⌘⇧T 再開一個分頁 → Ctrl+Shift+D），不是逐字元替換。
 */
const WINDOWS_KEYS: [string, string][] = [
  ["⌘⇧← →", "Ctrl+Shift+PgUp / PgDn"],
  ["⌘⇧←  ⌘⇧→", "Ctrl+Shift+PgUp  Ctrl+Shift+PgDn"],
  ["⌘⇧[  ⌘⇧]", "Ctrl+Shift+Tab  Ctrl+Tab"],
  ["⌘⇧T", "Ctrl+Shift+D"],
  ["⌘⌥＋", "Ctrl+Alt+"],
  ["⌘⌥-", "Ctrl+Alt+"],
  ["⌘＋", "Ctrl+"],
  ["⌘-", "Ctrl+"],
  ["⌘1 – ⌘8", "Ctrl+1 – Ctrl+8"],
  ["⌘+  ⌘−", "Ctrl+=  Ctrl+−"],
  ["⌘+", "Ctrl+="],
  ["⌘−", "Ctrl+−"],
  ["⌘0", "Ctrl+0"],
  ["⌘9", "Ctrl+9"],
  ["⌘C", "Ctrl+Shift+C"],
  ["⌘T", "Ctrl+Shift+T"],
  ["⌘W", "Ctrl+Shift+W"],
  ["⌘K", "Ctrl+Shift+K"],
  ["⌘P", "Ctrl+Shift+P"],
  ["⌘J", "Ctrl+Shift+J"],
  ["⌘B", "Ctrl+Shift+B"],
  ["⌘/", "Ctrl+Shift+/"],
];

/** Finder 在 Windows 上叫「檔案總管」。 */
const FILE_MANAGER = { "zh-TW": "檔案總管", en: "File Explorer" } as const;

/**
 * 把介面文字換成目前平台的說法：Windows 上 ⌘ 按鍵改成 Ctrl 系列、Finder 改成檔案總管。
 * macOS 原樣回傳。
 */
export function platformText(
  text: string,
  lang: "zh-TW" | "en",
  target: Platform = platform,
): string {
  if (target === "mac") return text;
  let out = text;
  for (const [mac, win] of WINDOWS_KEYS) out = out.split(mac).join(win);
  // 剩下的「⌘數字」（分頁標題的 ⌘3）
  out = out.replace(/⌘(\d)/g, "Ctrl+$1");
  return out.split("Finder").join(FILE_MANAGER[lang]);
}
