import { GitBranch, Keyboard, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentId, AgentIntent } from "../lib/agents";
import { type ClaudeStatus, statusLabel } from "../lib/status";
import { dropIndex, type Tab } from "../lib/tabs";
import { AgentButtons } from "./AgentButtons";

const DOT_CLASS: Record<Exclude<ClaudeStatus, "off">, string> = {
  idle: "bg-deck-muted/60",
  running: "bg-status-running animate-pulse",
  "needs-input": "bg-status-alert",
  done: "bg-status-done",
};

function StatusDot({
  status,
  agent,
  active,
}: {
  status: ClaudeStatus;
  agent: AgentId;
  active: boolean;
}) {
  if (status === "off") return null;
  // 背景分頁在等確認時加光暈閃爍，讓人一眼看到
  const alert =
    status === "needs-input" && !active
      ? "animate-pulse shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-status-alert)_35%,transparent)]"
      : "";
  return (
    <span
      role="img"
      aria-label={statusLabel(status, agent)}
      title={statusLabel(status, agent)}
      className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[status]} ${alert}`}
    />
  );
}

interface Props {
  tabs: Tab[];
  activeId: string | null;
  labels: Record<string, string>;
  branches: Record<string, string | null>;
  statuses: Record<string, ClaudeStatus>;
  runningAgents: Record<string, AgentId>;
  preferredAgent: AgentId;
  installed: AgentId[];
  /** 全螢幕時紅綠燈隱藏，不需要預留左側空間 */
  fullscreen: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onHelp: () => void;
  onAgent: (intent: AgentIntent, agent?: AgentId) => void;
}

export function TabBar({
  tabs,
  activeId,
  labels,
  branches,
  statuses,
  runningAgents,
  preferredAgent,
  installed,
  fullscreen,
  onSelect,
  onMove,
  onClose,
  onAdd,
  onHelp,
  onAgent,
}: Props) {
  const activeStatus = activeId ? (statuses[activeId] ?? "off") : "off";

  // 拖曳排序：用 pointer 事件自己處理（Tauri 在 macOS 會攔截 HTML5 拖放）
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    drag.current = { id, startX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 4) return;
      d.moved = true;
      setDraggingId(d.id);
    }
    const midpoints = tabs.map((t) => {
      const rect = tabEls.current.get(t.id)?.getBoundingClientRect();
      return rect ? rect.left + rect.width / 2 : Number.NaN;
    });
    onMove(
      d.id,
      dropIndex(
        midpoints,
        tabs.findIndex((t) => t.id === d.id),
        e.clientX,
      ),
    );
  };
  const onPointerUp = (e: React.PointerEvent, id: string) => {
    const d = drag.current;
    drag.current = null;
    setDraggingId(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // 沒有拖動才算點擊
    if (d && !d.moved) onSelect(id);
  };
  return (
    <header
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-1 border-b border-deck-border bg-deck-panel pr-2 ${fullscreen ? "pl-2" : "pl-[84px]"}`}
    >
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab, i) => {
          const active = tab.id === activeId;
          const branch = branches[tab.id];
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabEls.current.set(tab.id, el);
                else tabEls.current.delete(tab.id);
              }}
              className={`group flex h-7 ${draggingId === tab.id ? "opacity-70 ring-1 ring-deck-border" : ""} min-w-0 max-w-56 shrink items-center rounded-md text-[12.5px] transition-colors ${
                active
                  ? "bg-deck-hover text-deck-text shadow-[inset_0_0_0_1px_var(--color-deck-border)]"
                  : "text-deck-muted hover:bg-deck-hover/60 hover:text-deck-text"
              }`}
              title={`${tab.path}${i < 9 ? `  (⌘${i + 1})` : ""}\n拖曳可調整順序（⌘⇧← →）`}
            >
              <button
                type="button"
                onPointerDown={(e) => onPointerDown(e, tab.id)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => onPointerUp(e, tab.id)}
                onPointerCancel={(e) => onPointerUp(e, tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(tab.id);
                }}
                className="flex h-full min-w-0 items-center gap-1.5 pl-2.5 pr-1"
              >
                <StatusDot
                  status={statuses[tab.id] ?? "off"}
                  agent={runningAgents[tab.id] ?? "claude"}
                  active={active}
                />
                <span className="truncate font-medium">{labels[tab.id]}</span>
                {branch && (
                  <span className="flex min-w-0 items-center gap-0.5 text-[11px] text-deck-muted">
                    <GitBranch size={11} className="shrink-0" />
                    <span className="truncate">{branch}</span>
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label="關閉分頁"
                onClick={() => onClose(tab.id)}
                className={`mr-1 rounded p-0.5 hover:bg-deck-border ${active ? "opacity-70" : "opacity-0 group-hover:opacity-70"}`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label="新增專案分頁"
          title="開啟專案資料夾 (⌘T)"
          onClick={onAdd}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-deck-muted hover:bg-deck-hover hover:text-deck-text"
        >
          <Plus size={15} />
        </button>
      </div>
      {activeId && (
        <AgentButtons
          status={activeStatus}
          running={runningAgents[activeId] ?? "claude"}
          preferred={preferredAgent}
          installed={installed}
          onAction={onAgent}
        />
      )}
      <button
        type="button"
        aria-label="鍵盤快捷鍵"
        title="鍵盤快捷鍵 (⌘/)"
        onClick={onHelp}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-deck-muted hover:bg-deck-hover hover:text-deck-text"
      >
        <Keyboard size={15} />
      </button>
    </header>
  );
}
