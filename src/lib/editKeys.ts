import { type Platform, platform } from "./platform";

type KeyLike = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">;

/**
 * 輸入時的編輯鍵要怎麼處理：送控制字元給 shell／agent、選取整個終端機內容，
 * 或（Windows）複製選取、交給瀏覽器貼上。
 */
export type EditKey =
  | { type: "send"; data: string }
  | { type: "select-all" }
  | { type: "copy" }
  | { type: "paste" };

/**
 * 把 macOS 習慣的編輯鍵翻成終端機看得懂的按鍵（和 iTerm2、VS Code 終端機一樣）。
 * zsh、bash 與 Claude Code 的輸入框都支援這些 emacs 風格按鍵。
 */
export function editKey(
  e: KeyLike,
  target: Platform = platform,
  hasSelection = false,
): EditKey | null {
  // ⇧↩ → ESC+CR，Claude Code 視為換行而不是送出
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === "Enter") {
    return { type: "send", data: "\x1b\r" };
  }
  if (target === "windows") return windowsEditKey(e, hasSelection);
  if (e.ctrlKey || e.shiftKey) return null;
  if (e.metaKey && !e.altKey) {
    if (e.code === "ArrowLeft") return { type: "send", data: "\x01" }; // ⌃A 行首
    if (e.code === "ArrowRight") return { type: "send", data: "\x05" }; // ⌃E 行尾
    if (e.code === "Backspace") return { type: "send", data: "\x15" }; // ⌃U 刪到行首
    if (e.code === "KeyA") return { type: "select-all" };
  }
  if (e.altKey && !e.metaKey) {
    if (e.code === "ArrowLeft") return { type: "send", data: "\x1bb" }; // ⌥B 往左一個字
    if (e.code === "ArrowRight") return { type: "send", data: "\x1bf" }; // ⌥F 往右一個字
  }
  return null;
}

/**
 * Windows Terminal 的習慣：Ctrl+Shift+C 複製；有選取時 Ctrl+C 也是複製（沒選取才是中斷）；
 * Ctrl+V、Ctrl+Shift+V 貼上。Ctrl+← → 跳字由 shell 自己處理，不必翻譯。
 */
function windowsEditKey(e: KeyLike, hasSelection: boolean): EditKey | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.code === "KeyC" && (e.shiftKey || hasSelection)) return { type: "copy" };
  if (e.code === "KeyV") return { type: "paste" };
  return null;
}

type KeyEventLike = KeyLike & Pick<KeyboardEvent, "type" | "isComposing" | "preventDefault">;

/**
 * 給 xterm 的 attachCustomKeyEventHandler 用：是編輯鍵就在 keydown 時執行，回傳 false 讓 xterm 不再處理。
 * xterm 收到 false 不會呼叫 preventDefault，所以要自己擋：否則 ⌘← 會把 xterm 隱藏輸入框的游標移到開頭，
 * 之後中文輸入法組好的字會從錯的位置讀出來，送出以前打過的字。
 */
export function handleEditKeyEvent(
  e: KeyEventLike,
  run: (edit: EditKey) => void,
  hasSelection = false,
  target: Platform = platform,
): boolean {
  // 輸入法組字中，方向鍵是在選字，交給輸入法
  if (e.isComposing) return true;
  const edit = editKey(e, target, hasSelection);
  if (!edit) return true;
  // 貼上要讓瀏覽器照常觸發 paste 事件（xterm 會收），所以不擋預設動作
  if (edit.type === "paste") return false;
  e.preventDefault();
  if (e.type === "keydown") run(edit);
  return false;
}
