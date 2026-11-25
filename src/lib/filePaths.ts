import { type Platform, platform } from "./platform";

/** 終端機一行文字裡看起來像檔案路徑的片段（還沒確認存在）。 */
export interface PathCandidate {
  /** 在這行文字裡的起訖位置（end 不含） */
  start: number;
  end: number;
  /** 去掉 `:行號:欄` 之後的路徑，用來確認檔案是否存在 */
  path: string;
  /** `src/a.ts:12:3` 的 12 與 3，用編輯器打開時跳到這裡 */
  line?: number;
  column?: number;
}

// 空白、引號、括號與中文標點都當成分隔
const SEPARATOR = /[\s"'`()[\]{}<>|,;，。、：；！？（）「」『』【】]/;
// 片段結尾常黏著句點、冒號等標點
const TRAILING = /[.:!?…]+$/;
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

function looksLikePath(token: string, target: Platform): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; // 網址交給 WebLinksAddon
  // 網路路徑（\\server\share、//server/share）：光是查詢存不存在，Windows 就會連到那台主機
  if (/^[\\/]{2}/.test(token)) return false;
  if (token === "~" || token.startsWith("~/")) return true;
  if (/^\.{1,2}\//.test(token)) return true;
  if (target === "windows") {
    // C:\a\b、C:/a/b、~\a、.\a，或 src\a.ts 這種反斜線分隔的相對路徑
    if (/^[A-Za-z]:[\\/]/.test(token) || /^(~|\.{1,2})\\/.test(token)) return true;
    if (token.includes("\\")) return /[A-Za-z0-9一-鿿]/.test(token);
  }
  if (token.includes("/")) return /[A-Za-z0-9一-鿿]/.test(token);
  return HAS_EXTENSION.test(token) && /^[\w@+\-.一-鿿]+$/.test(token);
}

/** 一段文字（已去掉結尾標點）變成候選路徑；`:行號:欄` 拆出來。 */
function candidate(start: number, raw: string): PathCandidate {
  const suffix = LINE_SUFFIX.exec(raw);
  return {
    start,
    end: start + raw.length,
    path: suffix ? raw.slice(0, suffix.index) : raw,
    line: suffix ? Number(suffix[1]) : undefined,
    column: suffix?.[2] ? Number(suffix[2]) : undefined,
  };
}

// 檔名裡常見、但一般當成分隔的字元：空白與括號（`會議記錄（富邦版）.pdf`、`a (1).png`）
const IN_NAME = /[ ()（）「」『』【】[\]]/;
// 往後接的上限：最多跨幾段、最長幾個字
const MAX_SPAN_PARTS = 8;
const MAX_SPAN_CHARS = 200;
// 路徑開頭：`~/`、`./`、`../`、`/`、`C:\`（反斜線版本也算）
const PATH_START = /^(~|\.{1,2}|[A-Za-z]:)?[\\/]/;

/**
 * 從看起來像路徑開頭的片段（`~/…`、`/…`、`C:\…`）往後接上空白與括號後面的部分，
 * 結尾有副檔名的都列為候選，例如 `~/a/261125 會議記錄（富邦版）.pdf`。
 * 存不存在交給後端判斷，重疊時留最長的存在路徑（見 [`pickExisting`]）。
 */
function spanningCandidates(text: string, start: number, first: string): PathCandidate[] {
  // 已經帶行號（`a.ts:12:3`）表示路徑到這裡結束
  if (!PATH_START.test(first) || LINE_SUFFIX.test(first)) return [];
  const out: PathCandidate[] = [];
  let i = start + first.length;
  for (let parts = 0; parts < MAX_SPAN_PARTS && i - start < MAX_SPAN_CHARS; parts++) {
    // 跳過前一段結尾被去掉的標點，停在分隔字元上；只跨過檔名裡會出現的那幾種
    while (i < text.length && !SEPARATOR.test(text[i])) i++;
    if (i >= text.length || !IN_NAME.test(text[i])) break;
    while (i < text.length && IN_NAME.test(text[i])) i++;
    let j = i;
    while (j < text.length && !SEPARATOR.test(text[j])) j++;
    // 下一段自己就是另一個路徑的開頭（`a.sh 與 ../b.rs`）：不是同一個檔名
    if (PATH_START.test(text.slice(i, j))) break;
    const raw = text.slice(start, j).replace(TRAILING, "");
    if (j > i && HAS_EXTENSION.test(raw.replace(LINE_SUFFIX, ""))) {
      out.push(candidate(start, raw));
    }
    i = j;
  }
  return out;
}

/** 找出一行裡的候選路徑，例如 `src/App.tsx:313`、`~/Desktop/x`、`README.md`。 */
export function findPathCandidates(text: string, target: Platform = platform): PathCandidate[] {
  const found: PathCandidate[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && SEPARATOR.test(text[i])) i++;
    const start = i;
    while (i < text.length && !SEPARATOR.test(text[i])) i++;
    const raw = text.slice(start, i).replace(TRAILING, "");
    const c = candidate(start, raw);
    if (c.path && looksLikePath(c.path, target)) {
      found.push(c);
      found.push(...spanningCandidates(text, start, raw));
    }
  }
  return found;
}

/**
 * 候選路徑查過存在與否之後，挑出要變成連結的：重疊的只留最長的那個
 * （`~/a/b 會議記錄.pdf` 存在時，不要再把 `~/a/b` 標成另一個連結）。回傳 `found` 的索引。
 */
export function pickExisting(found: PathCandidate[], exists: boolean[]): number[] {
  const order = found
    .map((_, i) => i)
    .filter((i) => exists[i])
    .sort((a, b) => found[b].end - found[b].start - (found[a].end - found[a].start));
  const kept: number[] = [];
  for (const i of order) {
    const c = found[i];
    if (kept.every((k) => found[k].end <= c.start || c.end <= found[k].start)) kept.push(i);
  }
  return kept.sort((a, b) => found[a].start - found[b].start);
}

/** xterm 一格的必要資訊（寬字元佔兩格，第二格寬度是 0）。 */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/**
 * 把一行格子轉成文字，並記下每個字元落在第幾格（0 起算）與佔幾格。
 * 前面有中文等寬字元時，字串位置和格子位置不同，畫底線要用格子位置。
 */
export function lineText(cells: CellLike[]): { text: string; col: number[]; width: number[] } {
  let text = "";
  const col: number[] = [];
  const width: number[] = [];
  cells.forEach((cell, x) => {
    const w = cell.getWidth();
    if (w === 0) return;
    const chars = cell.getChars() || " ";
    for (let k = 0; k < chars.length; k++) {
      col.push(x);
      width.push(w);
    }
    text += chars;
  });
  return { text, col, width };
}

/**
 * 終端機程式用 OSC 8 標的超連結要打開什麼：http(s) 網址，或 `file://` 指向的本機路徑。
 * 其他協定（以及別台主機的 file://）一律不開。
 */
export function hyperlinkTarget(
  uri: string,
  os: Platform = platform,
): { kind: "url"; url: string } | { kind: "path"; path: string } | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return { kind: "url", url: uri };
  if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Windows：file:///C:/a/b → C:\a\b
  if (os === "windows") {
    if (!/^\/[A-Za-z]:\//.test(path)) return null;
    path = path.slice(1).replace(/\//g, "\\");
  }
  return path ? { kind: "path", path } : null;
}
