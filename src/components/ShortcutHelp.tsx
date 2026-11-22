import { useEffect, useRef } from "react";

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "分頁",
    items: [
      ["⌘T", "開啟專案資料夾"],
      ["⌘⇧T", "在目前專案再開一個分頁（同資料夾或 worktree）"],
      ["⌘W", "關閉分頁（有程式在跑會先問）"],
      ["⌘1 – ⌘8", "跳到第 N 個分頁"],
      ["⌘9", "跳到最後一個分頁"],
      ["⌘⇧[  ⌘⇧]", "上一個／下一個分頁"],
      ["⌘⇧←  ⌘⇧→", "把目前分頁往左／往右移（也可以用滑鼠拖曳）"],
    ],
  },
  {
    title: "切換與面板",
    items: [
      ["⌘K 或 ⌘P", "切換器：搜尋專案、動作，或輸入路徑開新分頁"],
      ["⌘B", "開關右側看板"],
      ["⌘/", "顯示這份快捷鍵說明"],
    ],
  },
  {
    title: "切換器裡",
    items: [
      ["↑ ↓ 或 ⌃N ⌃P", "選擇"],
      ["↵", "開啟"],
      ["esc", "關閉"],
    ],
  },
  {
    title: "輸入時",
    items: [
      ["⌘←  ⌘→", "移到行首／行尾"],
      ["⌥←  ⌥→", "往左／往右跳一個字"],
      ["⌘⌫", "刪除游標前的整行"],
      ["⌘A", "全選終端機內容（可接著 ⌘C 複製）"],
    ],
  },
  {
    title: "Claude",
    items: [
      ["⇧↵", "在 Claude 輸入框換行（不送出）"],
      ["右上按鈕", "沒有 Claude：開始／接續；Claude 閒置：新對話／切換對話"],
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
        aria-label="鍵盤快捷鍵"
        className="w-[min(560px,90vw)] outline-none rounded-xl border border-deck-border bg-deck-panel p-5 shadow-2xl"
      >
        <h2 className="mb-4 text-[14px] font-semibold text-deck-text">鍵盤快捷鍵</h2>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-deck-muted">
                {group.title}
              </h3>
              <dl className="space-y-1 text-[13px]">
                {group.items.map(([keys, desc]) => (
                  <div key={keys} className="flex gap-4">
                    <dt className="w-32 shrink-0 font-mono text-deck-text">{keys}</dt>
                    <dd className="text-deck-muted">{desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="mt-5 text-[11px] text-deck-muted">按 esc 或 ⌘/ 關閉</p>
      </div>
    </div>
  );
}
