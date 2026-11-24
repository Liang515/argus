/**
 * OSC 52：終端機裡的程式請終端機代為寫入剪貼簿（`ESC ] 52 ; <目標> ; <base64> BEL`）。
 * Claude Code 在 Windows 上選取文字後就是用這個複製。只支援寫入：讀取請求（`?`）一律忽略，
 * 否則終端機裡任何程式都能偷看剪貼簿。
 */

/** 太大的內容不寫（base64 字元數），避免輸出異常時塞爆剪貼簿或卡住畫面。 */
export const MAX_OSC52_BASE64 = 4 * 1024 * 1024;

/** 解析 OSC 52 的內容（xterm 傳進來的是 `52;` 之後的部分）；不是寫入請求或格式不對就回傳 null。 */
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep === -1) return null;
  const target = data.slice(0, sep);
  const payload = data.slice(sep + 1);
  // 目標只能是 c、p、s、0–7 等字元（空的代表預設）
  if (!/^[cpqs0-7]*$/.test(target)) return null;
  if (payload === "?" || payload.length > MAX_OSC52_BASE64) return null;
  // 空的內容在 xterm 是「清空剪貼簿」；不支援，免得被輸出意外清掉
  if (payload === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
