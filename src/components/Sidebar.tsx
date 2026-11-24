import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  Code2,
  Download,
  FileText,
  FolderOpen,
  NotebookPen,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ActivityState } from "../lib/activity";
import { keys, lang, type MessageKey, t, translateError } from "../lib/i18n";
import {
  changeBadge,
  EDITOR_DOWNLOAD,
  type EditorInfo,
  type GitChange,
  needsHandoffProtocol,
  openIn,
  type ProjectDoc,
  splitPath,
} from "../lib/project";
import type { ClaudeStatus } from "../lib/status";
import type { Tab } from "../lib/tabs";
import { ActivityPanel } from "./ActivityPanel";

const GIT_POLL_MS = 5000;
const DEBOUNCE_MS = 300;

const TONE_CLASS = {
  added: "text-[#9ece6a]",
  modified: "text-[#e5c07b]",
  deleted: "text-[#f07178]",
  renamed: "text-[#61afef]",
  conflict: "text-[#f07178] font-bold",
} as const;

/** 淺色背景用的較深色，亮黃、亮綠在白底上看不清楚。 */
const TONE_CLASS_LIGHT: Record<keyof typeof TONE_CLASS, string> = {
  added: "text-[#2e7d32]",
  modified: "text-[#9a6700]",
  deleted: "text-[#c62828]",
  renamed: "text-[#1565c0]",
  conflict: "text-[#c62828] font-bold",
};

type View = "activity" | "changes" | "handoff";

const VIEWS: { id: View; label: MessageKey }[] = [
  { id: "activity", label: "side.tabActivity" },
  { id: "changes", label: "side.tabChanges" },
  { id: "handoff", label: "side.tabHandoff" },
];

interface Props {
  tab: Tab;
  status: ClaudeStatus;
  activity: ActivityState;
  /** 背景是淺色（「跟隨終端機」用了白底配色） */
  light: boolean;
  /** 有安裝的編輯器（null：還沒偵測完） */
  editors: EditorInfo[] | null;
  /** 目前選用的編輯器 */
  editor: EditorInfo | null;
  onPickEditor: (id: string) => void;
}

export function Sidebar({ tab, status, editors, editor, onPickEditor, activity, light }: Props) {
  const tones = light ? TONE_CLASS_LIGHT : TONE_CLASS;
  const [view, setView] = useState<View>("activity");
  const { id, path } = tab;
  // undefined：載入中；null：不是 git repo
  const [changes, setChanges] = useState<GitChange[] | null | undefined>(undefined);
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const timers = useRef<{ doc?: number; git?: number }>({});

  const refreshGit = useCallback(async () => {
    setRefreshing(true);
    try {
      setChanges(await invoke<GitChange[] | null>("git_status", { path }));
    } catch {
      setChanges(null);
    } finally {
      setRefreshing(false);
    }
  }, [path]);

  const refreshDoc = useCallback(async () => {
    setDoc(await invoke<ProjectDoc | null>("read_project_doc", { path }).catch(() => null));
  }, [path]);

  useEffect(() => {
    setChanges(undefined);
    setDoc(null);
    void refreshGit();
    void refreshDoc();
    void invoke("watch_project", { id, path }).catch(() => {});
    const debounce = (key: "doc" | "git", fn: () => void) => {
      window.clearTimeout(timers.current[key]);
      timers.current[key] = window.setTimeout(fn, DEBOUNCE_MS);
    };
    const unlisten = listen<{ id: string; doc: boolean; git: boolean }>(
      "project-changed",
      ({ payload }) => {
        if (payload.id !== id) return;
        if (payload.doc) debounce("doc", () => void refreshDoc());
        if (payload.git) debounce("git", () => void refreshGit());
      },
    );
    // 工作目錄的檔案改動不會觸發 .git 事件，所以再定期刷新
    const poll = window.setInterval(() => {
      if (!document.hidden) void refreshGit();
    }, GIT_POLL_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(timers.current.doc);
      window.clearTimeout(timers.current.git);
      void unlisten.then((f) => f());
      void invoke("unwatch_project", { id }).catch(() => {});
    };
  }, [id, path, refreshGit, refreshDoc]);

  // Claude 每完成一步（狀態改變）就更新變更清單
  // biome-ignore lint/correctness/useExhaustiveDependencies: status 只用來觸發刷新
  useEffect(() => {
    void refreshGit();
  }, [status, refreshGit]);

  return (
    <aside className="flex w-[clamp(260px,26%,420px)] shrink-0 flex-col border-l border-deck-border bg-deck-panel text-[12.5px]">
      <section className="flex gap-1 border-b border-deck-border p-2">
        <EditorButton path={path} editors={editors} editor={editor} onPick={onPickEditor} />
        <button
          type="button"
          onClick={() => void openIn(path, "finder", keys("Finder"))}
          title={t("side.openWith", { app: keys("Finder") })}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-deck-muted hover:bg-deck-hover hover:text-deck-text"
        >
          <FolderOpen size={14} />
          {keys("Finder")}
        </button>
      </section>

      <div className="mx-2.5 mt-2 mb-1 flex rounded-md bg-deck-bg p-0.5 text-[12px]">
        {VIEWS.map(({ id: v, label }) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`flex flex-1 items-center justify-center gap-1 rounded py-1 ${
              view === v
                ? "bg-deck-hover text-deck-text shadow-[inset_0_0_0_1px_var(--color-deck-border)]"
                : "text-deck-muted hover:text-deck-text"
            }`}
          >
            {t(label)}
            {v === "changes" && changes ? ` · ${changes.length}` : ""}
            {v === "activity" && status === "running" && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-running" />
            )}
          </button>
        ))}
      </div>

      {view === "activity" && <ActivityPanel activity={activity} />}

      {view === "changes" && (
        <section className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold tracking-wide text-deck-muted uppercase">
            <span>
              {t("side.gitChanges")}
              {changes ? ` · ${changes.length}` : ""}
            </span>
            <button
              type="button"
              aria-label={t("side.refreshGit")}
              onClick={() => void refreshGit()}
              className="rounded p-1 hover:bg-deck-hover hover:text-deck-text"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            </button>
          </header>
          <ul className="min-h-0 overflow-y-auto px-1.5 pb-2">
            {changes === undefined && (
              <li className="px-1.5 text-deck-muted">{t("side.loading")}</li>
            )}
            {changes === null && <li className="px-1.5 text-deck-muted">{t("side.notRepo")}</li>}
            {changes?.length === 0 && (
              <li className="px-1.5 text-deck-muted">{t("side.noChanges")}</li>
            )}
            {changes?.map((c) => {
              const badge = changeBadge(c.code);
              const { dir, name } = splitPath(c.path);
              return (
                <li
                  key={`${c.code}${c.path}`}
                  title={c.path}
                  className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-deck-hover"
                >
                  <span className={`w-3 shrink-0 text-center font-mono ${tones[badge.tone]}`}>
                    {badge.label}
                  </span>
                  <span className="truncate">
                    <span className="text-deck-text">{name}</span>
                    {dir && <span className="ml-1.5 text-deck-muted">{dir}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {view === "handoff" && (
        <section className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold tracking-wide text-deck-muted uppercase">
            <FileText size={12} />
            {doc?.name ?? "HANDOFF.md / CLAUDE.md"}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 select-text">
            {needsHandoffProtocol(doc) && (
              <div className="mb-3 rounded-md border border-deck-border bg-deck-bg p-2.5 select-none">
                <p className="text-deck-muted">{t("side.handoffPitch")}</p>
                <button
                  type="button"
                  onClick={() => {
                    setAddError(null);
                    invoke("add_handoff_protocol", { path, lang })
                      .then(() => refreshDoc())
                      .catch((e) => setAddError(translateError(e)));
                  }}
                  title={t("side.handoffTitle")}
                  className="mt-2 flex items-center gap-1.5 rounded-md bg-deck-hover px-2.5 py-1 text-deck-text hover:bg-deck-border"
                >
                  <NotebookPen size={13} className="text-deck-accent" />
                  {t("side.handoffButton")}
                </button>
                {addError && <p className="mt-1.5 text-status-alert">{addError}</p>}
              </div>
            )}
            {doc ? (
              <article
                className={`prose prose-sm ${light ? "" : "prose-invert"} max-w-none prose-headings:mb-2 prose-headings:mt-4 prose-p:my-1.5 prose-pre:bg-deck-bg prose-code:before:content-none prose-code:after:content-none`}
              >
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href && /^https?:/.test(href)) void openUrl(href);
                        }}
                      >
                        {children}
                      </a>
                    ),
                    // 本機相對路徑的圖片在 webview 讀不到，只顯示替代文字
                    img: ({ alt }) => (
                      <span className="text-deck-muted">
                        {t("side.image", { alt: String(alt ?? "") })}
                      </span>
                    ),
                  }}
                >
                  {doc.content}
                </Markdown>
              </article>
            ) : (
              <p className="text-deck-muted">{t("side.noDoc")}</p>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

/** 「用編輯器開啟」：只列出有裝的編輯器，記住上次選的；一個都沒裝時打開 VS Code 下載頁。 */
function EditorButton({
  path,
  editors,
  editor,
  onPick,
}: {
  path: string;
  editors: EditorInfo[] | null;
  editor: EditorInfo | null;
  onPick: (id: string) => void;
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

  const button =
    "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-deck-muted hover:bg-deck-hover hover:text-deck-text";

  if (editors?.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void openUrl(EDITOR_DOWNLOAD.url)}
        title={t("side.notInstalled", { app: EDITOR_DOWNLOAD.label })}
        className={`${button} flex-1 text-deck-muted/50`}
      >
        <Download size={14} />
        {EDITOR_DOWNLOAD.label}
      </button>
    );
  }

  const label = editor?.label ?? t("side.editor");
  const choices = editors ?? [];
  return (
    <div ref={menuRef} className="relative flex flex-1">
      <button
        type="button"
        disabled={!editor}
        onClick={() => editor && void openIn(path, editor.id, editor.label)}
        title={t("side.openWith", { app: label })}
        className={`${button} min-w-0 flex-1 ${choices.length > 1 ? "rounded-r-none" : ""}`}
      >
        <Code2 size={14} className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {choices.length > 1 && (
        <button
          type="button"
          aria-label={t("side.pickEditor")}
          aria-expanded={open}
          title={t("side.pickEditor")}
          onClick={() => setOpen((o) => !o)}
          className={`${button} rounded-l-none px-1`}
        >
          <ChevronDown size={13} />
        </button>
      )}
      {open && (
        <div
          role="menu"
          className="absolute top-8 left-0 z-40 min-w-40 rounded-lg border border-deck-border bg-deck-panel p-1 shadow-xl"
        >
          {choices.map((e) => (
            <button
              key={e.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(e.id);
                void openIn(path, e.id, e.label);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-deck-text hover:bg-deck-hover"
            >
              <span className="w-3.5">
                {e.id === editor?.id && <Check size={13} className="text-deck-accent" />}
              </span>
              {e.label}
            </button>
          ))}
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-deck-muted">{t("side.editorFooter")}</p>
        </div>
      )}
    </div>
  );
}
