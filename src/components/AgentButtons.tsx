import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  History,
  Plus,
  Terminal,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AGENT_IDS, AGENTS, type AgentId, type AgentIntent, buttonMode } from "../lib/agents";
import type { CustomAgent } from "../lib/customAgents";
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
  /** 在新分頁打好安裝指令（不按 Enter） */
  onInstall: (agent: AgentId) => void;
  /** 打開 agent 選單時：重新偵測，剛裝好的 agent 才會馬上出現 */
  onMenuOpen: () => void;
  /** ~/.argus/agents.json 的自訂指令 */
  custom: CustomAgent[];
  onCustom: (agent: CustomAgent) => void;
}

const MenuActions = createContext<{
  onInstall: (agent: AgentId) => void;
  onMenuOpen: () => void;
  custom: CustomAgent[];
  onCustom: (agent: CustomAgent) => void;
}>({
  onInstall: () => {},
  onMenuOpen: () => {},
  custom: [],
  onCustom: () => {},
});

const BUTTON =
  "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] hover:bg-deck-hover disabled:opacity-40 disabled:hover:bg-transparent";

/** 分頁列右側：沒有 agent 時是「啟動＋下拉選單＋接續」，Claude 閒置時是「新對話＋切換對話」。
 * 有 agent 開著時，下拉選單改成在新分頁開 agent。 */
export function AgentButtons(props: Props) {
  return (
    <MenuActions.Provider
      value={{
        onInstall: props.onInstall,
        onMenuOpen: props.onMenuOpen,
        custom: props.custom,
        onCustom: props.onCustom,
      }}
    >
      <AgentButtonsInner {...props} />
    </MenuActions.Provider>
  );
}

function AgentButtonsInner({ status, running, preferred, installed, onAction }: Props) {
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
  // 點了沒裝的 agent：選單改成顯示它的安裝指令
  const [installing, setInstalling] = useState<AgentId | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { onInstall, onMenuOpen, custom, onCustom } = useContext(MenuActions);

  useEffect(() => {
    if (!open) {
      setInstalling(null);
      setCopied(false);
      return;
    }
    onMenuOpen();
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
  }, [open, onMenuOpen]);

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
          {installing ? (
            <div className="w-80 p-1.5 text-[12px]">
              <button
                type="button"
                onClick={() => {
                  setInstalling(null);
                  setCopied(false);
                }}
                className="mb-2 flex items-center gap-1 text-deck-muted hover:text-deck-text"
              >
                <ArrowLeft size={12} />
                {t("agent.installHeading", { agent: AGENTS[installing].label })}
              </button>
              <code className="block rounded-md bg-deck-bg px-2 py-1.5 font-mono text-[11.5px] break-all text-deck-text select-text">
                {AGENTS[installing].installCommand}
              </code>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onInstall(installing);
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-deck-hover px-2 py-1.5 text-deck-text hover:bg-deck-border"
                >
                  <Terminal size={12} className="text-deck-accent" />
                  {t("agent.installRun")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(AGENTS[installing].installCommand)
                      .then(() => setCopied(true))
                      .catch(() => {});
                  }}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-deck-muted hover:bg-deck-hover hover:text-deck-text"
                >
                  <Copy size={12} />
                  {copied ? t("agent.installCopied") : t("agent.installCopy")}
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-deck-muted">
                {t("agent.installHint")}
              </p>
              <button
                type="button"
                onClick={() => void openUrl(AGENTS[installing].install)}
                className="mt-1 text-[11px] text-deck-muted underline-offset-2 hover:text-deck-text hover:underline"
              >
                {t("agent.installDocs")}
              </button>
            </div>
          ) : (
            <>
              {AGENT_IDS.map((agent) => {
                const ready = installed.includes(agent);
                return (
                  <button
                    key={agent}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (ready) {
                        setOpen(false);
                        onPick(agent);
                      } else setInstalling(agent);
                    }}
                    title={
                      ready
                        ? undefined
                        : t("agent.notInstalledTitle", { agent: AGENTS[agent].label })
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
              {custom.length > 0 && (
                <>
                  <p className="mt-1 border-t border-deck-border px-2.5 pt-1.5 pb-0.5 text-[11px] text-deck-muted">
                    {t("custom.heading")}
                  </p>
                  {custom.map((agent) => (
                    <button
                      key={agent.name}
                      type="button"
                      role="menuitem"
                      title={agent.command}
                      onClick={() => {
                        setOpen(false);
                        onCustom(agent);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-deck-text hover:bg-deck-hover"
                    >
                      <span className="w-3.5" />
                      <span className="flex-1 truncate">{agent.name}</span>
                    </button>
                  ))}
                </>
              )}
              <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-deck-muted">{footer}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
