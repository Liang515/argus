import { useEffect, useRef } from "react";
import { lang, t } from "../lib/i18n";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: t("help.tabs"),
    items: [
      ["⌘T", t("help.tabs.open")],
      ["⌘⇧T", t("help.tabs.duplicate")],
      ["⌘W", t("help.tabs.close")],
      ["⌘1 – ⌘8", t("help.tabs.jump")],
      ["⌘9", t("help.tabs.last")],
      ["⌘⇧[  ⌘⇧]", t("help.tabs.prevNext")],
      ["⌘⇧←  ⌘⇧→", t("help.tabs.move")],
    ],
  },
  {
    title: t("help.panels"),
    items: [
      [lang === "en" ? "⌘K or ⌘P" : "⌘K 或 ⌘P", t("help.panels.palette")],
      ["⌘J", t("help.panels.recap")],
      ["⌘B", t("help.panels.sidebar")],
      ["⌘/", t("help.panels.help")],
      [t("help.panels.themeKeys"), t("help.panels.theme")],
      ["⌘+  ⌘−", t("help.panels.zoom")],
    ],
  },
  {
    title: t("help.palette"),
    items: [
      [lang === "en" ? "↑ ↓ or ⌃N ⌃P" : "↑ ↓ 或 ⌃N ⌃P", t("help.palette.select")],
      ["↵", t("help.palette.open")],
      ["esc", t("help.palette.close")],
    ],
  },
  {
    title: t("help.typing"),
    items: [
      ["⌘←  ⌘→", t("help.typing.lineEnds")],
      ["⌥←  ⌥→", t("help.typing.words")],
      ["⌘⌫", t("help.typing.deleteLine")],
      ["⌘A", t("help.typing.selectAll")],
      ["⇧↵", t("help.typing.newline")],
    ],
  },
  {
    title: t("help.links"),
    items: [
      [t("help.links.openKeys"), t("help.links.open")],
      [t("help.links.revealKeys"), t("help.links.reveal")],
      [t("help.links.urlKeys"), t("help.links.url")],
    ],
  },
  {
    title: t("help.agents"),
    items: [
      [t("help.agents.buttonsKeys"), t("help.agents.buttons")],
      [t("help.agents.ownKeys"), t("help.agents.own")],
    ],
  },
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 把焦點從終端機移走，否則按鍵（特別是 Esc）會同時送進 Claude
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 點背景關閉，鍵盤用 Esc 或 ⌘/
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label={t("help.title")}
        className="max-h-[80vh] w-[min(560px,90vw)] overflow-y-auto overscroll-contain outline-none rounded-xl border border-deck-border bg-deck-panel p-5 shadow-2xl"
      >
        <h2 className="mb-4 text-[14px] font-semibold text-deck-text">{t("help.title")}</h2>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-deck-muted">
                {group.title}
              </h3>
              <dl className="space-y-1 text-[13px]">
                {group.items.map(([keys, desc]) => (
                  <div key={keys} className="flex gap-4">
                    <dt className="w-40 shrink-0 font-mono text-deck-text">{keys}</dt>
                    <dd className="text-deck-muted">{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="mt-5 text-[11px] text-deck-muted">{t("help.close")}</p>
      </div>
    </div>
  );
}
