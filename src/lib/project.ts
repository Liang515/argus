import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { t, translateError } from "./i18n";

export interface GitChange {
  code: string;
  path: string;
}

export interface ProjectDoc {
  name: string;
  content: string;
}

/** 這台電腦有安裝的編輯器（後端 detect_apps，依偏好順序）。 */
export interface EditorInfo {
  id: string;
  label: string;
}

/** 一個編輯器都沒裝時，按鈕改成打開 VS Code 下載頁。 */
export const EDITOR_DOWNLOAD = { label: "VS Code", url: "https://code.visualstudio.com/download" };

/** 使用者選過且有裝就用它，否則用第一個有裝的。 */
export function pickEditor(preferred: string | null, installed: EditorInfo[]): EditorInfo | null {
  return installed.find((e) => e.id === preferred) ?? installed[0] ?? null;
}

const EDITOR_KEY = "argus.editor";

export function loadPreferredEditor(): string | null {
  try {
    return localStorage.getItem(EDITOR_KEY);
  } catch {
    return null;
  }
}

// ⌘＋點擊路徑、活動面板打開檔案時用；App 選了編輯器就更新
let currentEditor = loadPreferredEditor();

export function savePreferredEditor(id: string) {
  currentEditor = id;
  try {
    localStorage.setItem(EDITOR_KEY, id);
  } catch {
    // 存不了就只在這次開啟期間記得
  }
}

/** 打開終端機或活動面板裡的檔案：文字檔用選的編輯器，規則見後端 open_path。 */
export function openPath(path: string, reveal: boolean, line?: number, column?: number) {
  return invoke("open_path", {
    path,
    reveal,
    line: line ?? null,
    column: column ?? null,
    editor: currentEditor,
  });
}

/** 交接規則的標題，CLAUDE.md 裡有它就代表已經加過（與後端 HANDOFF_MARKER 相同）。 */
export const HANDOFF_MARKER = "## Session Handoff Protocol";

/** 側欄要不要提示加入交接規則：還沒有 HANDOFF.md，而且 CLAUDE.md 也還沒加過。 */
export function needsHandoffProtocol(doc: ProjectDoc | null): boolean {
  return !doc || (doc.name === "CLAUDE.md" && !doc.content.includes(HANDOFF_MARKER));
}

type Tone = "added" | "modified" | "deleted" | "renamed" | "conflict";

/** porcelain 兩碼狀態轉成側欄標籤。 */
export function changeBadge(code: string): { label: string; tone: Tone } {
  if (code === "??") return { label: "U", tone: "added" };
  if (code.includes("U") || code === "AA" || code === "DD") return { label: "!", tone: "conflict" };
  if (code.includes("D")) return { label: "D", tone: "deleted" };
  if (code.includes("R")) return { label: "R", tone: "renamed" };
  if (code.includes("A")) return { label: "A", tone: "added" };
  return { label: "M", tone: "modified" };
}

/** 拆成資料夾與檔名，側欄用不同顏色顯示。 */
export function splitPath(path: string): { dir: string; name: string } {
  const trimmed = path.replace(/\/$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1
    ? { dir: "", name: trimmed }
    : { dir: trimmed.slice(0, i + 1), name: trimmed.slice(i + 1) };
}

/** 用編輯器（id）或 Finder（"finder"）打開專案資料夾。 */
export async function openIn(path: string, target: string, label: string) {
  try {
    await invoke("open_in", { path, target });
  } catch (err) {
    await message(t("open.failed", { app: label, err: translateError(err) }), {
      title: t("open.failedTitle"),
      kind: "error",
    });
  }
}
