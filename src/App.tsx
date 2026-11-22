import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import {
  AGENT_IDS,
  AGENTS,
  type AgentId,
  type AgentIntent,
  agentStep,
  buttonMode,
  isAgentId,
  preferredAgent,
} from "./lib/agents";
import { pushRecent } from "./lib/fuzzy";
import { t, translateError } from "./lib/i18n";
import { isAppAvailable, OPEN_TARGET_LABEL, type OpenTarget, openIn } from "./lib/project";
import type { ClaudeStatus } from "./lib/status";
import {
  activeAfterClose,
  moveTab,
  resolveSelect,
  shortcutAction,
  type Tab,
  tabLabels,
} from "./lib/tabs";
import { setDefaultTerminalTheme, TerminalSession } from "./lib/terminalSession";
import {
  applyUi,
  BUILT_IN,
  isThemeId,
  THEME_IDS,
  type Theme,
  type ThemeId,
  themeFromTerminal,
} from "./lib/themes";

interface Workspace {
  tabs: Tab[];
  activeId: string | null;
  recent: string[];
}

const BRANCH_REFRESH_MS = 5000;
const STALE_CHECK_MS = 2000;
const DETECT_THROTTLE_MS = 5000;
const DETECT_RELAXED_MS = 60_000;
/** detect_apps 偵測的編輯器數量（VS Code、Antigravity） */
const EDITOR_COUNT = 2;
const SIDEBAR_KEY = "argus.sidebar";
const THEME_KEY = "argus.theme";

function loadThemePref(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return isThemeId(saved) ? saved : "argus";
  } catch {
    return "argus";
  }
}

/** 「跟隨終端機」讀不到設定時（沒用過「終端機」等）退回 Clear Dark。 */
async function resolveTheme(id: ThemeId): Promise<Theme> {
  if (id !== "terminal-app") return BUILT_IN[id];
  const colors = await invoke<Record<string, string> | null>("terminal_app_theme").catch(
    () => null,
  );
  return colors ? themeFromTerminal(colors) : BUILT_IN["clear-dark"];
}

const THEME_NAME_KEY = {
  argus: "theme.argus",
  "clear-dark": "theme.clearDark",
  "terminal-app": "theme.terminalApp",
} as const;

function loadSidebarPref() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

function TerminalHost({ session, active }: { session: TerminalSession; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) session.attach(ref.current);
  }, [session]);
  // 背景分頁用 visibility 隱藏而非 unmount：保留 scrollback，尺寸也跟著視窗調整。
  // 留白放在外層，xterm 本身維持滿版，fit 與 WebGL 畫面才會對齊。
  return (
    <div
      className={`absolute inset-0 bg-deck-bg pt-2 pl-3 ${active ? "" : "pointer-events-none invisible"}`}
    >
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const [statuses, setStatuses] = useState<Record<string, ClaudeStatus>>({});
  const [runningAgents, setRunningAgents] = useState<Record<string, AgentId>>({});
  const [installed, setInstalled] = useState<AgentId[]>(["claude"]);
  // 有安裝的編輯器；null 表示還沒偵測完
  const [apps, setApps] = useState<OpenTarget[] | null>(null);
  const detectRef = useRef<(force?: boolean) => void>(() => {});
  const [fullscreen, setFullscreen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // all：一般切換器；duplicate：⌘⇧T 選擇怎麼在同專案再開分頁
  const [palette, setPalette] = useState<"all" | "duplicate" | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarPref);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemePref);
  const sessions = useRef(new Map<string, TerminalSession>());
  const stageRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ tabs, activeId, statuses, runningAgents, installed });
  latest.current = { tabs, activeId, statuses, runningAgents, installed };

  const sessionFor = useCallback((tab: Tab) => {
    let session = sessions.current.get(tab.id);
    if (!session) {
      session = new TerminalSession(tab.id, tab.path, (id, status, agent) => {
        setStatuses((prev) => ({ ...prev, [id]: status }));
        setRunningAgents((prev) => ({ ...prev, [id]: agent }));
      });
      sessions.current.set(tab.id, session);
    }
    return session;
  }, []);

  useEffect(() => {
    invoke<Workspace>("workspace_load")
      .then((ws) => {
        setTabs(ws.tabs);
        setActiveId(ws.activeId ?? ws.tabs[0]?.id ?? null);
        setRecent(ws.recent ?? []);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    invoke("workspace_save", { workspace: { tabs, activeId, recent } }).catch(() => {});
  }, [tabs, activeId, recent, loaded]);

  // 偵測裝了哪些 agent 與編輯器。切回視窗時重新偵測，照著提示裝好後回來就能直接用；
  // 全部都裝了就不再偵測（偵測要啟動一次使用者的 shell）
  useEffect(() => {
    let last = 0;
    let complete = false;
    let hasAgent = false;
    // force：打開 agent 選單時，不受節流限制，剛裝好的 agent 才會馬上出現
    const detect = (force = false) => {
      // 已經有 agent 可用時不急著知道新裝的，拉長間隔省得一直啟動 shell
      const interval = force
        ? DETECT_THROTTLE_MS
        : hasAgent
          ? DETECT_RELAXED_MS
          : DETECT_THROTTLE_MS;
      if (complete || Date.now() - last < interval) return;
      last = Date.now();
      Promise.all([
        invoke<string[]>("detect_agents").then((found) => found.filter(isAgentId)),
        invoke<OpenTarget[]>("detect_apps"),
      ])
        .then(([agents, editors]) => {
          setInstalled(agents);
          setApps(editors);
          hasAgent = agents.length > 0;
          complete = agents.length === AGENT_IDS.length && editors.length === EDITOR_COUNT;
        })
        .catch(() => {});
    };
    detectRef.current = detect;
    detect();
    const onFocus = () => detect();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ⌘Q 或關視窗：後端先擋下來問這裡。有程式在跑的分頁就確認，否則直接結束
  useEffect(() => {
    // 對話框開著時又按 ⌘Q 或紅色按鈕，不要再疊一個
    let asking = false;
    const unlisten = listen("quit-requested", async () => {
      if (asking) return;
      asking = true;
      try {
        const ids = latest.current.tabs.map((tab) => tab.id);
        const busy = await Promise.all(
          ids.map((id) => invoke<boolean>("pty_is_busy", { id }).catch(() => false)),
        );
        const count = busy.filter(Boolean).length;
        const ok =
          count === 0 ||
          (await ask(t("app.quitBusy", { count }), {
            title: t("app.quitTitle"),
            kind: "warning",
            okLabel: t("app.quitOk"),
            cancelLabel: t("app.cancel"),
          }));
        await invoke(ok ? "confirm_quit" : "cancel_quit");
      } finally {
        asking = false;
      }
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // 全螢幕時 macOS 紅綠燈會隱藏，分頁列不用再預留左側空間
  useEffect(() => {
    const win = getCurrentWindow();
    const update = () => {
      win
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => {});
    };
    update();
    const unlisten = win.onResized(update);
    return () => void unlisten.then((f) => f());
  }, []);

  // agy 沒有結束事件、Claude 也可能當掉：shell 已回到前景就把殘留的燈號清掉
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      for (const [id, status] of Object.entries(latest.current.statuses)) {
        if (status === "off") continue;
        invoke<boolean>("pty_is_busy", { id })
          .then((busy) => {
            if (!busy) sessions.current.get(id)?.clearStaleStatus();
          })
          .catch(() => {});
      }
    }, STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, []);

  // 套用配色：外框的 CSS 變數、新分頁的預設、已開的分頁都換掉，並記住選擇
  useEffect(() => {
    let cancelled = false;
    void resolveTheme(themeId).then((theme) => {
      if (cancelled) return;
      applyUi(theme.ui);
      setDefaultTerminalTheme(theme.terminal);
      for (const s of sessions.current.values()) s.setTheme(theme.terminal);
    });
    try {
      localStorage.setItem(THEME_KEY, themeId);
    } catch {
      // 無法寫入時只是下次不記得
    }
    return () => {
      cancelled = true;
    };
  }, [themeId]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "open" : "closed");
    } catch {
      // 無法寫入時只是下次不記得，不影響使用
    }
    // 側欄開關會改變終端機寬度
    requestAnimationFrame(() => {
      for (const s of sessions.current.values()) s.fit();
    });
  }, [sidebarOpen]);

  useEffect(() => {
    const unlisten = listen<{ id: string }>("pty-exit", (e) => {
      sessions.current.get(e.payload.id)?.handleExit();
    });
    return () => void unlisten.then((f) => f());
  }, []);

  useEffect(() => {
    const refresh = async () => {
      const entries = await Promise.all(
        tabs.map(
          async (t) => [t.id, await invoke<string | null>("git_branch", { path: t.path })] as const,
        ),
      );
      setBranches(Object.fromEntries(entries));
    };
    void refresh();
    // 視窗縮到最小或被蓋住時不輪詢，省電
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, BRANCH_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [tabs]);

  // 只有目前分頁、且視窗在前景時閃游標
  useEffect(() => {
    const update = () => {
      const focused = document.hasFocus();
      for (const [id, s] of sessions.current) s.setBlink(focused && id === activeId);
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    const frame = requestAnimationFrame(() => {
      const session = sessions.current.get(activeId);
      session?.fit();
      session?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const s of sessions.current.values()) s.fit();
      });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  /** 已開過就切過去，否則開新分頁。 */
  const openDir = useCallback((dir: string) => {
    setRecent((prev) => pushRecent(prev, dir));
    const existing = latest.current.tabs.find((t) => t.path === dir);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab = { id: crypto.randomUUID(), path: dir };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  const addTab = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: t("app.pickFolder") });
    if (typeof dir === "string") openDir(dir);
  }, [openDir]);

  const openTypedPath = useCallback(
    async (input: string) => {
      const dir = await invoke<string | null>("resolve_dir", { path: input }).catch(() => null);
      if (!dir) return false;
      openDir(dir);
      return true;
    },
    [openDir],
  );

  /** 在來源分頁右邊開新分頁並切過去，同專案的分頁排在一起。 */
  const insertTabAfter = useCallback((source: Tab, path: string, agent?: AgentId) => {
    const tab: Tab = { id: crypto.randomUUID(), path, ...(agent && { agent }) };
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === source.id);
      return [...prev.slice(0, i + 1), tab, ...prev.slice(i + 1)];
    });
    setActiveId(tab.id);
    return tab;
  }, []);

  /** 在目前專案再開一個分頁：同資料夾，或新的 git worktree。 */
  const duplicateTab = useCallback(
    async (mode: "same" | "worktree") => {
      const { tabs: current, activeId: active } = latest.current;
      const source = current.find((t) => t.id === active);
      if (!source) return;
      let path = source.path;
      if (mode === "worktree") {
        try {
          path = await invoke<string>("create_worktree", { path: source.path });
        } catch (err) {
          await message(translateError(err), { title: t("app.worktreeFailed"), kind: "error" });
          return;
        }
        setRecent((prev) => pushRecent(prev, path));
      }
      insertTabAfter(source, path);
    },
    [insertTabAfter],
  );

  const closePalette = useCallback(() => {
    setPalette(null);
    const { activeId: active } = latest.current;
    // 等 overlay 移除後再把焦點還給終端機
    requestAnimationFrame(() => {
      if (active) sessions.current.get(active)?.focus();
    });
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const busy = await invoke<boolean>("pty_is_busy", { id }).catch(() => false);
    if (
      busy &&
      !(await ask(t("app.closeBusy"), {
        title: t("app.closeTab"),
        kind: "warning",
      }))
    ) {
      return;
    }
    sessions.current.get(id)?.dispose();
    sessions.current.delete(id);
    const { tabs: current, activeId: active } = latest.current;
    setTabs(current.filter((t) => t.id !== id));
    setStatuses(({ [id]: _closed, ...rest }) => rest);
    setActiveId(activeAfterClose(current, id, active));
  }, []);

  /**
   * 啟動／接續 agent，或在閒置的 Claude 裡新對話／切換對話。
   * 分頁被占用時明確選了 agent，就在右邊開一個同資料夾的新分頁執行。
   * 在這個分頁啟動時，選的 agent 會記成這個分頁的預設。
   */
  const agentAction = useCallback(
    async (intent: AgentIntent, chosen?: AgentId) => {
      const { activeId: active, tabs: current, statuses: st, runningAgents: ra } = latest.current;
      const session = active ? sessions.current.get(active) : undefined;
      const tab = current.find((t) => t.id === active);
      if (!session || !active || !tab) return;
      const busy = await invoke<boolean>("pty_is_busy", { id: session.id }).catch(() => false);
      let status = st[active] ?? "off";
      if (status !== "off" && !busy) {
        // 燈號殘留（agent 其實已經結束），當成沒有 agent 處理
        session.clearStaleStatus();
        status = "off";
      }
      const preferred = preferredAgent(tab.agent, latest.current.installed);
      const step = agentStep(status, ra[active] ?? "claude", busy, intent, chosen, preferred);
      if (step.kind === "shell") {
        if (chosen && tab.agent !== chosen) {
          setTabs((prev) => prev.map((t) => (t.id === active ? { ...t, agent: chosen } : t)));
        }
        session.launched(chosen ?? preferred);
        if (intent === "resume" && (chosen ?? preferred) === "claude") session.watchResume();
        session.run(step.command);
      } else if (step.kind === "agent") session.run(step.command);
      else if (step.kind === "new-tab") {
        const created = insertTabAfter(tab, tab.path, step.agent);
        const target = sessionFor(created);
        target.launched(step.agent);
        if (intent === "resume" && step.agent === "claude") target.watchResume();
        target.runWhenReady(step.command);
      } else session.focus();
    },
    [sessionFor, insertTabAfter],
  );

  const onAgentMenuOpen = useCallback(() => detectRef.current(true), []);

  /** 在目前分頁右邊開新分頁，打好官方安裝指令，讓使用者確認後按 Enter。 */
  const installAgent = useCallback(
    (agent: AgentId) => {
      const { tabs: current, activeId: active } = latest.current;
      const tab = current.find((t) => t.id === active);
      if (!tab) return;
      const created = insertTabAfter(tab, tab.path);
      sessionFor(created).typeWhenReady(AGENTS[agent].installCommand);
    },
    [insertTabAfter, sessionFor],
  );

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    const { activeId: active } = latest.current;
    requestAnimationFrame(() => {
      if (active) sessions.current.get(active)?.focus();
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcutAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      const { tabs: current, activeId: active } = latest.current;
      if (action.type === "palette") setPalette((p) => (p ? null : "all"));
      else if (action.type === "duplicate") {
        if (active) setPalette("duplicate");
      } else if (action.type === "help") setHelpOpen((o) => !o);
      else if (action.type === "move") {
        const index = current.findIndex((t) => t.id === active);
        if (active && index !== -1) setTabs((prev) => moveTab(prev, active, index + action.delta));
      } else if (action.type === "sidebar") setSidebarOpen((o) => !o);
      else if (action.type === "new") void addTab();
      else if (action.type === "close") {
        if (active) void closeTab(active);
      } else {
        const next = resolveSelect(current, active, action);
        if (next) setActiveId(next);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [addTab, closeTab]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  const activeStatus = activeId ? (statuses[activeId] ?? "off") : "off";
  const activeRunning = activeId ? (runningAgents[activeId] ?? "claude") : "claude";
  const activePreferred = preferredAgent(activeTab?.agent, installed);

  const duplicateActions = useMemo<PaletteAction[]>(
    () => [
      {
        id: "dup-same",
        label: t("app.dupSame"),
        run: () => void duplicateTab("same"),
      },
      {
        id: "dup-worktree",
        label: t("app.dupWorktree"),
        run: () => void duplicateTab("worktree"),
      },
    ],
    [duplicateTab],
  );

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: "sidebar",
        label: sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar"),
        hint: "⌘B",
        run: () => setSidebarOpen((o) => !o),
      },
      { id: "help", label: t("app.shortcutHelp"), hint: "⌘/", run: () => setHelpOpen(true) },
      ...THEME_IDS.map((id) => ({
        id: `theme-${id}`,
        label: t("theme.pick", { name: t(THEME_NAME_KEY[id]) }),
        hint: id === themeId ? "✓" : undefined,
        run: () => setThemeId(id),
      })),
    ];
    if (activeTab) {
      for (const target of ["vscode", "antigravity", "finder"] as OpenTarget[]) {
        if (!isAppAvailable(target, apps)) continue;
        list.push({
          id: `open-${target}`,
          label: t("app.openIn", { app: OPEN_TARGET_LABEL[target] }),
          run: () => void openIn(activeTab.path, target),
        });
      }
      const mode = buttonMode(activeStatus, activeRunning);
      if (mode === "launch") {
        for (const agent of installed) {
          const { label, start, resume } = AGENTS[agent];
          list.push(
            {
              id: `start-${agent}`,
              label: t("app.run", { agent: label, cmd: start }),
              run: () => void agentAction("new", agent),
            },
            {
              id: `resume-${agent}`,
              label: t("app.resumePast", { agent: label, cmd: resume }),
              run: () => void agentAction("resume", agent),
            },
          );
        }
      } else {
        if (mode === "claude-session") {
          list.push(
            {
              id: "claude-new",
              label: t("app.claudeNew"),
              run: () => void agentAction("new"),
            },
            {
              id: "claude-resume",
              label: t("app.claudeSwitch"),
              run: () => void agentAction("resume"),
            },
          );
        }
        for (const agent of installed) {
          const { label, start } = AGENTS[agent];
          list.push({
            id: `new-tab-${agent}`,
            label: t("app.runInNewTab", { agent: label, cmd: start }),
            run: () => void agentAction("new", agent),
          });
        }
      }
      list.push(
        ...duplicateActions.map((a) => ({ ...a, label: t("app.anotherTab", { label: a.label }) })),
        {
          id: "close-tab",
          label: t("app.closeCurrent"),
          hint: "⌘W",
          run: () => void closeTab(activeTab.id),
        },
      );
    }
    return list;
  }, [
    activeTab,
    apps,
    activeStatus,
    activeRunning,
    installed,
    sidebarOpen,
    themeId,
    agentAction,
    closeTab,
    duplicateActions,
  ]);

  return (
    <div className="flex h-full flex-col">
      <TabBar
        tabs={tabs}
        activeId={activeId}
        labels={labels}
        branches={branches}
        statuses={statuses}
        runningAgents={runningAgents}
        preferredAgent={activePreferred}
        installed={installed}
        fullscreen={fullscreen}
        onSelect={setActiveId}
        onMove={(id, toIndex) => setTabs((prev) => moveTab(prev, id, toIndex))}
        onClose={(id) => void closeTab(id)}
        onAdd={() => void addTab()}
        onHelp={() => setHelpOpen(true)}
        onAgent={(intent, agent) => void agentAction(intent, agent)}
        onInstallAgent={installAgent}
        onAgentMenuOpen={onAgentMenuOpen}
      />
      <div className="flex min-h-0 flex-1">
        <main ref={stageRef} className="relative min-h-0 min-w-0 flex-1">
          {tabs.map((tab) => (
            <TerminalHost key={tab.id} session={sessionFor(tab)} active={tab.id === activeId} />
          ))}
          {loaded && tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-deck-muted">
              <p className="text-sm">{t("app.emptyTitle")}</p>
              <button
                type="button"
                onClick={() => void addTab()}
                className="flex items-center gap-2 rounded-lg border border-deck-border bg-deck-panel px-4 py-2 text-sm text-deck-text hover:bg-deck-hover"
              >
                <FolderOpen size={16} />
                {t("app.openFolder")}
                <kbd className="ml-1 text-xs text-deck-muted">⌘T</kbd>
              </button>
              {/* 新裝好還沒有專案時，也能先當一般終端機用（開在家目錄） */}
              <button
                type="button"
                onClick={() => void openTypedPath("~")}
                className="-mt-1 text-xs text-deck-muted underline-offset-2 hover:text-deck-text hover:underline"
              >
                {t("app.justTerminal")}
              </button>
              <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
                {[
                  ["⌘K", t("app.emptySearch")],
                  ["⌘B", t("app.emptySidebar")],
                  ["⌘/", t("app.emptyAll")],
                ].map(([keys, desc]) => (
                  <div key={keys} className="contents">
                    <dt className="text-right font-mono text-deck-text">{keys}</dt>
                    <dd>{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </main>
        {sidebarOpen && activeTab && (
          <Sidebar tab={activeTab} status={statuses[activeTab.id] ?? "off"} apps={apps} />
        )}
      </div>
      {palette && (
        <CommandPalette
          tabs={tabs}
          labels={labels}
          only={
            palette === "duplicate"
              ? { placeholder: t("app.dupPlaceholder"), actions: duplicateActions }
              : undefined
          }
          recent={recent}
          actions={paletteActions}
          statuses={statuses}
          runningAgents={runningAgents}
          branches={branches}
          onSelectTab={setActiveId}
          onOpenPath={openTypedPath}
          onBrowse={() => void addTab()}
          onClose={closePalette}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={closeHelp} />}
    </div>
  );
}
