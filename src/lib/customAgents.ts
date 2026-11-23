import { type AgentId, isAgentId } from "./agents";

/**
 * 使用者在 ~/.argus/agents.json 自己加的啟動指令（例如接本機模型的 Claude）。
 * 指令就是使用者自己的 shell 指令，Argus 只負責在分頁裡打出來。
 */
export interface CustomAgent {
  name: string;
  command: string;
  /** 指令實際跑的 agent，給燈號用；不是 claude／agy／codex 就沒有燈號 */
  base: AgentId | null;
}

export const MAX_CUSTOM_AGENTS = 10;
const MAX_NAME = 40;
const MAX_COMMAND = 500;

/** 略過開頭的 `VAR=值` 與 `env`，看第一個指令是不是 Argus 認得的 agent。 */
export function baseAgent(command: string): AgentId | null {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => w !== "env" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const name = first?.split("/").pop();
  return isAgentId(name) ? name : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

/** 讀不懂的檔案或項目直接略過：這是選用功能，不能讓 Argus 因此出錯。 */
export function parseCustomAgents(source: string): CustomAgent[] {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return [];
  }
  const list = (data as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list)) return [];
  const agents: CustomAgent[] = [];
  for (const item of list) {
    const name = text((item as { name?: unknown })?.name, MAX_NAME);
    const command = text((item as { command?: unknown })?.command, MAX_COMMAND);
    if (name && command && !agents.some((a) => a.name === name))
      agents.push({ name, command, base: baseAgent(command) });
    if (agents.length === MAX_CUSTOM_AGENTS) break;
  }
  return agents;
}
