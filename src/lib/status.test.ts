import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  backgroundSessionId,
  looksLikePermissionPrompt,
  parseArgusOsc,
  statusLabel,
  stripAnsi,
} from "./status";

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
    // 介面語言跟著系統，所以用目前語言的文字比對
    expect(statusLabel("running", "agy")).toBe(`agy ${t("status.running")}`);
    expect(statusLabel("needs-input", "claude")).toBe(`Claude ${t("status.needsInput")}`);
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

describe("backgroundSessionId", () => {
  it("從 claude --resume 的拒絕訊息取出對話代碼", () => {
    const msg =
      '"Agy 和 Claude 的切換功能" is running in the background (ad697cee).\n\nRun claude attach ad697cee to open it';
    expect(backgroundSessionId(msg)).toBe("ad697cee");
  });
  it("代碼不是十六進位就不理會，避免把輸出當成指令", () => {
    expect(backgroundSessionId("is running in the background (x; rm -rf ~)")).toBeNull();
    expect(backgroundSessionId("nothing here")).toBeNull();
  });
});
