import { ArrowUpCircle, ChevronDown, GitBranch, Keyboard, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId, AgentIntent } from "../lib/agents";
import { t } from "../lib/i18n";
import { type ClaudeStatus, statusLabel } from "../lib/status";
import { dropIndex, hiddenTabIds, overflowAlerts, type Tab } from "../lib/tabs";
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
  onInstallAgent: (agent: AgentId) => void;
  onAgentMenuOpen: () => void;
  /** 有新版時的版本號，沒有就是 null（不顯示任何東西） */
  updateVersion: string | null;
  updating: boolean;
  onUpdate: () => void;
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
  onInstallAgent,
  onAgentMenuOpen,
  updateVersion,
  updating,
  onUpdate,
}: Props) {
  const activeStatus = activeId ? (statuses[activeId] ?? "off") : "off";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);

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
  // 分頁放不下時，記下哪些不在畫面上，給「全部分頁」按鈕用
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    // 版面還沒排好（寬度 0）時量不準，等下一次尺寸變化再量
    if (view.width === 0) return;
    const rects = [...tabEls.current].map(([id, el]) => {
      const r = el.getBoundingClientRect();
      return { id, left: r.left, right: r.right };
    });
    const next = hiddenTabIds(view, rects);
    setHidden((prev) => (prev.join() === next.join() ? prev : next));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 分頁或名稱變動時重新量
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    scroller.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure, tabs, labels, branches]);

  // 切到看不到的分頁（⌘數字、⌘K、選單）時捲過去
  useEffect(() => {
    if (!activeId) return;
    tabEls.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

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
      {/* 分頁不壓縮（名稱要看得清楚），放不下就捲動，或用右邊的「全部分頁」選單 */}
      <div
        ref={scrollerRef}
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
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
              className={`group flex h-7 ${draggingId === tab.id ? "opacity-70 ring-1 ring-deck-border" : ""} shrink-0 items-center rounded-md text-[12.5px] transition-colors ${
                active
                  ? "bg-deck-hover text-deck-text shadow-[inset_0_0_0_1px_var(--color-deck-border)]"
                  : "text-deck-muted hover:bg-deck-hover/60 hover:text-deck-text"
              }`}
              title={`${tab.path}${i < 9 ? `  (⌘${i + 1})` : ""}\n${t("tab.dragHint")}`}
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
                <span className="max-w-36 truncate font-medium">{labels[tab.id]}</span>
                {branch && (
                  <span className="flex items-center gap-0.5 text-[11px] text-deck-muted">
                    <GitBranch size={11} className="shrink-0" />
                    <span className="max-w-24 truncate">{branch}</span>
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={t("tab.close")}
                onClick={() => onClose(tab.id)}
                className={`mr-1 rounded p-0.5 hover:bg-deck-border ${active ? "opacity-70" : "opacity-0 group-hover:opacity-70"}`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={t("tab.add")}
        title={t("tab.addTitle")}
        onClick={onAdd}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-deck-muted hover:bg-deck-hover hover:text-deck-text"
      >
        <Plus size={15} />
      </button>
      {hidden.length > 0 && (
        <TabsMenu
          tabs={tabs}
          activeId={activeId}
          labels={labels}
          branches={branches}
          statuses={statuses}
          runningAgents={runningAgents}
          hidden={hidden}
          onSelect={onSelect}
        />
      )}
      {updateVersion && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={updating}
          title={t("update.buttonTitle", { version: updateVersion })}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-deck-accent hover:bg-deck-hover disabled:opacity-60"
        >
          <ArrowUpCircle size={13} />
          {updating ? t("update.installing") : t("update.button", { version: updateVersion })}
        </button>
      )}
      {activeId && (
        <AgentButtons
          status={activeStatus}
          running={runningAgents[activeId] ?? "claude"}
          preferred={preferredAgent}
          installed={installed}
          onAction={onAgent}
          onInstall={onInstallAgent}
          onMenuOpen={onAgentMenuOpen}
        />
      )}
      <button
        type="button"
        aria-label={t("tab.shortcuts")}
        title={t("tab.shortcutsTitle")}
        onClick={onHelp}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-deck-muted hover:bg-deck-hover hover:text-deck-text"
      >
        <Keyboard size={15} />
      </button>
    </header>
  );
}

/** 分頁列放不下時出現：列出所有分頁，看不到的分頁有狀況時按鈕上會有提醒點。 */
function TabsMenu({
  tabs,
  activeId,
  labels,
  branches,
  statuses,
  runningAgents,
  hidden,
  onSelect,
}: {
  tabs: Tab[];
  activeId: string | null;
  labels: Record<string, string>;
  branches: Record<string, string | null>;
  statuses: Record<string, ClaudeStatus>;
  runningAgents: Record<string, AgentId>;
  hidden: string[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !menuRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const alerts = overflowAlerts(hidden.map((id) => statuses[id] ?? "off"));
  // 提醒點的說明要寫對是哪個 agent（例如 agy 執行中）
  const agentFor = (status: ClaudeStatus) =>
    runningAgents[hidden.find((id) => (statuses[id] ?? "off") === status) ?? ""] ?? "claude";
  const title = t("tab.hiddenCount", { count: hidden.length });

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={t("tab.allTabs")}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-deck-muted hover:bg-deck-hover hover:text-deck-text"
      >
        {alerts.map((status) => (
          <StatusDot key={status} status={status} agent={agentFor(status)} active={false} />
        ))}
        <span>{hidden.length}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-8 right-0 z-40 max-h-[70vh] w-72 overflow-y-auto rounded-lg border border-deck-border bg-deck-panel p-1 shadow-xl"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-[11px] text-deck-muted">{t("tab.allTabs")}</p>
          {tabs.map((tab, i) => {
            const status = statuses[tab.id] ?? "off";
            const branch = branches[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="menuitem"
                title={tab.path}
                onClick={() => {
                  setOpen(false);
                  onSelect(tab.id);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-deck-hover ${
                  tab.id === activeId ? "bg-deck-hover text-deck-text" : "text-deck-text"
                } ${hidden.includes(tab.id) ? "" : "opacity-60"}`}
              >
                <span className="flex w-2 shrink-0 justify-center">
                  <StatusDot
                    status={status}
                    agent={runningAgents[tab.id] ?? "claude"}
                    active={tab.id === activeId}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{labels[tab.id]}</span>
                {branch && (
                  <span className="max-w-24 truncate text-[11px] text-deck-muted">{branch}</span>
                )}
                {i < 9 && <kbd className="text-[11px] text-deck-muted">⌘{i + 1}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
