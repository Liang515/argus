import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type ActivityItem,
  type ActivityState,
  formatTook,
  type Todo,
  todoProgress,
} from "../lib/activity";
import { type MessageKey, t } from "../lib/i18n";
import { isMac } from "../lib/platform";
import { openPath } from "../lib/project";

const KIND_LABEL: Record<ActivityItem["kind"], MessageKey> = {
  prompt: "act.you",
  read: "act.read",
  edit: "act.edit",
  write: "act.write",
  run: "act.run",
  search: "act.search",
  web: "act.web",
  agent: "act.agent",
  other: "act.other",
};

function clock(at: number) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function TodoRow({ todo }: { todo: Todo }) {
  const mark =
    todo.status === "completed" ? (
      <span className="text-status-done">✓</span>
    ) : todo.status === "in_progress" ? (
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-status-running" />
    ) : (
      <span className="text-deck-muted">○</span>
    );
  return (
    <li
      className={`flex items-start gap-2 py-0.5 ${
        todo.status === "in_progress"
          ? "font-medium text-deck-text"
          : todo.status === "pending"
            ? "text-deck-muted"
            : "text-deck-text"
      }`}
    >
      <span className="flex w-3.5 shrink-0 justify-center pt-0.5">{mark}</span>
      <span className="min-w-0">{todo.text}</span>
    </li>
  );
}

function Result({ item }: { item: ActivityItem }) {
  if (item.kind === "prompt") return null;
  if (item.status === "running") return <span className="animate-spin text-status-running">⟳</span>;
  if (item.status === "fail") return <span className="text-status-alert">✗</span>;
  const extra =
    item.kind === "run" && item.took !== undefined
      ? formatTook(item.took)
      : item.add
        ? `${item.add > 0 ? "+" : ""}${item.add}`
        : "";
  if (item.status === "ok" && item.kind === "run")
    return <span className="text-status-done">{extra ? `✓ ${extra}` : "✓"}</span>;
  return <span className="text-deck-muted">{extra}</span>;
}

/** 一筆動作：點一下展開完整內容；檔案可以直接用編輯器打開。 */
function ActivityRow({
  item,
  open,
  onToggle,
}: {
  item: ActivityItem;
  open: boolean;
  onToggle: () => void;
}) {
  const full = item.detail ?? item.target;
  return (
    <li className="group rounded hover:bg-deck-hover">
      <div className="grid grid-cols-[2.6rem_2.9rem_1fr_auto] items-center gap-1.5 px-1.5 py-0.5">
        <span className="text-[11px] text-deck-muted tabular-nums">{clock(item.at)}</span>
        <span
          className={`text-[11px] ${item.kind === "prompt" ? "text-deck-accent" : "text-deck-muted"}`}
        >
          {t(KIND_LABEL[item.kind])}
        </span>
        <button
          type="button"
          onClick={onToggle}
          title={t(open ? "act.collapse" : "act.expand")}
          aria-expanded={open}
          className={`truncate text-left ${item.kind === "prompt" ? "text-deck-text" : "font-mono text-[11.5px] text-deck-text"}`}
        >
          {item.target}
        </button>
        <span className="flex items-center gap-1 text-[11px]">
          {item.path && (
            <button
              type="button"
              onClick={() => item.path && void openPath(item.path, false).catch(() => {})}
              title={t("act.openFile")}
              aria-label={t("act.openFile")}
              className="rounded p-0.5 text-deck-muted opacity-0 group-hover:opacity-100 hover:text-deck-text focus:opacity-100"
            >
              <ExternalLink size={11} />
            </button>
          )}
          <Result item={item} />
        </span>
      </div>
      {open && (
        <div className="mx-1.5 mb-1 ml-[5.6rem] rounded bg-deck-bg px-2 py-1.5 text-[11.5px] break-words whitespace-pre-wrap text-deck-text select-text">
          {item.path && item.path !== full ? `${item.path}\n` : ""}
          {full}
        </div>
      )}
    </li>
  );
}

/** 距離底部多近算「在底部」（像素）。 */
const NEAR_BOTTOM_PX = 40;

/** 側欄「活動」：Claude 的計畫進度與最近每一步動作。 */
export function ActivityPanel({ activity }: { activity: ActivityState }) {
  const listRef = useRef<HTMLElement>(null);
  // 展開看完整內容的那幾筆
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggle = (key: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // 使用者往上翻舊紀錄時不要被拉回最底；本來就在底部才跟著最新動作捲動
  const stickToBottom = useRef(true);
  const { done, total } = todoProgress(activity.todos);
  const last = activity.items[activity.items.length - 1]?.key;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在最後一筆變了時捲動
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  const onScroll = () => {
    const el = listRef.current;
    if (el)
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  };

  if (activity.items.length === 0 && total === 0) {
    return <p className="px-3 py-3 text-deck-muted">{t(isMac ? "act.empty" : "act.emptyWin")}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 計畫固定在上方，最近動作再多也不會把它捲走 */}
      {total > 0 && (
        <section className="max-h-[38%] shrink-0 overflow-y-auto border-b border-deck-border px-3 pt-2 pb-2">
          <header className="flex justify-between text-[11px] font-semibold tracking-wide text-deck-muted">
            <span>{t("act.plan")}</span>
            <span className="tabular-nums">
              {done} / {total}
            </span>
          </header>
          <div className="mt-1.5 mb-2 h-1.5 overflow-hidden rounded-full bg-deck-hover">
            <div
              className="h-full rounded-full bg-deck-accent transition-[width]"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
          <ul>
            {activity.todos.map((todo, i) => (
              // 計畫項目沒有 id，順序就是身分
              // biome-ignore lint/suspicious/noArrayIndexKey: 清單整份替換，不會重排
              <TodoRow key={i} todo={todo} />
            ))}
          </ul>
        </section>
      )}
      {activity.items.length > 0 && (
        <section
          ref={listRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto pt-2 pb-3"
        >
          <header className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-deck-muted">
            {t("act.recent")}
          </header>
          <ul className="px-1.5">
            {activity.items.map((item) => (
              <ActivityRow
                key={item.key}
                item={item}
                open={expanded.has(item.key)}
                onToggle={() => toggle(item.key)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
