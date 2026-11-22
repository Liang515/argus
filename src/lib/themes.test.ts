import { describe, expect, it } from "vitest";
import { BUILT_IN, isThemeId, mix, themeFromTerminal, uiFromTerminal } from "./themes";

describe("mix", () => {
  it("依比例混合兩色", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#191d27", "#e0e0e0", 0)).toBe("#191d27");
    expect(mix("#191d27", "#e0e0e0", 1)).toBe("#e0e0e0");
  });
  it("格式不對就原樣傳回", () => {
    expect(mix("red", "#ffffff", 0.5)).toBe("red");
  });
});

describe("uiFromTerminal", () => {
  it("外框從終端機背景往文字色微調，文字沿用終端機文字色", () => {
    const ui = uiFromTerminal({ background: "#191d27", foreground: "#e0e0e0" });
    expect(ui.bg).toBe("#191d27");
    expect(ui.text).toBe("#e0e0e0");
    // 面板、hover、邊框依序越來越亮，但都比文字暗
    const lum = (c: string) => Number.parseInt(c.slice(1), 16);
    expect(lum(ui.panel)).toBeGreaterThan(lum(ui.bg));
    expect(lum(ui.hover)).toBeGreaterThan(lum(ui.panel));
    expect(lum(ui.border)).toBeGreaterThan(lum(ui.hover));
  });
});

describe("themeFromTerminal", () => {
  it("缺的顏色用 Argus 的，游標用 Argus 的紫色", () => {
    const theme = themeFromTerminal({ background: "#000000", foreground: "#ffffff" });
    expect(theme.terminal.red).toBe(BUILT_IN.argus.terminal.red);
    expect(theme.terminal.cursor).toBe("#a594ff");
    expect(theme.terminal.cursorAccent).toBe("#000000");
  });
  it("Clear Dark 和「終端機」設定檔的色碼一致", () => {
    expect(BUILT_IN["clear-dark"].terminal.background).toBe("#191d27");
    expect(BUILT_IN["clear-dark"].ui.bg).toBe("#191d27");
  });
});

describe("isThemeId", () => {
  it("只接受支援的配色", () => {
    expect(isThemeId("clear-dark")).toBe(true);
    expect(isThemeId("solarized")).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });
});
