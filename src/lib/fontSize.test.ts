import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  nextFontSize,
  parseFontSize,
} from "./fontSize";

describe("nextFontSize", () => {
  it("一次放大或縮小一級，⌘0 回預設", () => {
    expect(nextFontSize(13, 1)).toBe(14);
    expect(nextFontSize(13, -1)).toBe(12);
    expect(nextFontSize(20, 0)).toBe(DEFAULT_FONT_SIZE);
  });
  it("不會超出上下限", () => {
    expect(nextFontSize(MAX_FONT_SIZE, 1)).toBe(MAX_FONT_SIZE);
    expect(nextFontSize(MIN_FONT_SIZE, -1)).toBe(MIN_FONT_SIZE);
  });
});

describe("parseFontSize", () => {
  it("讀回存過的大小，壞掉的值用預設", () => {
    expect(parseFontSize("16")).toBe(16);
    expect(parseFontSize(null)).toBe(DEFAULT_FONT_SIZE);
    expect(parseFontSize("abc")).toBe(DEFAULT_FONT_SIZE);
    expect(parseFontSize("99")).toBe(DEFAULT_FONT_SIZE);
    expect(parseFontSize("13.5")).toBe(DEFAULT_FONT_SIZE);
  });
});
