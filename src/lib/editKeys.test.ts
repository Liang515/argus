import { describe, expect, it, vi } from "vitest";
import { editKey, handleEditKeyEvent } from "./editKeys";

const key = (
  code: string,
  mods: Partial<Record<"meta" | "alt" | "ctrl" | "shift", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
});

describe("editKey", () => {
  it("⌘← ⌘→ 移到行首／行尾，⌘⌫ 刪到行首", () => {
    expect(editKey(key("ArrowLeft", { meta: true }))).toEqual({ type: "send", data: "\x01" });
    expect(editKey(key("ArrowRight", { meta: true }))).toEqual({ type: "send", data: "\x05" });
    expect(editKey(key("Backspace", { meta: true }))).toEqual({ type: "send", data: "\x15" });
  });
  it("⌥← ⌥→ 一次跳一個字", () => {
    expect(editKey(key("ArrowLeft", { alt: true }))).toEqual({ type: "send", data: "\x1bb" });
    expect(editKey(key("ArrowRight", { alt: true }))).toEqual({ type: "send", data: "\x1bf" });
  });
  it("⇧↩ 換行（ESC+CR，Claude Code 視為換行而不是送出）", () => {
    expect(editKey(key("Enter", { shift: true }))).toEqual({ type: "send", data: "\x1b\r" });
    expect(editKey(key("Enter"))).toBeNull();
    expect(editKey(key("Enter", { shift: true, meta: true }))).toBeNull();
  });
  it("⌘A 全選終端機內容", () => {
    expect(editKey(key("KeyA", { meta: true }))).toEqual({ type: "select-all" });
  });
  it("⌘⇧← ⌘⇧→ 留給移動分頁，一般方向鍵照常送", () => {
    expect(editKey(key("ArrowLeft", { meta: true, shift: true }))).toBeNull();
    expect(editKey(key("ArrowLeft"))).toBeNull();
    expect(editKey(key("ArrowLeft", { ctrl: true }))).toBeNull();
  });
});

describe("handleEditKeyEvent", () => {
  const event = (code: string, mods: Parameters<typeof key>[1] = {}, extra = {}) => {
    let prevented = false;
    return {
      ...key(code, mods),
      type: "keydown",
      isComposing: false,
      preventDefault: () => {
        prevented = true;
      },
      prevented: () => prevented,
      ...extra,
    };
  };

  it("編輯鍵擋下瀏覽器預設動作，不讓 xterm 隱藏輸入框的游標跑掉（否則中文輸入會送出別的字）", () => {
    const e = event("ArrowLeft", { meta: true });
    const run = vi.fn();
    expect(handleEditKeyEvent(e, run)).toBe(false);
    expect(e.prevented()).toBe(true);
    expect(run).toHaveBeenCalledWith({ type: "send", data: "\x01" });
  });
  it("keyup 也擋下，但不重複送", () => {
    const e = event("ArrowLeft", { meta: true }, { type: "keyup" });
    const run = vi.fn();
    expect(handleEditKeyEvent(e, run)).toBe(false);
    expect(e.prevented()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("⇧↩ 的 keypress 也攔下，xterm 才不會再送一次 Enter 把訊息送出", () => {
    const e = event("Enter", { shift: true }, { type: "keypress" });
    const run = vi.fn();
    expect(handleEditKeyEvent(e, run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("輸入法組字中交給輸入法處理", () => {
    const e = event("ArrowLeft", { meta: true }, { isComposing: true });
    const run = vi.fn();
    expect(handleEditKeyEvent(e, run)).toBe(true);
    expect(e.prevented()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("一般按鍵交給 xterm", () => {
    const e = event("KeyX");
    expect(handleEditKeyEvent(e, vi.fn())).toBe(true);
    expect(e.prevented()).toBe(false);
  });
});
