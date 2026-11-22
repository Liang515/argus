import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, Download, History, Plus, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AGENT_IDS, AGENTS, type AgentId, type AgentIntent, buttonMode } from "../lib/agents";
import { t } from "../lib/i18n";
import { type ClaudeStatus, statusLabel } from "../lib/status";

interface Props {
  status: ClaudeStatus;
  /** 目前在分頁裡跑的 agent（status 不是 off 時才有意義） */
  running: AgentId;
  /** 這個分頁預設啟動的 agent */
  preferred: AgentId;
  installed: AgentId[];
  onAction: (intent: AgentIntent, agent?: AgentId) => void;
}

const BUTTON =
  "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] hover:bg-deck-hover disabled:opacity-40 disabled:hover:bg-transparent";

/** 分頁列右側：沒有 agent 時是「啟動＋下拉選單＋接續」，Claude 閒置時是「新對話＋切換對話」。
 * 有 agent 開著時，下拉選單改成在新分頁開 agent。 */
export function AgentButtons({ status, running, preferred, installed, onAction }: Props) {
  const mode = buttonMode(status, running);

  if (mode === "claude-session") {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onAction("new")}
          className={`${BUTTON} text-deck-text`}
          title={t("agent.newChatTitle")}
        >
          <Plus size={13} className="text-deck-accent" />
          {t("agent.newChat")}
        </button>
        <button
          type="button"
          onClick={() => onAction("resume")}
          className={`${BUTTON} text-deck-muted hover:text-deck-text`}
          title={t("agent.switchTitle")}
        >
          <History size={13} />
          {t("agent.switch")}
        </button>
        <NewTabMenu installed={installed} onPick={(agent) => onAction("new", agent)} />
      </div>
    );
  }

  if (mode === "busy") {
    // agent 正在工作，或是 agy／Codex 開著（沒有對話內的按鈕操作）
    return (
      <div className="flex shrink-0 items-center">
        <span className="flex h-7 items-center px-2.5 text-[12px] text-deck-muted">
          {statusLabel(status, running)}
        </span>
        <NewTabMenu installed={installed} onPick={(agent) => onAction("new", agent)} />
      </div>
    );
  }

  if (installed.length === 0) {
    // 一個 agent 都沒裝：不要打一個不存在的指令，改成告訴使用者怎麼裝
    return (
      <div className="flex shrink-0 items-center">
        <AgentMenu
          installed={installed}
          footer={t("agent.installFooter")}
          triggerTitle={t("agent.installTitle")}
          triggerLabel={t("agent.install")}
          onPick={(agent) => onAction("new", agent)}
        />
      </div>
    );
  }

  const label = AGENTS[preferred].label;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onAction("new", preferred)}
          className={`${BUTTON} rounded-r-none pr-1.5 text-deck-text`}
          title={t("agent.startTitle", { agent: label, cmd: AGENTS[preferred].start })}
        >
          <Terminal size={13} className="text-deck-accent" />
          {label}
        </button>
        <AgentMenu
          installed={installed}
          checked={preferred}
          footer={t("agent.defaultFooter")}
          triggerClass="rounded-l-none"
          triggerTitle={t("agent.pickOther")}
          onPick={(agent) => onAction("new", agent)}
        />
      </div>
      <button
        type="button"
        onClick={() => onAction("resume", preferred)}
        className={`${BUTTON} text-deck-muted hover:text-deck-text`}
        title={t("agent.resumeTitle", { agent: label, cmd: AGENTS[preferred].resume })}
      >
        <History size={13} />
        {t("agent.resume")}
      </button>
    </div>
  );
}

function NewTabMenu({
  installed,
  onPick,
}: {
  installed: AgentId[];
  onPick: (agent: AgentId) => void;
}) {
  return (
    <AgentMenu
      installed={installed}
      footer={t("agent.newTabFooter")}
      triggerTitle={t("agent.newTabTitle")}
      onPick={onPick}
    />
  );
}

interface MenuProps {
  installed: AgentId[];
  checked?: AgentId;
  footer: string;
  triggerClass?: string;
  triggerTitle: string;
  /** 有的話按鈕顯示文字，沒有就只有下拉箭頭 */
  triggerLabel?: string;
  onPick: (agent: AgentId) => void;
}

/** 列出所有支援的 agent；沒裝的標「未安裝」，點了打開官方安裝說明。 */
function AgentMenu({
  installed,
  checked,
  footer,
  triggerClass = "",
  triggerTitle,
  triggerLabel,
  onPick,
}: MenuProps) {
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

  return (
    <div ref={menuRef} className="relative flex items-center">
      <button
        type="button"
        aria-label={triggerTitle}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${BUTTON} ${triggerClass} ${triggerLabel ? "text-deck-text" : "px-1 text-deck-muted hover:text-deck-text"}`}
        title={triggerTitle}
      >
        {triggerLabel && (
          <>
            <Download size={13} className="text-deck-accent" />
            {triggerLabel}
          </>
        )}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-8 right-0 z-40 min-w-44 rounded-lg border border-deck-border bg-deck-panel p-1 shadow-xl"
        >
          {AGENT_IDS.map((agent) => {
            const ready = installed.includes(agent);
            return (
              <button
                key={agent}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  if (ready) onPick(agent);
                  else void openUrl(AGENTS[agent].install);
                }}
                title={
                  ready ? undefined : t("agent.notInstalledTitle", { agent: AGENTS[agent].label })
                }
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-deck-text hover:bg-deck-hover"
              >
                <span className="w-3.5">
                  {agent === checked && <Check size={13} className="text-deck-accent" />}
                </span>
                <span className={`flex-1 ${ready ? "" : "text-deck-muted"}`}>
                  {AGENTS[agent].label}
                </span>
                {ready ? (
                  <code className="text-[11px] text-deck-muted">{AGENTS[agent].start}</code>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-deck-accent">
                    <Download size={11} />
                    {t("agent.notInstalled")}
                  </span>
                )}
              </button>
            );
          })}
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-deck-muted">{footer}</p>
        </div>
      )}
    </div>
  );
}
