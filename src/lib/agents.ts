import type { ClaudeStatus } from "./status";

/** Argus 支援的 coding agent；順序也是選單的顯示順序。 */
export const AGENT_IDS = ["claude", "agy", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type AgentIntent = "new" | "resume";

/** 沒裝的 agent 在選單裡點了，會顯示 installCommand 讓使用者在新分頁執行或複製。 */
export const AGENTS: Record<
  AgentId,
  {
    label: string;
    start: string;
    resume: string;
    /** 官方安裝說明頁 */
    install: string;
    /** 官方的 macOS 一行安裝指令（2026-11 從官網查證） */
    installCommand: string;
  }
> = {
  claude: {
    label: "Claude",
    start: "claude",
    resume: "claude --resume",
    install: "https://code.claude.com/docs/en/setup",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  agy: {
    label: "agy",
    start: "agy",
    resume: "agy -c",
    install: "https://antigravity.google/docs/cli/install",
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
  codex: {
    label: "Codex",
    start: "codex",
    resume: "codex resume",
    install: "https://developers.openai.com/codex/cli/",
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** 分頁的預設 agent：選過且仍有安裝就用它，否則用第一個有安裝的。 */
export function preferredAgent(tabAgent: string | undefined, installed: AgentId[]): AgentId {
  if (isAgentId(tabAgent) && installed.includes(tabAgent)) return tabAgent;
  return installed[0] ?? "claude";
}

/**
 * 分頁列右側按鈕的模式：
 * - launch：沒有 agent 在跑，可以啟動或接續
 * - claude-session：Claude 開著且閒置，可以新對話／切換對話
 * - busy：agent 正在工作，或是不支援對話內操作的 agent（agy、Codex）
 */
export type ButtonMode = "launch" | "claude-session" | "busy";

export function buttonMode(status: ClaudeStatus, running: AgentId): ButtonMode {
  if (status === "off") return "launch";
  if (running === "claude" && (status === "idle" || status === "done")) return "claude-session";
  return "busy";
}

/** 按下按鈕要做什麼：在 shell 打指令、在 agent 裡打斜線指令、開新分頁執行，或先不動作。 */
export type AgentStep =
  | { kind: "shell"; command: string }
  | { kind: "agent"; command: string }
  | { kind: "new-tab"; agent: AgentId; command: string }
  | { kind: "wait" };

/**
 * @param shellBusy shell 前景有程式（agent 或其他指令）
 * @param chosen 使用者明確選的 agent；沒選時用 preferred
 */
export function agentStep(
  status: ClaudeStatus,
  running: AgentId,
  shellBusy: boolean,
  intent: AgentIntent,
  chosen: AgentId | undefined,
  preferred: AgentId,
): AgentStep {
  const mode = buttonMode(status, running);
  if (mode === "launch" && !shellBusy) {
    const agent = chosen ?? preferred;
    return { kind: "shell", command: launchCommand(agent, intent) };
  }
  // 分頁被占用時明確選了 agent：不打斷目前的程式，在新分頁開
  if (chosen) return { kind: "new-tab", agent: chosen, command: launchCommand(chosen, intent) };
  if (mode === "claude-session") {
    return { kind: "agent", command: intent === "new" ? "/clear" : "/resume" };
  }
  // 執行中或等確認時打字會打斷它
  return { kind: "wait" };
}

function launchCommand(agent: AgentId, intent: AgentIntent) {
  return intent === "new" ? AGENTS[agent].start : AGENTS[agent].resume;
}
