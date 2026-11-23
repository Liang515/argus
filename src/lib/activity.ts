/** 側欄「活動」面板：把 hook 傳來的摘要（argus-activity）累積成計畫與最近動作。 */

export type Verb = "read" | "edit" | "write" | "run" | "search" | "web" | "agent" | "other";

/** 後端 activity.rs 的 Event（`k` 是種類）。 */
export type ActivityEvent =
  | { k: "prompt"; text: string }
  | { k: "start"; id?: string; verb: Verb; target: string; add?: number; detail?: string }
  | { k: "end"; id?: string; ok: boolean }
  | { k: "todos"; items: { text: string; status: string }[] }
  | { k: "stop" };

export interface ActivityItem {
  key: number;
  id?: string;
  at: number;
  kind: "prompt" | Verb;
  target: string;
  add?: number;
  /** 滑鼠移上去顯示的完整內容（例如整行指令） */
  detail?: string;
  /** prompt 沒有狀態；工具是 running → ok / fail，回覆結束時還沒收到結果的算 unknown */
  status?: "running" | "ok" | "fail" | "unknown";
  /** 執行花了多久（毫秒），只有收到結束事件才有 */
  took?: number;
}

export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ActivityState {
  todos: Todo[];
  items: ActivityItem[];
  /** 下一筆的 key（React 用） */
  next: number;
}

export const EMPTY_ACTIVITY: ActivityState = { todos: [], items: [], next: 0 };

/** 最多保留幾筆動作，避免長時間工作後越積越多。 */
export const MAX_ITEMS = 150;

const VERBS = new Set<Verb>(["read", "edit", "write", "run", "search", "web", "agent", "other"]);

/** 解析 OSC 內容（`argus-activity;` 之後的 JSON）；格式不對就忽略。 */
export function parseActivity(json: string): ActivityEvent | null {
  try {
    const e = JSON.parse(json) as ActivityEvent;
    switch (e?.k) {
      case "prompt":
        return typeof e.text === "string" ? e : null;
      case "start":
        return VERBS.has(e.verb) && typeof e.target === "string" ? e : null;
      case "end":
        return typeof e.ok === "boolean" ? e : null;
      case "todos":
        // 終端機輸出可能被偽造（例如 cat 一個測試檔），只留格式正確的項目
        if (!Array.isArray(e.items)) return null;
        return {
          k: "todos",
          items: e.items.filter(
            (t): t is { text: string; status: string } =>
              typeof t === "object" && t !== null && typeof t.text === "string",
          ),
        };
      case "stop":
        return e;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function normalizeTodo(t: { text: string; status: string }): Todo {
  const status =
    t.status === "completed" || t.status === "in_progress" ? t.status : ("pending" as const);
  return { text: String(t.text ?? ""), status };
}

/** 找要結束的那一筆：有 id 就對 id，沒有就是最後一筆還在執行的。 */
function findRunning(items: ActivityItem[], id?: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.status !== "running") continue;
    if (!id || !it.id || it.id === id) return i;
  }
  return -1;
}

export function applyActivity(
  state: ActivityState,
  event: ActivityEvent,
  now: number,
): ActivityState {
  const push = (item: Omit<ActivityItem, "key">): ActivityState => {
    const items = [...state.items, { ...item, key: state.next }].slice(-MAX_ITEMS);
    return { ...state, items, next: state.next + 1 };
  };
  switch (event.k) {
    case "prompt":
      // 新的一輪：上一輪的計畫已經不一定適用，先清掉，等 Claude 重新列
      return { ...push({ at: now, kind: "prompt", target: event.text }), todos: [] };
    case "start":
      return push({
        id: event.id,
        at: now,
        kind: event.verb,
        target: event.target,
        add: event.add,
        detail: event.detail,
        status: "running",
      });
    case "end": {
      const i = findRunning(state.items, event.id);
      if (i === -1) return state;
      const items = state.items.slice();
      items[i] = { ...items[i], status: event.ok ? "ok" : "fail", took: now - items[i].at };
      return { ...state, items };
    }
    case "todos":
      return { ...state, todos: event.items.map(normalizeTodo) };
    case "stop": {
      // 回覆結束了還在「執行中」的（例如被中斷、沒收到結束事件）改成不確定，不要一直轉圈
      if (!state.items.some((it) => it.status === "running")) return state;
      return {
        ...state,
        items: state.items.map((it) =>
          it.status === "running" ? { ...it, status: "unknown" as const } : it,
        ),
      };
    }
  }
}

/** 計畫進度：完成幾項／共幾項。 */
export function todoProgress(todos: Todo[]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length };
}

/** 例如 <1s、4s、1m 20s。 */
export function formatTook(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
