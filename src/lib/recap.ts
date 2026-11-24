/** 「近況」總覽：每個專案最後一次有動作的時間、最後一句指令、這輪改了哪些檔，存在 ~/.argus/recap.json。 */

import type { ActivityEvent } from "./activity";
import { type AgentId, isAgentId } from "./agents";
import { type Lang, lang, translate } from "./i18n";
import type { ClaudeStatus } from "./status";

export interface ProjectRecap {
  path: string;
  /** 最後一次有動作的時間（毫秒） */
  at: number;
  /** 最後一句使用者指令 */
  prompt?: string;
  /** 收到這句指令的 agent（同一個專案可能同時開著 Claude 和 agy） */
  promptAgent?: AgentId;
  /** 最後一句指令之後修改／寫入的檔案（新的在前） */
  files: string[];
  /** 最後用的 agent */
  agent?: AgentId;
}

/** 最多記幾個專案、每個專案記幾個檔案。 */
export const MAX_PROJECTS = 50;
export const MAX_FILES = 30;
/** 指令太長時只留開頭，避免存檔越來越大。 */
const MAX_PROMPT = 500;

function upsert(
  recaps: ProjectRecap[],
  path: string,
  now: number,
  change: (r: ProjectRecap) => ProjectRecap,
): ProjectRecap[] {
  const old = recaps.find((r) => r.path === path) ?? { path, at: now, files: [] };
  const next = { ...change(old), at: now };
  return [next, ...recaps.filter((r) => r.path !== path)].slice(0, MAX_PROJECTS);
}

/** 記下 hook 傳來的活動。讀取、搜尋這類不改東西的動作也算「有動作」。agent 是送出活動的 agent。 */
export function noteActivity(
  recaps: ProjectRecap[],
  path: string,
  event: ActivityEvent,
  now: number,
  agent?: AgentId,
): ProjectRecap[] {
  const withAgent = (r: ProjectRecap): ProjectRecap => (agent ? { ...r, agent } : r);
  if (event.k === "prompt") {
    const text = event.text.trim().slice(0, MAX_PROMPT);
    if (!text) return recaps;
    return upsert(recaps, path, now, (r) => {
      // agy 同一輪會重送同一句，不要把這輪改過的檔案清掉；別的 agent 剛好說了同一句（例如「好」）不算
      const sameTurn = event.dedup && r.prompt === text && (!agent || r.promptAgent === agent);
      if (sameTurn) return withAgent(r);
      // 新的一輪：不知道是誰收到時，不沿用上一句的 promptAgent
      const { promptAgent: _previous, ...rest } = r;
      return withAgent({ ...rest, prompt: text, files: [], ...(agent && { promptAgent: agent }) });
    });
  }
  // 一步到位的 done 失敗了就沒改到檔案（start 還不知道結果，先記）
  const failed = event.k === "done" && !event.ok;
  if ((event.k === "start" || event.k === "done") && event.path && !failed) {
    const file = event.path;
    if (event.verb === "edit" || event.verb === "write") {
      return upsert(recaps, path, now, (r) =>
        withAgent({
          ...r,
          files: [file, ...r.files.filter((f) => f !== file)].slice(0, MAX_FILES),
        }),
      );
    }
  }
  if (event.k === "start" || event.k === "done") return upsert(recaps, path, now, withAgent);
  return recaps;
}

/** 燈號變化：開始跑、等確認、跑完都算有動作，並記下是哪個 agent。 */
export function noteStatus(
  recaps: ProjectRecap[],
  path: string,
  status: ClaudeStatus,
  agent: AgentId,
  now: number,
): ProjectRecap[] {
  if (status === "off" || status === "idle") return recaps;
  return upsert(recaps, path, now, (r) => ({ ...r, agent }));
}

/**
 * 讀檔完成前就有新動作時，合併存檔與剛發生的紀錄。
 * 同一個專案：剛發生的有新指令就以它為準；只有燈號或讀檔這類動作時，沿用存檔的指令與檔案。
 */
export function mergeRecaps(saved: ProjectRecap[], live: ProjectRecap[]): ProjectRecap[] {
  const savedByPath = new Map(saved.map((r) => [r.path, r]));
  const merged = live.map((r) => {
    const old = savedByPath.get(r.path);
    if (!old || r.prompt !== undefined) return r;
    const files = [...r.files, ...old.files.filter((f) => !r.files.includes(f))];
    return {
      ...r,
      ...(old.prompt !== undefined && { prompt: old.prompt }),
      ...(old.promptAgent && { promptAgent: old.promptAgent }),
      files: files.slice(0, MAX_FILES),
      ...((r.agent ?? old.agent) && { agent: r.agent ?? old.agent }),
    };
  });
  const livePaths = new Set(live.map((r) => r.path));
  return [...merged, ...saved.filter((r) => !livePaths.has(r.path))]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PROJECTS);
}

/** 讀 recap.json；格式不對的項目略過，整份壞掉就當沒有。 */
export function parseRecaps(json: string | null): ProjectRecap[] {
  if (!json) return [];
  try {
    const data: unknown = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (r): r is ProjectRecap =>
          typeof r === "object" &&
          r !== null &&
          typeof r.path === "string" &&
          typeof r.at === "number",
      )
      .map((r) => ({
        path: r.path,
        at: r.at,
        ...(typeof r.prompt === "string" && { prompt: r.prompt }),
        files: Array.isArray(r.files)
          ? r.files.filter((f: unknown): f is string => typeof f === "string").slice(0, MAX_FILES)
          : [],
        ...(isAgentId(r.agent) && { agent: r.agent }),
        ...(isAgentId(r.promptAgent) && { promptAgent: r.promptAgent }),
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_PROJECTS);
  } catch {
    return [];
  }
}

const URGENCY: Record<ClaudeStatus, number> = {
  "needs-input": 0,
  running: 1,
  done: 2,
  idle: 3,
  off: 4,
};

/** 同一個專案開了好幾個分頁時，挑最需要注意的燈號：等確認 > 執行中 > 已完成 > 待命。 */
export function projectStatus(
  path: string,
  tabs: { id: string; path: string }[],
  statuses: Record<string, ClaudeStatus>,
): { status: ClaudeStatus; tabId: string | null } {
  let best: { status: ClaudeStatus; tabId: string | null } = { status: "off", tabId: null };
  for (const tab of tabs) {
    if (tab.path !== path) continue;
    const s = statuses[tab.id] ?? "off";
    if (best.tabId === null || URGENCY[s] < URGENCY[best.status])
      best = { status: s, tabId: tab.id };
  }
  return best;
}

/** 例如「剛剛」「5 分鐘前」「3 小時前」「昨天」「4 天前」，超過一週顯示日期。 */
export function relativeTime(at: number, now: number, language: Lang = lang): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return translate(language, "recap.justNow");
  if (min < 60) return translate(language, "recap.minutes", { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return translate(language, "recap.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return translate(language, "recap.yesterday");
  if (days < 7) return translate(language, "recap.days", { n: days });
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
