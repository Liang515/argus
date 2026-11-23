import { describe, expect, it } from "vitest";
import { baseAgent, MAX_CUSTOM_AGENTS, parseCustomAgents } from "./customAgents";

describe("baseAgent", () => {
  it("略過前面的環境變數，認出 claude／agy／codex", () => {
    expect(baseAgent("ANTHROPIC_BASE_URL=http://localhost:11434 claude --model qwen3")).toBe(
      "claude",
    );
    expect(baseAgent("codex --oss")).toBe("codex");
    expect(baseAgent("env FOO=1 agy")).toBe("agy");
    expect(baseAgent("~/.local/bin/claude")).toBe("claude");
  });
  it("其他程式沒有燈號", () => {
    expect(baseAgent("ollama run qwen3")).toBeNull();
    expect(baseAgent("")).toBeNull();
  });
});

describe("parseCustomAgents", () => {
  it("讀出名稱與指令，並附上燈號用的 agent", () => {
    const text = JSON.stringify({
      agents: [{ name: " 本機 Claude ", command: "ANTHROPIC_BASE_URL=x claude" }],
      example: [{ name: "不會被讀", command: "codex --oss" }],
    });
    expect(parseCustomAgents(text)).toEqual([
      { name: "本機 Claude", command: "ANTHROPIC_BASE_URL=x claude", base: "claude" },
    ]);
  });
  it("壞掉的檔案或欄位不對就略過，不讓 Argus 出錯", () => {
    expect(parseCustomAgents("{ not json")).toEqual([]);
    expect(parseCustomAgents("[]")).toEqual([]);
    expect(parseCustomAgents(JSON.stringify({ agents: "x" }))).toEqual([]);
    expect(
      parseCustomAgents(
        JSON.stringify({
          agents: [
            { name: "", command: "codex" },
            { name: "多行", command: "codex\nrm -rf ~" },
            { name: 1, command: "codex" },
            { name: "ok", command: "codex" },
          ],
        }),
      ),
    ).toEqual([{ name: "ok", command: "codex", base: "codex" }]);
  });
  it("名稱重複時只留第一個", () => {
    const agents = [
      { name: "本機", command: "codex --oss" },
      { name: "本機", command: "claude" },
    ];
    expect(parseCustomAgents(JSON.stringify({ agents }))).toEqual([
      { name: "本機", command: "codex --oss", base: "codex" },
    ]);
  });
  it("最多讀幾個", () => {
    const agents = Array.from({ length: MAX_CUSTOM_AGENTS + 5 }, (_, i) => ({
      name: `a${i}`,
      command: "codex",
    }));
    expect(parseCustomAgents(JSON.stringify({ agents }))).toHaveLength(MAX_CUSTOM_AGENTS);
  });
});
