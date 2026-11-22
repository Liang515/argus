import { Clock, CornerDownLeft, FolderOpen, FolderSearch, GitBranch, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentId } from "../lib/agents";
import { rank } from "../lib/fuzzy";
import { t } from "../lib/i18n";
import { type ClaudeStatus, statusLabel } from "../lib/status";
import { type Tab, tabName } from "../lib/tabs";

type Item =
  | { kind: "tab"; tab: Tab; index: number }
  | { kind: "recent"; path: string }
  | { kind: "path"; path: string }
  | { kind: "browse" }
  | { kind: "action"; action: PaletteAction };

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  tabs: Tab[];
  labels: Record<string, string>;
  /** 設定時只列這些動作（例如 ⌘⇧T 的選單），不列專案 */
  only?: { placeholder: string; actions: PaletteAction[] };
  recent: string[];
  actions: PaletteAction[];
  statuses: Record<string, ClaudeStatus>;
  runningAgents: Record<string, AgentId>;
  branches: Record<string, string | null>;
  onSelectTab: (id: string) => void;
  /** 回傳 false 代表路徑不是資料夾 */
  onOpenPath: (path: string) => Promise<boolean>;
  onBrowse: () => void;
  onClose: () => void;
}

const STATUS_COLOR: Partial<Record<ClaudeStatus, string>> = {
  running: "text-status-running",
  "needs-input": "text-status-alert",
  done: "text-status-done",
};

const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");
const looksLikePath = (q: string) => q.startsWith("/") || q.startsWith("~");

export function CommandPalette({
  tabs,
  labels,
  only,
  recent,
  actions,
  statuses,
  runningAgents,
  branches,
  onSelectTab,
  onOpenPath,
  onBrowse,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    if (only) {
      return rank(
        only.actions.map((action) => ({ kind: "action" as const, action })),
        q,
        (i) => [i.action.label],
      );
    }
    if (looksLikePath(q)) return [{ kind: "path", path: q }, { kind: "browse" }];
    const openPaths = new Set(tabs.map((t) => t.path));
    const tabItems: Item[] = rank(
      tabs.map((tab, index) => ({ kind: "tab" as const, tab, index })),
      q,
      (i) => [labels[i.tab.id] ?? tabName(i.tab.path), i.tab.path],
    );
    const recentItems: Item[] = rank(
      recent.filter((p) => !openPaths.has(p)).map((path) => ({ kind: "recent" as const, path })),
      q,
      (i) => [tabName(i.path), i.path],
    );
    const actionItems: Item[] = rank(
      actions.map((action) => ({ kind: "action" as const, action })),
      q,
      (i) => [i.action.label],
    );
    // 沒打字時只列專案，打字後才把動作一起列出來
    return [...tabItems, ...recentItems, ...(q ? actionItems : []), { kind: "browse" }];
  }, [query, tabs, labels, recent, actions, only]);

  const current = Math.min(selected, items.length - 1);

  const choose = async (item: Item) => {
    if (item.kind === "tab") onSelectTab(item.tab.id);
    else if (item.kind === "browse") onBrowse();
    else if (item.kind === "action") item.action.run();
    else if (!(await onOpenPath(item.path))) {
      setError(t("palette.folderMissing", { path: item.path }));
      return;
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 注音等輸入法組字中的 Enter / 方向鍵交給輸入法
    if (e.nativeEvent.isComposing) return;
    const move = (delta: number) => {
      e.preventDefault();
      setSelected((s) => (s + delta + items.length) % items.length);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
    else if (e.key === "Enter") {
      e.preventDefault();
      void choose(items[current]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 點背景關閉，鍵盤用 Esc
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex h-fit max-h-[60vh] w-[min(600px,90vw)] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-panel shadow-2xl">
        <input
          // biome-ignore lint/a11y/noAutofocus: 叫出切換器就是要立刻打字
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          placeholder={only?.placeholder ?? t("palette.placeholder")}
          className="w-full border-b border-deck-border bg-transparent px-4 py-3 text-[14px] text-deck-text outline-none placeholder:text-deck-muted"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {error && <p className="px-4 pt-2 text-[12px] text-status-alert">{error}</p>}
        <ul className="overflow-y-auto p-1.5">
          {items.map((item, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: 鍵盤操作由輸入框統一處理
            <li
              key={itemKey(item)}
              ref={i === current ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              onMouseMove={() => setSelected(i)}
              onClick={() => void choose(item)}
              className={`flex cursor-default items-center gap-2.5 rounded-md px-3 py-2 text-[13px] ${
                i === current ? "bg-deck-hover text-deck-text" : "text-deck-muted"
              }`}
            >
              <ItemRow
                item={item}
                label={item.kind === "tab" ? (labels[item.tab.id] ?? tabName(item.tab.path)) : ""}
                statuses={statuses}
                runningAgents={runningAgents}
                branches={branches}
              />
              {i === current && <CornerDownLeft size={13} className="shrink-0 text-deck-muted" />}
            </li>
          ))}
        </ul>
        <footer className="flex gap-4 border-t border-deck-border px-4 py-2 text-[11px] text-deck-muted">
          <span>{t("palette.hintSelect")}</span>
          <span>{t("palette.hintOpen")}</span>
          <span>{t("palette.hintClose")}</span>
          <span className="ml-auto">{t("palette.hintAll")}</span>
        </footer>
      </div>
    </div>
  );
}

function itemKey(item: Item) {
  if (item.kind === "tab") return `tab:${item.tab.id}`;
  if (item.kind === "browse") return "browse";
  if (item.kind === "action") return `action:${item.action.id}`;
  return `${item.kind}:${item.path}`;
}

function ItemRow({
  item,
  label,
  statuses,
  runningAgents,
  branches,
}: {
  item: Item;
  label: string;
  statuses: Record<string, ClaudeStatus>;
  runningAgents: Record<string, AgentId>;
  branches: Record<string, string | null>;
}) {
  if (item.kind === "browse") {
    return (
      <>
        <FolderSearch size={15} className="shrink-0" />
        <span className="flex-1">{t("palette.browse")}</span>
        <kbd className="text-[11px]">⌘T</kbd>
      </>
    );
  }
  if (item.kind === "action") {
    return (
      <>
        <Zap size={15} className="shrink-0" />
        <span className="flex-1">{item.action.label}</span>
        {item.action.hint && <kbd className="text-[11px]">{item.action.hint}</kbd>}
      </>
    );
  }
  if (item.kind === "path") {
    return (
      <>
        <FolderOpen size={15} className="shrink-0" />
        <span className="flex-1 truncate">{t("palette.openPath", { path: item.path })}</span>
      </>
    );
  }
  if (item.kind === "recent") {
    return (
      <>
        <Clock size={15} className="shrink-0" />
        <span className="font-medium text-deck-text">{tabName(item.path)}</span>
        <span className="flex-1 truncate text-[12px]">{shortPath(item.path)}</span>
      </>
    );
  }
  const status = statuses[item.tab.id] ?? "off";
  const branch = branches[item.tab.id];
  return (
    <>
      <span className="w-4 shrink-0 text-center text-[11px]">
        {item.index < 9 ? item.index + 1 : ""}
      </span>
      <span className="font-medium text-deck-text">{label}</span>
      {branch && (
        <span className="flex items-center gap-0.5 text-[11px]">
          <GitBranch size={11} />
          {branch}
        </span>
      )}
      <span className="flex-1 truncate text-[12px]">{shortPath(item.tab.path)}</span>
      {status !== "off" && (
        <span className={`shrink-0 text-[11px] ${STATUS_COLOR[status] ?? ""}`}>
          {statusLabel(status, runningAgents[item.tab.id] ?? "claude")}
        </span>
      )}
    </>
  );
}
