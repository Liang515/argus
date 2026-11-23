/**
 * 關掉網頁元件的預設右鍵選單：它只有「Reload」，按了會重新載入介面，
 * 但終端機與分頁的連線不會重建，整個 App 就卡住。輸入框保留系統的剪下／拷貝／貼上選單。
 */
interface ElementLike {
  tagName?: unknown;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

export function isEditable(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el.tagName !== "string") return false;
  // xterm 用一個隱藏的 textarea 接收輸入，它不算一般輸入框
  if (el.classList?.contains("xterm-helper-textarea")) return false;
  return el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

export function blockDefaultContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
}
