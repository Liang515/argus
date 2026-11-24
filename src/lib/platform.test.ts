import { describe, expect, it } from "vitest";
import { detectPlatform, platformText } from "./platform";

describe("detectPlatform", () => {
  it("依 navigator 判斷 Windows，其他當成 macOS", () => {
    expect(detectPlatform("Win32", "")).toBe("windows");
    expect(detectPlatform("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("MacIntel", "Mozilla/5.0 (Macintosh)")).toBe("mac");
    expect(detectPlatform("darwin", "Node.js/22")).toBe("mac");
  });
});

describe("platformText", () => {
  it("macOS 原樣回傳", () => {
    expect(platformText("⌘⇧T 在 Finder 顯示", "zh-TW", "mac")).toBe("⌘⇧T 在 Finder 顯示");
  });

  it("Windows 換成 Ctrl 系列按鍵與檔案總管", () => {
    const win = (s: string, lang: "zh-TW" | "en" = "zh-TW") => platformText(s, lang, "windows");
    expect(win("⌘⇧T")).toBe("Ctrl+Shift+D");
    expect(win("⌘T")).toBe("Ctrl+Shift+T");
    expect(win("開啟專案資料夾 (⌘T)")).toBe("開啟專案資料夾 (Ctrl+Shift+T)");
    expect(win("⌘⌥＋點擊路徑")).toBe("Ctrl+Alt+點擊路徑");
    expect(win("⌘＋點擊網址")).toBe("Ctrl+點擊網址");
    expect(win("⌘-click a path", "en")).toBe("Ctrl+click a path");
    expect(win("拖曳可調整順序（⌘⇧← →）")).toBe("拖曳可調整順序（Ctrl+Shift+PgUp / PgDn）");
    expect(win("⌘3")).toBe("Ctrl+3");
    expect(win("在 Finder 顯示並選取")).toBe("在 檔案總管 顯示並選取");
    expect(win("Reveal in Finder", "en")).toBe("Reveal in File Explorer");
    // 沒有 ⌘ 的不動
    expect(win("↑↓ 選擇")).toBe("↑↓ 選擇");
  });
});
