import { AGENTS, type AgentId, isAgentId } from "./agents";
import { type MessageKey, t } from "./i18n";

/** 分頁裡 Claude Code 的狀態。off：沒有在跑 claude。 */
export type ClaudeStatus = "off" | "idle" | "running" | "needs-input" | "done";

/** hook 用的私有 OSC 編號（`ESC ] 7777 ; argus ; <status> BEL`）。 */
export const DECK_OSC = 7777;

const STATUSES: readonly ClaudeStatus[] = ["off", "idle", "running", "needs-input", "done"];

/** 解析 OSC 7777（xterm 傳進來的是編號之後的部分）：`argus;<狀態>[;<agent>]`，沒寫 agent 就是 Claude。 */
export function parseArgusOsc(data: string): { status: ClaudeStatus; agent: AgentId } | null {
  const [tag, status, agent] = data.split(";");
  if (tag !== "argus") return null;
  if (!(STATUSES as readonly string[]).includes(status)) return null;
  return { status: status as ClaudeStatus, agent: isAgentId(agent) ? agent : "claude" };
}

/**
 * 去掉跳脫序列。Claude 的 TUI 常用游標移動代替空白，所以換成空白再壓縮，
 * 否則「Do you want」可能變成「Doyouwant」。
 */
export function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 比對終端機跳脫序列
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, " ")
      .replace(/\s+/g, " ")
  );
}

const PERMISSION_PROMPT =
  /Do you want to (?:proceed|make this edit|create|allow|run|overwrite)|\[y\/N\]|\[Y\/n\]|\(y\/n\)/i;

/** 備援偵測：沒有 hook 時（例如不是 zsh），從輸出文字判斷是否在等使用者確認。 */
export function looksLikePermissionPrompt(plainText: string): boolean {
  return PERMISSION_PROMPT.test(plainText);
}

const STATUS_TEXT: Record<Exclude<ClaudeStatus, "off">, MessageKey> = {
  idle: "status.idle",
  running: "status.running",
  "needs-input": "status.needsInput",
  done: "status.done",
};

/** 例如「agy 執行中」「Claude 等待你確認」。 */
export function statusLabel(status: ClaudeStatus, agent: AgentId): string {
  return status === "off" ? "" : `${AGENTS[agent].label} ${t(STATUS_TEXT[status])}`;
}
