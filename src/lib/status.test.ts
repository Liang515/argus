import { describe, expect, it } from "vitest";
import { looksLikePermissionPrompt, parseArgusOsc, statusLabel, stripAnsi } from "./status";

describe("parseArgusOsc", () => {
  it("解析 hook 送來的狀態", () => {
    expect(parseArgusOsc("argus;running")).toEqual({ status: "running", agent: "claude" });
    expect(parseArgusOsc("argus;needs-input")).toEqual({
      status: "needs-input",
      agent: "claude",
    });
    expect(parseArgusOsc("argus;done;agy")).toEqual({ status: "done", agent: "agy" });
    expect(parseArgusOsc("argus;idle;unknown")).toEqual({ status: "idle", agent: "claude" });
  });
  it("忽略其他程式或未知狀態", () => {
    expect(parseArgusOsc("other;running")).toBeNull();
    expect(parseArgusOsc("argus;exploded")).toBeNull();
    expect(parseArgusOsc("")).toBeNull();
  });
});

describe("statusLabel", () => {
  it("顯示 agent 名稱與狀態", () => {
    expect(statusLabel("running", "agy")).toBe("agy 執行中");
    expect(statusLabel("needs-input", "claude")).toBe("Claude 等待你確認");
    expect(statusLabel("off", "claude")).toBe("");
  });
});

describe("stripAnsi", () => {
  it("游標移動換成空白，保留可讀文字", () => {
    expect(stripAnsi("\x1b[1mDo\x1b[1Cyou\x1b[0m want\x1b]0;title\x07").trim()).toBe("Do you want");
  });
});

describe("looksLikePermissionPrompt", () => {
  it("辨識 Claude Code 權限確認", () => {
    const raw = "\x1b[1mDo you want to\x1b[1Cproceed?\x1b[0m\r\n\x1b[36m❯ 1. Yes\x1b[0m";
    expect(looksLikePermissionPrompt(stripAnsi(raw))).toBe(true);
    expect(looksLikePermissionPrompt("Overwrite file? [y/N]")).toBe(true);
  });
  it("一般輸出不誤判", () => {
    expect(looksLikePermissionPrompt("npm install finished, 0 vulnerabilities")).toBe(false);
  });
});
