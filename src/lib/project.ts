import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";

export interface GitChange {
  code: string;
  path: string;
}

export interface ProjectDoc {
  name: string;
  content: string;
}

export type OpenTarget = "vscode" | "antigravity" | "finder";

export const OPEN_TARGET_LABEL: Record<OpenTarget, string> = {
  vscode: "VS Code",
  antigravity: "Antigravity",
  finder: "Finder",
};

/** 沒裝的編輯器點了會打開下載頁（Finder 一定有）。 */
export const OPEN_TARGET_INSTALL: Partial<Record<OpenTarget, string>> = {
  vscode: "https://code.visualstudio.com/download",
  antigravity: "https://antigravity.google/download",
};

/** apps 是偵測到的編輯器；還沒偵測完（null）時先當成都有，避免按鈕閃一下變灰。 */
export function isAppAvailable(target: OpenTarget, apps: OpenTarget[] | null): boolean {
  return !OPEN_TARGET_INSTALL[target] || apps === null || apps.includes(target);
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

export async function openIn(path: string, target: OpenTarget) {
  try {
    await invoke("open_in", { path, target });
  } catch (err) {
    await message(`無法用 ${OPEN_TARGET_LABEL[target]} 開啟：${String(err)}`, {
      title: "開啟失敗",
      kind: "error",
    });
  }
}
