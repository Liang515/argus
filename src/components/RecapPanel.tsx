import { invoke } from "@tauri-apps/api/core";
import { CornerDownLeft, GitBranch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, type AgentId } from "../lib/agents";
import { rank } from "../lib/fuzzy";
import { lang, t } from "../lib/i18n";
import type { GitChange } from "../lib/project";
import { type ProjectRecap, projectStatus, relativeTime } from "../lib/recap";
import type { ClaudeStatus } from "../lib/status";
import { shortPath, type Tab, tabName } from "../lib/tabs";
import { StatusDot } from "./TabBar";

interface Props {
  recaps: ProjectRecap[];
  tabs: Tab[];
  statuses: Record<string, ClaudeStatus>;
  runningAgents: Record<string, AgentId>;
  branches: Record<string, string | null>;
  /** 有開著的分頁就切過去，否則開新分頁；資料夾不在了回傳 false */
  onOpen: (path: string, tabId: string | null) => Promise<boolean>;
  onClose: () => void;
}

/** 列表最多顯示幾個專案（也是查 git 狀態的上限）。 */
const MAX_SHOWN = 30;

/** 「近況」：所有專案依最後動作時間排列，看每個專案最後做了什麼、做到哪。 */
export function RecapPanel({
  recaps,
  tabs,
  statuses,
  runningAgents,
  branches,
  onOpen,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // 每個專案的未提交變更數；null 代表不是 git repo
  const [dirty, setDirty] = useState<Record<string, number | null>>({});
  // 打開時算一次相對時間就好，面板開著不會太久
  const [now] = useState(Date.now);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queried = useRef(new Set<string>());
  const listRef = useRef<HTMLUListElement>(null);
  // 只在面板關掉時丟棄 git 結果；列表重排或 StrictMode 重跑 effect 時，已送出的查詢照常收
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const shown = useMemo(() => recaps.slice(0, MAX_SHOWN), [recaps]);
  // 背景 agent 每動一步 recaps 都會變，只看路徑清單，git 狀態每個專案只查一次
  const pathsKey = shown.map((r) => r.path).join("\n");

  useEffect(() => {
    for (const path of pathsKey ? pathsKey.split("\n") : []) {
      if (queried.current.has(path)) continue;
      queried.current.add(path);
      invoke<GitChange[] | null>("git_status", { path })
        .then((changes) => {
          if (alive.current) setDirty((prev) => ({ ...prev, [path]: changes?.length ?? null }));
        })
        .catch(() => {});
    }
  }, [pathsKey]);

  // 焦點不在輸入框時（例如被其他元件搶走）Esc 仍要能關閉，不能送進底下的 agent
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement === inputRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const items = useMemo(
    () => rank(shown, query, (r) => [tabName(r.path), r.prompt ?? "", r.path]),
    [shown, query],
  );
  const current = Math.min(selected, items.length - 1);

  const choose = async (recap: ProjectRecap) => {
    if (!(await onOpen(recap.path, projectStatus(recap.path, tabs, statuses).tabId))) {
      setError(t("palette.folderMissing", { path: recap.path }));
      return;
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 注音組字中的 Enter / 方向鍵交給輸入法（同 ⌘K 切換器）
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    const move = (delta: number) => {
      e.preventDefault();
      if (items.length) setSelected((s) => (s + delta + items.length) % items.length);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (items[current]) void choose(items[current]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 點背景關閉，鍵盤用 Esc
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* 點面板其他地方不讓輸入框失焦，鍵盤操作才一直有效 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 只是保留焦點 */}
      <div
        onMouseDown={(e) => {
          // 點到列表本身（捲軸）不擋，否則「永遠顯示捲軸」時拖不動
          if (e.target !== inputRef.current && e.target !== listRef.current) e.preventDefault();
        }}
        className="flex h-fit max-h-[75vh] w-[min(680px,92vw)] flex-col overflow-hidden rounded-xl border border-deck-border bg-deck-panel shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-deck-border px-4">
          <span className="shrink-0 text-[13px] font-semibold text-deck-text">
            {t("recap.title")}
          </span>
          <input
            // biome-ignore lint/a11y/noAutofocus: 叫出面板就是要立刻打字或選
            autoFocus
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("recap.placeholder")}
            className="min-w-0 flex-1 bg-transparent py-3 text-[14px] text-deck-text outline-none placeholder:text-deck-muted"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        {error && <p className="px-4 pt-2 text-[12px] text-status-alert">{error}</p>}
        {items.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-deck-muted">
            {recaps.length === 0 ? t("recap.empty") : t("recap.noMatch")}
          </p>
        ) : (
          <ul ref={listRef} className="overflow-y-auto p-1.5">
            {items.map((recap, i) => {
              const { status, tabId } = projectStatus(recap.path, tabs, statuses);
              const branch = tabId ? branches[tabId] : null;
              const uncommitted = dirty[recap.path];
              const agent = (tabId && runningAgents[tabId]) || recap.agent;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: 鍵盤操作由輸入框統一處理
                <li
                  key={recap.path}
                  ref={i === current ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => void choose(recap)}
                  title={recap.path}
                  className={`cursor-default rounded-md px-3 py-2 ${i === current ? "bg-deck-hover" : ""}`}
                >
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="flex w-2 shrink-0 justify-center">
                      <StatusDot status={status} agent={agent ?? "claude"} active={false} />
                    </span>
                    <span className="font-medium text-deck-text">{tabName(recap.path)}</span>
                    {branch && (
                      <span className="flex items-center gap-0.5 text-[11px] text-deck-muted">
                        <GitBranch size={11} />
                        {branch}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11px] text-deck-muted">
                      {shortPath(recap.path)}
                    </span>
                    <span className="shrink-0 text-[11px] text-deck-muted">
                      {agent && `${AGENTS[agent].label} · `}
                      {relativeTime(recap.at, now)}
                    </span>
                    {i === current && (
                      <CornerDownLeft size={13} className="shrink-0 text-deck-muted" />
                    )}
                  </div>
                  <p
                    className={`mt-0.5 line-clamp-2 pl-4 text-[12px] ${
                      recap.prompt ? "text-deck-text/85" : "text-deck-muted italic"
                    }`}
                  >
                    {/* 指令是別的 agent 收到的（例如同專案先用 agy、後來開 Claude），標出是誰 */}
                    {recap.prompt && recap.promptAgent && recap.promptAgent !== agent && (
                      <span className="text-deck-muted">
                        {t("recap.promptBy", { agent: AGENTS[recap.promptAgent].label })}
                      </span>
                    )}
                    {recap.prompt ?? t("recap.noPrompt")}
                  </p>
                  <Facts recap={recap} uncommitted={uncommitted} closed={tabId === null} />
                </li>
              );
            })}
          </ul>
        )}
        <footer className="flex gap-4 border-t border-deck-border px-4 py-2 text-[11px] text-deck-muted">
          <span>{t("palette.hintSelect")}</span>
          <span>{t("recap.hintOpen")}</span>
          <span>{t("palette.hintClose")}</span>
        </footer>
      </div>
    </div>
  );
}

/** 第三行：改了哪些檔、未提交幾個、分頁是否已關。 */
function Facts({
  recap,
  uncommitted,
  closed,
}: {
  recap: ProjectRecap;
  uncommitted: number | null | undefined;
  closed: boolean;
}) {
  const facts: string[] = [];
  if (recap.files.length) {
    const names = recap.files
      .slice(0, 3)
      .map(tabName)
      .join(lang === "en" ? ", " : "、");
    const more = recap.files.length > 3 ? "…" : "";
    const key = recap.files.length === 1 ? "recap.filesOne" : "recap.files";
    facts.push(t(key, { count: recap.files.length, names: names + more }));
  }
  if (uncommitted) facts.push(t("recap.uncommitted", { count: uncommitted }));
  if (closed) facts.push(t("recap.closed"));
  if (!facts.length) return null;
  // 只顯示檔名，同名檔案分不出來時滑過去看完整路徑
  return (
    <p
      title={recap.files.map(shortPath).join("\n") || undefined}
      className="mt-0.5 truncate pl-4 text-[11px] text-deck-muted"
    >
      {facts.join(" · ")}
    </p>
  );
}
