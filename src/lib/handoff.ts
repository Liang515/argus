import type { ClaudeStatus } from "./status";

/**
 * 交接流程：使用者送出交接指令（自己打或從 ⌘K）→ 等 agent 寫完 HANDOFF.md → 使用者確認後才清掉對話。
 * - writing：agent 正在寫
 * - confirm：agent 做完了，等使用者按「清除對話」或取消
 */
export type HandoffPhase = "writing" | "confirm";

/**
 * 送出的訊息是不是交接指令：`/handoff`、「交接…」或「handoff…」開頭。
 * 誤判（例如問「交接規則怎麼加」）只會多一個「清除對話」選項，不按就沒事。
 */
export function isHandoffPrompt(text: string): boolean {
  return /^\s*(?:\/handoff\b|交接|hand ?off\b)/i.test(text);
}

/**
 * 依 agent 的狀態推進交接流程，回傳 null 代表結束（agent 關掉，或確認前使用者又繼續對話）。
 * 寫到一半冒出權限詢問也只是繼續等：清除一定要使用者自己按，不會打進確認框。
 */
export function handoffNext(phase: HandoffPhase, status: ClaudeStatus): HandoffPhase | null {
  if (status === "off") return null;
  const working = status === "running" || status === "needs-input";
  if (phase === "writing") return working ? "writing" : "confirm";
  return working ? null : "confirm";
}
