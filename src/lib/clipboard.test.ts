import { describe, expect, it } from "vitest";
import { MAX_OSC52_BASE64, parseOsc52 } from "./clipboard";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("parseOsc52", () => {
  it("解出要寫入剪貼簿的文字（含中文）", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toBe("hello");
    expect(parseOsc52(`;${b64("我可以幫你一起測")}`)).toBe("我可以幫你一起測");
  });
  it("讀取請求、清空、格式錯誤、太大一律忽略", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("no-separator")).toBeNull();
    expect(parseOsc52(`x;${b64("a")}`)).toBeNull();
    expect(parseOsc52("c;not base64!")).toBeNull();
    expect(parseOsc52(`c;${"A".repeat(MAX_OSC52_BASE64 + 4)}`)).toBeNull();
    // 不是合法的 UTF-8
    expect(parseOsc52(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });
});
