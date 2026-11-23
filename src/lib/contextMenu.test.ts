import { describe, expect, it } from "vitest";
import { isEditable } from "./contextMenu";

const el = (tagName: string, classes: string[] = [], isContentEditable = false) => ({
  tagName,
  isContentEditable,
  classList: { contains: (c: string) => classes.includes(c) },
});

describe("isEditable", () => {
  it("輸入框保留系統選單", () => {
    expect(isEditable(el("INPUT"))).toBe(true);
    expect(isEditable(el("TEXTAREA"))).toBe(true);
    expect(isEditable(el("DIV", [], true))).toBe(true);
  });
  it("一般區域和終端機不顯示預設選單（只有會讓 App 卡住的 Reload）", () => {
    expect(isEditable(el("DIV"))).toBe(false);
    expect(isEditable(el("TEXTAREA", ["xterm-helper-textarea"]))).toBe(false);
    expect(isEditable(null)).toBe(false);
    expect(isEditable({})).toBe(false);
  });
});
