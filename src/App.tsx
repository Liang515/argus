import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import type { Update } from "@tauri-apps/plugin-updater";
import { FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { RecapPanel } from "./components/RecapPanel";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { type ActivityState, applyActivity, EMPTY_ACTIVITY } from "./lib/activity";
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
import { type CustomAgent, parseCustomAgents } from "./lib/customAgents";
import { nextFontSize, parseFontSize } from "./lib/fontSize";
import { pushRecent } from "./lib/fuzzy";
import { type HandoffPhase, handoffNext, isHandoffPrompt } from "./lib/handoff";
import { keys, type Lang, lang, setLang, t, translateError } from "./lib/i18n";
import { isMac } from "./lib/platform";
import {
  type EditorInfo,
  loadPreferredEditor,
  openIn,
  pickEditor,
  savePreferredEditor,
} from "./lib/project";
import { mergeRecaps, noteActivity, noteStatus, type ProjectRecap, parseRecaps } from "./lib/recap";
import type { ClaudeStatus } from "./lib/status";
import {
  activeAfterClose,
  moveTab,
  resolveSelect,
  shortcutAction,
  type Tab,
  tabLabels,
} from "./lib/tabs";
import {
  setDefaultFontSize,
  setDefaultTerminalTheme,
  TerminalSession,
} from "./lib/terminalSession";
import {
  applyUi,
  BUILT_IN,
  isLight,
  isThemeId,
  THEME_IDS,
  type Theme,
  type ThemeId,
  themeFromTerminal,
} from "./lib/themes";
import { findUpdate, installAndRelaunch, UPDATE_CHECK_MS } from "./lib/updates";

interface Workspace {
  tabs: Tab[];
  activeId: string | null;
  recent: string[];
}

const BRANCH_REFRESH_MS = 5000;
const STALE_CHECK_MS = 2000;
const DETECT_THROTTLE_MS = 5000;
const DETECT_RELAXED_MS = 60_000;
/** 近況紀錄變動後多久存檔：agent 連續動作時不要每一步都寫檔。 */
const RECAP_SAVE_DELAY_MS = 1500;
const SIDEBAR_KEY = "argus.sidebar";
const THEME_KEY = "argus.theme";
const FONT_SIZE_KEY = "argus.fontSize";

function loadFontSize(): number {
  try {
    return parseFontSize(localStorage.getItem(FONT_SIZE_KEY));
  } catch {
    return parseFontSize(null);
  }
}

function loadThemePref(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    // 「跟隨終端機」讀的是 macOS「終端機」App 的設定，其他平台沒有
    if (saved === "terminal-app" && !isMac) return "argus";
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
  const [activities, setActivities] = useState<Record<string, ActivityState>>({});
  // 正在交接的分頁（送出了交接指令，還沒清除或取消）
  const [handoffs, setHandoffs] = useState<Record<string, HandoffPhase>>({});
  const [installed, setInstalled] = useState<AgentId[]>(["claude"]);
  // 有安裝的編輯器；null 表示還沒偵測完
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  // 介面語言；改了之後整個畫面重畫，t() 就會用新的語言
  const [uiLang, setUiLang] = useState<Lang>(lang);
  const switchLang = useCallback((next: Lang) => {
    setLang(next);
    setUiLang(next);
  }, []);
  // ~/.argus/agents.json 很小，每次打開選單、切回 Argus 都重讀，改了馬上生效
  const loadCustomAgents = useCallback(() => {
    void invoke<string | null>("read_custom_agents")
      .then((text) => setCustomAgents(text ? parseCustomAgents(text) : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadCustomAgents();
    window.addEventListener("focus", loadCustomAgents);
    return () => window.removeEventListener("focus", loadCustomAgents);
  }, [loadCustomAgents]);
  const [editorId, setEditorId] = useState(loadPreferredEditor);
  const editor = pickEditor(editorId, editors ?? []);
  const chooseEditor = useCallback((id: string) => {
    setEditorId(id);
    savePreferredEditor(id);
  }, []);
  const detectRef = useRef<(force?: boolean) => void>(() => {});
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // all：一般切換器；duplicate：⌘⇧T 選擇怎麼在同專案再開分頁
  const [palette, setPalette] = useState<"all" | "duplicate" | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  const [recaps, setRecaps] = useState<ProjectRecap[]>([]);
  const [recapLoaded, setRecapLoaded] = useState(false);
  const recapLoadedRef = useRef(false);
  recapLoadedRef.current = recapLoaded;
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarPref);
  const [themeId, setThemeId] = useState<ThemeId>(loadThemePref);
  const [fontSize, setFontSize] = useState(loadFontSize);
  // 背景是淺色時，側欄的 Markdown 與 Git 狀態要換成深色字
  const [lightUi, setLightUi] = useState(false);
  const sessions = useRef(new Map<string, TerminalSession>());
  const stageRef = useRef<HTMLDivElement>(null);
  // 已經寫進 recap.json 的內容；一樣就不重寫（例如剛讀完檔）
  const savedRecaps = useRef<string | null>(null);
  const overlays = { palette, recapOpen, helpOpen };
  const latest = useRef({ tabs, activeId, statuses, runningAgents, installed, recaps, overlays });
  latest.current = { tabs, activeId, statuses, runningAgents, installed, recaps, overlays };

  const sessionFor = useCallback((tab: Tab) => {
    let session = sessions.current.get(tab.id);
    if (!session) {
      session = new TerminalSession(
        tab.id,
        tab.path,
        (id, status, agent) => {
          setStatuses((prev) => ({ ...prev, [id]: status }));
          setRunningAgents((prev) => ({ ...prev, [id]: agent }));
          setRecaps((prev) => noteStatus(prev, tab.path, status, agent, Date.now()));
          setHandoffs((prev) => {
            const current = prev[id];
            if (!current) return prev;
            const next = handoffNext(current, status);
            if (next === current) return prev;
            const { [id]: _done, ...rest } = prev;
            return next ? { ...rest, [id]: next } : rest;
          });
        },
        (id, event, agent) => {
          setActivities((prev) => ({
            ...prev,
            [id]: applyActivity(prev[id] ?? EMPTY_ACTIVITY, event, Date.now()),
          }));
          setRecaps((prev) => noteActivity(prev, tab.path, event, Date.now(), agent));
          if (event.k === "prompt" && isHandoffPrompt(event.text)) {
            setHandoffs((prev) => (prev[id] === "writing" ? prev : { ...prev, [id]: "writing" }));
          }
        },
      );
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

  // 讀檔失敗（例如找不到家目錄）就整次不存，避免用空清單蓋掉舊紀錄
  useEffect(() => {
    invoke<string | null>("recap_load")
      .then((json) => {
        // 沒有存檔時當成已存了空清單，沒有紀錄就不建檔
        savedRecaps.current = json ?? "[]";
        setRecaps((prev) => mergeRecaps(parseRecaps(json), prev));
        setRecapLoaded(true);
      })
      .catch(() => {});
  }, []);

  const saveRecaps = useCallback(() => {
    const json = JSON.stringify(latest.current.recaps);
    if (json === savedRecaps.current) return Promise.resolve();
    savedRecaps.current = json;
    return invoke("recap_save", { json }).catch(() => {
      savedRecaps.current = null;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: recaps 一變就重新排程存檔，內容由 saveRecaps 從 latest 讀
  useEffect(() => {
    if (!recapLoaded) return;
    const timer = setTimeout(() => void saveRecaps(), RECAP_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [recaps, recapLoaded, saveRecaps]);

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
        invoke<{ installed: EditorInfo[]; total: number }>("detect_apps"),
      ])
        .then(([agents, editors]) => {
          setInstalled(agents);
          setEditors(editors.installed);
          hasAgent = agents.length > 0;
          complete =
            agents.length === AGENT_IDS.length && editors.installed.length === editors.total;
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
        // 還在等存檔的近況先寫進去，否則最後幾秒的動作會漏掉
        if (ok && recapLoadedRef.current) await saveRecaps();
        await invoke(ok ? "confirm_quit" : "cancel_quit");
      } finally {
        asking = false;
      }
    });
    return () => void unlisten.then((f) => f());
  }, [saveRecaps]);

  // 檢查新版：啟動時一次，之後每 6 小時。只看正式發佈的版本（草稿不會推送）
  useEffect(() => {
    const run = () => void findUpdate().then((found) => found && setUpdate(found));
    run();
    const timer = setInterval(run, UPDATE_CHECK_MS);
    return () => clearInterval(timer);
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

  // 字體大小：所有分頁一起變，新分頁也用這個大小，並記住
  useEffect(() => {
    setDefaultFontSize(fontSize);
    for (const s of sessions.current.values()) s.setFontSize(fontSize);
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // 無法寫入時只是下次不記得
    }
  }, [fontSize]);

  // 套用配色：外框的 CSS 變數、新分頁的預設、已開的分頁都換掉，並記住選擇
  useEffect(() => {
    let cancelled = false;
    void resolveTheme(themeId).then((theme) => {
      if (cancelled) return;
      applyUi(theme.ui);
      setLightUi(isLight(theme.ui.bg));
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

  // Windows 的 hook 經 named pipe 回報，後端轉成這個事件（macOS 的走終端機輸出）
  useEffect(() => {
    const unlisten = listen<{ id: string; osc: string[] }>("argus-hook", (e) => {
      const session = sessions.current.get(e.payload.id);
      for (const osc of e.payload.osc) session?.handleHookOsc(osc);
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

  /** 等 overlay 移除後把焦點還給終端機；期間又開了別的面板（例如從 ⌘K 開近況）就不搶。 */
  const refocusTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      const { activeId: active, overlays: o } = latest.current;
      if (active && o.palette === null && !o.recapOpen && !o.helpOpen) {
        sessions.current.get(active)?.focus();
      }
    });
  }, []);

  const closePalette = useCallback(() => {
    setPalette(null);
    refocusTerminal();
  }, [refocusTerminal]);

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
    setActivities(({ [id]: _gone, ...rest }) => rest);
    setHandoffs(({ [id]: _gone, ...rest }) => rest);
    setActiveId(activeAfterClose(current, id, active));
  }, []);

  /**
   * 啟動／接續 agent，或在閒置的 agent 裡新對話／切換對話。
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

  /**
   * ⌘K 的交接：替使用者送出交接指令，之後和自己打「交接」一樣由 hook 回報的訊息接手。
   * 寫完後分頁列會出現「清除對話」，一定要使用者按了才送 /clear（讓人先看過交接內容，漏寫還能補）。
   * 送的是一句話而不是 /handoff：沒有 handoff skill 的人也能照專案的交接規則做。
   */
  const startHandoff = useCallback(async () => {
    const { activeId: active, statuses: st, runningAgents: ra } = latest.current;
    const session = active ? sessions.current.get(active) : undefined;
    if (!session || !active) return;
    const busy = await invoke<boolean>("pty_is_busy", { id: session.id }).catch(() => false);
    if (!busy || buttonMode(st[active] ?? "off", ra[active] ?? "claude") !== "session") return;
    session.run(t("agent.handoffPrompt"));
  }, []);

  const cancelHandoff = useCallback(() => {
    const active = latest.current.activeId;
    if (active) setHandoffs(({ [active]: _gone, ...rest }) => rest);
    refocusTerminal();
  }, [refocusTerminal]);

  /** 交接後清除：Claude 先留記號，清除後的新對話才會被提醒先讀 HANDOFF.md（見 handoff.rs）。 */
  const clearAfterHandoff = useCallback(async () => {
    const { activeId: active, runningAgents: ra } = latest.current;
    if (!active) return;
    setHandoffs(({ [active]: _gone, ...rest }) => rest);
    if ((ra[active] ?? "claude") === "claude") {
      await invoke("handoff_mark", { id: active }).catch(() => {});
    }
    await agentAction("new");
  }, [agentAction]);

  /** 自訂指令：分頁空著就在這裡打，被占用就在右邊開新分頁，和內建 agent 一樣。 */
  const customAction = useCallback(
    async (agent: CustomAgent) => {
      const { activeId: active, tabs: current, statuses: st } = latest.current;
      const session = active ? sessions.current.get(active) : undefined;
      const tab = current.find((t) => t.id === active);
      if (!session || !active || !tab) return;
      const busy = await invoke<boolean>("pty_is_busy", { id: session.id }).catch(() => false);
      if (!busy) {
        if ((st[active] ?? "off") !== "off") session.clearStaleStatus();
        if (agent.base) session.launched(agent.base);
        session.run(agent.command);
        return;
      }
      const target = sessionFor(insertTabAfter(tab, tab.path));
      if (agent.base) target.launched(agent.base);
      target.runWhenReady(agent.command);
    },
    [sessionFor, insertTabAfter],
  );

  const editCustomAgents = useCallback(() => {
    void invoke("edit_custom_agents", { lang }).catch(async (err) => {
      await message(t("custom.editFailed", { err: translateError(err) }), {
        title: t("open.failedTitle"),
        kind: "error",
      });
    });
  }, []);

  const onAgentMenuOpen = useCallback(() => {
    detectRef.current(true);
    loadCustomAgents();
  }, [loadCustomAgents]);

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

  /** 更新會重開 Argus：有分頁在跑程式時先確認（和 ⌘Q 一樣的考量）。 */
  const applyUpdate = useCallback(async () => {
    if (!update || updating) return;
    const ids = latest.current.tabs.map((tab) => tab.id);
    const busy = await Promise.all(
      ids.map((id) => invoke<boolean>("pty_is_busy", { id }).catch(() => false)),
    );
    const count = busy.filter(Boolean).length;
    if (
      count > 0 &&
      !(await ask(t("update.busy", { count }), {
        title: t("update.title", { version: update.version }),
        kind: "warning",
        okLabel: t("update.ok"),
        cancelLabel: t("app.cancel"),
      }))
    ) {
      return;
    }
    setUpdating(true);
    try {
      await installAndRelaunch(update);
    } catch (err) {
      setUpdating(false);
      await message(String(err), { title: t("update.failed"), kind: "error" });
    }
  }, [update, updating]);

  const closeRecap = useCallback(() => {
    setRecapOpen(false);
    refocusTerminal();
  }, [refocusTerminal]);

  /** 近況裡選了專案：有開著的分頁就切過去，否則重新開一個（資料夾不在了回傳 false）。 */
  const openRecap = useCallback(
    async (path: string, tabId: string | null) => {
      if (!tabId) return openTypedPath(path);
      setActiveId(tabId);
      return true;
    },
    [openTypedPath],
  );

  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    refocusTerminal();
  }, [refocusTerminal]);

  /** 面板一次只開一個：開新的就關掉其他的。 */
  const showOverlay = useCallback((kind: "all" | "duplicate" | "recap" | "help") => {
    setPalette(kind === "all" || kind === "duplicate" ? kind : null);
    setRecapOpen(kind === "recap");
    setHelpOpen(kind === "help");
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = shortcutAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      const { tabs: current, activeId: active } = latest.current;
      const {
        palette: openPalette,
        recapOpen: openRecapPanel,
        helpOpen: openHelp,
      } = latest.current.overlays;
      if (action.type === "palette") {
        if (openPalette) closePalette();
        else showOverlay("all");
      } else if (action.type === "recap") {
        if (openRecapPanel) closeRecap();
        else showOverlay("recap");
      } else if (action.type === "duplicate") {
        if (active) showOverlay("duplicate");
      } else if (action.type === "help") {
        if (openHelp) closeHelp();
        else showOverlay("help");
      } else if (action.type === "move") {
        const index = current.findIndex((t) => t.id === active);
        if (active && index !== -1) setTabs((prev) => moveTab(prev, active, index + action.delta));
      } else if (action.type === "zoom") {
        const delta = action.delta;
        setFontSize((size) => nextFontSize(size, delta));
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
  }, [addTab, closeTab, closePalette, closeRecap, closeHelp, showOverlay]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  const activeStatus = activeId ? (statuses[activeId] ?? "off") : "off";
  const activeRunning = activeId ? (runningAgents[activeId] ?? "claude") : "claude";
  const activePreferred = preferredAgent(activeTab?.agent, installed);
  const activeHandoff = activeId ? handoffs[activeId] : undefined;

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
        hint: keys("⌘B"),
        run: () => setSidebarOpen((o) => !o),
      },
      { id: "recap", label: t("recap.title"), hint: keys("⌘J"), run: () => showOverlay("recap") },
      {
        id: "help",
        label: t("app.shortcutHelp"),
        hint: keys("⌘/"),
        run: () => showOverlay("help"),
      },
      { id: "custom-edit", label: t("custom.edit"), run: editCustomAgents },
      // 兩種語言都寫，用哪種語言搜尋都找得到
      ...(
        [
          ["zh-TW", "繁體中文"],
          ["en", "English"],
        ] as const
      ).map(([id, name]) => ({
        id: `lang-${id}`,
        label: `語言 / Language：${name}`,
        hint: id === uiLang ? "✓" : undefined,
        run: () => switchLang(id),
      })),
      {
        id: "zoom-in",
        label: t("app.zoomIn"),
        hint: keys("⌘+"),
        run: () => setFontSize((n) => nextFontSize(n, 1)),
      },
      {
        id: "zoom-out",
        label: t("app.zoomOut"),
        hint: keys("⌘−"),
        run: () => setFontSize((n) => nextFontSize(n, -1)),
      },
      {
        id: "zoom-reset",
        label: t("app.zoomReset"),
        hint: keys("⌘0"),
        run: () => setFontSize((n) => nextFontSize(n, 0)),
      },
      ...THEME_IDS.filter((id) => isMac || id !== "terminal-app").map((id) => ({
        id: `theme-${id}`,
        label: t("theme.pick", { name: t(THEME_NAME_KEY[id]) }),
        hint: id === themeId ? "✓" : undefined,
        run: () => setThemeId(id),
      })),
    ];
    if (activeTab) {
      for (const { id, label } of [...(editors ?? []), { id: "finder", label: keys("Finder") }]) {
        list.push({
          id: `open-${id}`,
          label: t("app.openIn", { app: label }),
          run: () => {
            if (id !== "finder") chooseEditor(id);
            void openIn(activeTab.path, id, label);
          },
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
        const inSession = AGENTS[activeRunning].inSession;
        const agentLabel = AGENTS[activeRunning].label;
        if (activeHandoff && inSession) {
          if (activeHandoff === "confirm" && mode === "session") {
            list.push({
              id: "handoff-clear",
              label: t("app.handoffClear", { agent: agentLabel, cmd: inSession.newChat }),
              run: () => void clearAfterHandoff(),
            });
          }
          list.push({ id: "handoff-cancel", label: t("app.handoffCancel"), run: cancelHandoff });
        } else if (mode === "session" && inSession) {
          list.push(
            {
              id: "agent-new",
              label: t("app.agentNew", { agent: agentLabel, cmd: inSession.newChat }),
              run: () => void agentAction("new"),
            },
            {
              id: "agent-resume",
              label: t("app.agentSwitch", { agent: agentLabel, cmd: inSession.switchChat }),
              run: () => void agentAction("resume"),
            },
            {
              id: "agent-handoff",
              label: t("app.agentHandoff", { agent: agentLabel }),
              run: () => void startHandoff(),
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
      for (const agent of customAgents) {
        list.push({
          id: `custom-${agent.name}`,
          label: t("custom.run", { name: agent.name, cmd: agent.command }),
          run: () => void customAction(agent),
        });
      }
      list.push(
        ...duplicateActions.map((a) => ({ ...a, label: t("app.anotherTab", { label: a.label }) })),
        {
          id: "close-tab",
          label: t("app.closeCurrent"),
          hint: keys("⌘W"),
          run: () => void closeTab(activeTab.id),
        },
      );
    }
    return list;
  }, [
    activeTab,
    editors,
    chooseEditor,
    customAgents,
    customAction,
    editCustomAgents,
    uiLang,
    switchLang,
    activeStatus,
    activeRunning,
    activeHandoff,
    startHandoff,
    clearAfterHandoff,
    cancelHandoff,
    installed,
    sidebarOpen,
    themeId,
    agentAction,
    closeTab,
    duplicateActions,
    showOverlay,
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
        onHelp={() => showOverlay("help")}
        onAgent={(intent, agent) => void agentAction(intent, agent)}
        onInstallAgent={installAgent}
        onAgentMenuOpen={onAgentMenuOpen}
        customAgents={customAgents}
        onCustomAgent={(agent) => void customAction(agent)}
        handoff={activeHandoff}
        onHandoffClear={() => void clearAfterHandoff()}
        onHandoffCancel={cancelHandoff}
        updateVersion={update?.version ?? null}
        updating={updating}
        onUpdate={() => void applyUpdate()}
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
                <kbd className="ml-1 text-xs text-deck-muted">{keys("⌘T")}</kbd>
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
                  [keys("⌘K"), t("app.emptySearch")],
                  [keys("⌘J"), t("app.emptyRecap")],
                  [keys("⌘B"), t("app.emptySidebar")],
                  [keys("⌘/"), t("app.emptyAll")],
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
          <Sidebar
            tab={activeTab}
            status={statuses[activeTab.id] ?? "off"}
            editors={editors}
            editor={editor}
            onPickEditor={chooseEditor}
            activity={activities[activeTab.id] ?? EMPTY_ACTIVITY}
            light={lightUi}
          />
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
      {recapOpen && (
        <RecapPanel
          recaps={recaps}
          tabs={tabs}
          statuses={statuses}
          runningAgents={runningAgents}
          branches={branches}
          onOpen={openRecap}
          onClose={closeRecap}
        />
      )}
      {helpOpen && <ShortcutHelp onClose={closeHelp} />}
    </div>
  );
}
