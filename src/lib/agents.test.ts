import { describe, expect, it } from "vitest";
import { agentStep, buttonMode, isAgentId, preferredAgent } from "./agents";

describe("preferredAgent", () => {
  it("用分頁選過的 agent，沒裝就退回第一個有安裝的", () => {
    expect(preferredAgent("agy", ["claude", "agy"])).toBe("agy");
    expect(preferredAgent("codex", ["claude", "agy"])).toBe("claude");
    expect(preferredAgent(undefined, ["agy"])).toBe("agy");
    expect(preferredAgent("bogus", [])).toBe("claude");
  });
});

describe("buttonMode", () => {
  it("沒有 agent 時可以啟動", () => {
    expect(buttonMode("off", "claude")).toBe("launch");
    expect(buttonMode("off", "agy")).toBe("launch");
  });
  it("Claude 與 Antigravity 閒置時才能在對話裡操作，Codex 沒有狀態 hook 不支援", () => {
    expect(buttonMode("idle", "claude")).toBe("session");
    expect(buttonMode("done", "claude")).toBe("session");
    expect(buttonMode("running", "claude")).toBe("busy");
    expect(buttonMode("needs-input", "claude")).toBe("busy");
    expect(buttonMode("idle", "agy")).toBe("session");
    expect(buttonMode("done", "agy")).toBe("session");
    expect(buttonMode("running", "agy")).toBe("busy");
    expect(buttonMode("done", "codex")).toBe("busy");
  });
});

describe("agentStep", () => {
  it("shell 空著時啟動或接續選定的 agent", () => {
    expect(agentStep("off", "claude", false, "new", "claude", "agy")).toEqual({
      kind: "shell",
      command: "claude",
    });
    expect(agentStep("off", "claude", false, "new", undefined, "agy")).toEqual({
      kind: "shell",
      command: "agy",
    });
    expect(agentStep("off", "claude", false, "resume", "agy", "claude")).toEqual({
      kind: "shell",
      command: "agy -c",
    });
    expect(agentStep("off", "claude", false, "resume", "claude", "claude")).toEqual({
      kind: "shell",
      command: "claude --resume",
    });
  });
  it("Claude 與 Antigravity 閒置時用斜線指令", () => {
    expect(agentStep("done", "claude", true, "new", undefined, "agy")).toEqual({
      kind: "agent",
      command: "/clear",
    });
    expect(agentStep("idle", "claude", true, "resume", undefined, "claude")).toEqual({
      kind: "agent",
      command: "/resume",
    });
    expect(agentStep("done", "agy", true, "new", undefined, "agy")).toEqual({
      kind: "agent",
      command: "/clear",
    });
    expect(agentStep("idle", "agy", true, "resume", undefined, "claude")).toEqual({
      kind: "agent",
      command: "/resume",
    });
  });
  it("分頁被占用時選了 agent 就開新分頁", () => {
    expect(agentStep("done", "agy", true, "new", "claude", "agy")).toEqual({
      kind: "new-tab",
      agent: "claude",
      command: "claude",
    });
    expect(agentStep("idle", "claude", true, "new", "claude", "claude")).toEqual({
      kind: "new-tab",
      agent: "claude",
      command: "claude",
    });
    // 燈號沒亮但前景有程式（例如沒裝 hook 的 agy）
    expect(agentStep("off", "claude", true, "resume", "codex", "claude")).toEqual({
      kind: "new-tab",
      agent: "codex",
      command: "codex resume",
    });
  });
  it("沒選 agent 時，執行中或無對話內操作的 agent 開著就不打字", () => {
    expect(agentStep("running", "claude", true, "new", undefined, "claude")).toEqual({
      kind: "wait",
    });
    expect(agentStep("running", "agy", true, "new", undefined, "agy")).toEqual({ kind: "wait" });
    expect(agentStep("done", "codex", true, "new", undefined, "codex")).toEqual({ kind: "wait" });
    expect(agentStep("off", "claude", true, "new", undefined, "claude")).toEqual({ kind: "wait" });
  });
});

describe("isAgentId", () => {
  it("只接受支援的 agent", () => {
    expect(isAgentId("agy")).toBe(true);
    expect(isAgentId("gemini")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });
});
