export interface Tab {
  id: string;
  path: string;
  /** 這個分頁預設啟動的 agent（claude / agy / codex） */
  agent?: string;
}

export type ShortcutAction =
  | { type: "new" }
  | { type: "close" }
  | { type: "select"; index: number }
  | { type: "next" }
  | { type: "prev" }
  | { type: "palette" }
  | { type: "recap" }
  | { type: "sidebar" }
  | { type: "duplicate" }
  | { type: "help" }
  | { type: "move"; delta: -1 | 1 }
  /** 終端機字體：1 放大、-1 縮小、0 恢復預設 */
  | { type: "zoom"; delta: -1 | 0 | 1 };

type KeyLike = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code">;

/** 資料夾名稱，作為分頁標題。 */
export function tabName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

const CIRCLED = ["②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

/** 分頁標題；同一個資料夾開了多個分頁時，第二個起加上 ②③… */
export function tabLabels(tabs: Tab[]): Record<string, string> {
  const seen = new Map<string, number>();
  const labels: Record<string, string> = {};
  for (const tab of tabs) {
    const n = seen.get(tab.path) ?? 0;
    seen.set(tab.path, n + 1);
    const name = tabName(tab.path);
    labels[tab.id] = n === 0 ? name : `${name} ${CIRCLED[n - 1] ?? `#${n + 1}`}`;
  }
  return labels;
}

/** App 層級快捷鍵（Cmd 組合）；回傳 null 代表交給終端機處理。 */
export function shortcutAction(e: KeyLike): ShortcutAction | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) {
    if (e.code === "BracketRight") return { type: "next" };
    if (e.code === "BracketLeft") return { type: "prev" };
    if (e.key.toLowerCase() === "t") return { type: "duplicate" };
    if (e.code === "ArrowLeft") return { type: "move", delta: -1 };
    if (e.code === "ArrowRight") return { type: "move", delta: 1 };
    // 美式鍵盤的 ⌘＋ 其實是 ⌘⇧＝
    if (e.code === "Equal") return { type: "zoom", delta: 1 };
    return null;
  }
  const key = e.key.toLowerCase();
  if (key === "t") return { type: "new" };
  if (key === "w") return { type: "close" };
  if (key === "k" || key === "p") return { type: "palette" };
  if (key === "j") return { type: "recap" };
  if (key === "b") return { type: "sidebar" };
  if (e.code === "Slash" || key === "/") return { type: "help" };
  if (e.code === "Equal" || key === "+") return { type: "zoom", delta: 1 };
  if (e.code === "Minus") return { type: "zoom", delta: -1 };
  if (e.code === "Digit0") return { type: "zoom", delta: 0 };
  if (/^[1-9]$/.test(key)) {
    // 跟瀏覽器一樣：Cmd+9 是最後一個分頁
    return { type: "select", index: key === "9" ? -1 : Number(key) - 1 };
  }
  return null;
}

/** 把分頁移到指定位置（超出範圍就停在頭尾）；位置沒變時回傳原陣列。 */
export function moveTab(tabs: Tab[], id: string, toIndex: number): Tab[] {
  const from = tabs.findIndex((t) => t.id === id);
  const to = Math.max(0, Math.min(toIndex, tabs.length - 1));
  if (from === -1 || from === to) return tabs;
  const next = tabs.filter((t) => t.id !== id);
  next.splice(to, 0, tabs[from]);
  return next;
}

/**
 * 拖曳時的目標位置：指標越過哪些分頁的中線，就排在最右邊那個之後。
 * 回傳值給 moveTab 用（以移除被拖分頁後的陣列為準）。
 */
export function dropIndex(midpoints: number[], from: number, x: number): number {
  let target = 0;
  midpoints.forEach((mid, i) => {
    if (i !== from && x > mid) target = i < from ? i + 1 : i;
  });
  return target;
}

/** 分頁超出分頁列可見範圍多少像素以上才算「看不到」（容許邊框與小數誤差）。 */
const VISIBLE_SLACK = 4;

/**
 * 分頁列放不下時，哪些分頁不在可見範圍內（部分被切掉也算）。
 * `view` 是分頁列可捲動區的左右邊界，`tabs` 是各分頁的左右邊界。
 */
export function hiddenTabIds(
  view: { left: number; right: number },
  tabs: { id: string; left: number; right: number }[],
): string[] {
  return tabs
    .filter((t) => t.left < view.left - VISIBLE_SLACK || t.right > view.right + VISIBLE_SLACK)
    .map((t) => t.id);
}

/**
 * 看不到的分頁裡出現了哪些狀態，給「全部分頁」按鈕各亮一顆提醒點：
 * 依等你確認、已完成（等你看結果）、執行中排序。待命或沒有 agent 不提醒。
 */
export function overflowAlerts<S extends string>(statuses: S[]): S[] {
  return (["needs-input", "done", "running"] as string[]).filter((wanted): wanted is S =>
    statuses.some((s) => s === wanted),
  );
}

/** 依快捷鍵算出要切到哪個分頁。 */
export function resolveSelect(tabs: Tab[], activeId: string | null, action: ShortcutAction) {
  if (tabs.length === 0) return null;
  const current = Math.max(
    0,
    tabs.findIndex((t) => t.id === activeId),
  );
  switch (action.type) {
    case "select":
      return (action.index === -1 ? tabs[tabs.length - 1] : tabs[action.index])?.id ?? null;
    case "next":
      return tabs[(current + 1) % tabs.length].id;
    case "prev":
      return tabs[(current - 1 + tabs.length) % tabs.length].id;
    default:
      return null;
  }
}

/** 關閉分頁後的新 active：關的不是目前分頁就不變，否則選右邊、沒有再選左邊。 */
export function activeAfterClose(
  tabs: Tab[],
  closingId: string,
  activeId: string | null,
): string | null {
  if (closingId !== activeId) return activeId;
  const index = tabs.findIndex((t) => t.id === closingId);
  const remaining = tabs.filter((t) => t.id !== closingId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)].id;
}
