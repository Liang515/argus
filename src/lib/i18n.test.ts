import { describe, expect, it } from "vitest";
import { detectLang, format, MESSAGE_KEYS, translate, translateError } from "./i18n";

describe("detectLang", () => {
  it("系統語言有中文就用繁中，其他用英文", () => {
    expect(detectLang(["zh-TW", "en-US"])).toBe("zh-TW");
    expect(detectLang(["zh-Hant-TW"])).toBe("zh-TW");
    expect(detectLang(["en-US", "zh-CN"])).toBe("zh-TW");
    expect(detectLang(["en-GB"])).toBe("en");
    expect(detectLang(["ja-JP"])).toBe("en");
    expect(detectLang([])).toBe("en");
  });
});

describe("messages", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("每一句中英文都有內容，佔位符一致", () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(100);
    for (const key of MESSAGE_KEYS) {
      const zh = translate("zh-TW", key);
      const en = translate("en", key);
      expect(en.trim(), key).not.toBe("");
      expect(placeholders(en), key).toEqual(placeholders(zh));
    }
  });
  it("代入變數，沒給的保留原樣", () => {
    expect(format("用 {app} 開啟 {x}", { app: "VS Code" })).toBe("用 VS Code 開啟 {x}");
    expect(translate("en", "agent.startTitle", { agent: "Claude", cmd: "claude" })).toBe(
      "Start Claude in this tab (claude)",
    );
  });
});

describe("translateError", () => {
  it("後端錯誤代碼轉成對應語言，帶細節的也行", () => {
    expect(translateError("dir_missing", "zh-TW")).toBe("資料夾不存在");
    expect(translateError("dir_missing", "en")).toBe("Folder not found");
    expect(translateError("git_failed: exit 128", "en")).toBe("Couldn't run git: exit 128");
  });
  it("不認得的錯誤原樣顯示", () => {
    expect(translateError("something odd", "en")).toBe("something odd");
    expect(translateError(new Error("boom"), "en")).toBe("Error: boom");
  });
});
