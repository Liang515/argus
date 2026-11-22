import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Code2,
  Download,
  FileText,
  FolderOpen,
  NotebookPen,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  changeBadge,
  type GitChange,
  isAppAvailable,
  needsHandoffProtocol,
  OPEN_TARGET_INSTALL,
  type OpenTarget,
  openIn,
  type ProjectDoc,
  splitPath,
} from "../lib/project";
import type { ClaudeStatus } from "../lib/status";
import type { Tab } from "../lib/tabs";

const GIT_POLL_MS = 5000;
const DEBOUNCE_MS = 300;

const TONE_CLASS = {
  added: "text-[#9ece6a]",
  modified: "text-[#e5c07b]",
  deleted: "text-[#f07178]",
  renamed: "text-[#61afef]",
  conflict: "text-[#f07178] font-bold",
} as const;

const TOOLS: { target: OpenTarget; label: string; icon: typeof Code2 }[] = [
  { target: "vscode", label: "VS Code", icon: Code2 },
  { target: "antigravity", label: "Antigravity", icon: Rocket },
  { target: "finder", label: "Finder", icon: FolderOpen },
];

interface Props {
  tab: Tab;
  status: ClaudeStatus;
  /** 有安裝的編輯器（null：還沒偵測完） */
  apps: OpenTarget[] | null;
}

export function Sidebar({ tab, status, apps }: Props) {
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
        {TOOLS.map(({ target, label, icon: Icon }) => {
          const ready = isAppAvailable(target, apps);
          const install = OPEN_TARGET_INSTALL[target];
          return (
            <button
              key={target}
              type="button"
              onClick={() => {
                if (ready) void openIn(path, target);
                else if (install) void openUrl(install);
              }}
              title={
                ready
                  ? `用 ${label} 開啟這個專案`
                  : `還沒安裝 ${label}。點一下打開下載頁，裝好後切回 Argus 就能一鍵開啟專案`
              }
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 hover:bg-deck-hover hover:text-deck-text ${ready ? "text-deck-muted" : "text-deck-muted/50"}`}
            >
              {ready ? <Icon size={14} /> : <Download size={14} />}
              {label}
            </button>
          );
        })}
      </section>

      <section className="flex max-h-[40%] min-h-0 flex-col border-b border-deck-border">
        <header className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold tracking-wide text-deck-muted uppercase">
          <span>Git 變更{changes ? ` · ${changes.length}` : ""}</span>
          <button
            type="button"
            aria-label="重新整理 git 變更"
            onClick={() => void refreshGit()}
            className="rounded p-1 hover:bg-deck-hover hover:text-deck-text"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          </button>
        </header>
        <ul className="min-h-0 overflow-y-auto px-1.5 pb-2">
          {changes === undefined && <li className="px-1.5 text-deck-muted">讀取中…</li>}
          {changes === null && <li className="px-1.5 text-deck-muted">不是 git repo</li>}
          {changes?.length === 0 && <li className="px-1.5 text-deck-muted">沒有未提交的變更</li>}
          {changes?.map((c) => {
            const badge = changeBadge(c.code);
            const { dir, name } = splitPath(c.path);
            return (
              <li
                key={`${c.code}${c.path}`}
                title={c.path}
                className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-deck-hover"
              >
                <span className={`w-3 shrink-0 text-center font-mono ${TONE_CLASS[badge.tone]}`}>
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

      <section className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold tracking-wide text-deck-muted uppercase">
          <FileText size={12} />
          {doc?.name ?? "HANDOFF.md / CLAUDE.md"}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 select-text">
          {needsHandoffProtocol(doc) && (
            <div className="mb-3 rounded-md border border-deck-border bg-deck-bg p-2.5 select-none">
              <p className="text-deck-muted">
                讓 agent 每做完一段就把進度寫進 HANDOFF.md，這裡會即時顯示，換人或換 agent
                接手也不會斷。
              </p>
              <button
                type="button"
                onClick={() => {
                  setAddError(null);
                  invoke("add_handoff_protocol", { path })
                    .then(() => refreshDoc())
                    .catch((e) => setAddError(String(e)));
                }}
                title="在專案根目錄的 CLAUDE.md 加上交接規則（沒有就建立），下次開對話時生效"
                className="mt-2 flex items-center gap-1.5 rounded-md bg-deck-hover px-2.5 py-1 text-deck-text hover:bg-deck-border"
              >
                <NotebookPen size={13} className="text-deck-accent" />在 CLAUDE.md 加入交接規則
              </button>
              {addError && <p className="mt-1.5 text-status-alert">{addError}</p>}
            </div>
          )}
          {doc ? (
            <article className="prose prose-sm prose-invert max-w-none prose-headings:mb-2 prose-headings:mt-4 prose-p:my-1.5 prose-pre:bg-deck-bg prose-code:before:content-none prose-code:after:content-none">
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
                  img: ({ alt }) => <span className="text-deck-muted">[圖片：{alt}]</span>,
                }}
              >
                {doc.content}
              </Markdown>
            </article>
          ) : (
            <p className="text-deck-muted">專案根目錄還沒有 HANDOFF.md 或 CLAUDE.md。</p>
          )}
        </div>
      </section>
    </aside>
  );
}
