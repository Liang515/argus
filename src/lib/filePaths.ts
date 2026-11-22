/** 終端機一行文字裡看起來像檔案路徑的片段（還沒確認存在）。 */
export interface PathCandidate {
  /** 在這行文字裡的起訖位置（end 不含） */
  start: number;
  end: number;
  /** 去掉 `:行號:欄` 之後的路徑，用來確認檔案是否存在 */
  path: string;
}

// 空白、引號、括號與中文標點都當成分隔
const SEPARATOR = /[\s"'`()[\]{}<>|,;，。、：；！？（）「」『』【】]/;
// 片段結尾常黏著句點、冒號等標點
const TRAILING = /[.:!?…]+$/;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

function looksLikePath(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; // 網址交給 WebLinksAddon
  if (token === "~" || token.startsWith("~/")) return true;
  if (/^\.{1,2}\//.test(token)) return true;
  if (token.includes("/")) return /[A-Za-z0-9一-鿿]/.test(token);
  return HAS_EXTENSION.test(token) && /^[\w@+\-.一-鿿]+$/.test(token);
}

/** 找出一行裡的候選路徑，例如 `src/App.tsx:313`、`~/Desktop/x`、`README.md`。 */
export function findPathCandidates(text: string): PathCandidate[] {
  const found: PathCandidate[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && SEPARATOR.test(text[i])) i++;
    const start = i;
    while (i < text.length && !SEPARATOR.test(text[i])) i++;
    let token = text.slice(start, i).replace(TRAILING, "");
    const end = start + token.length;
    token = token.replace(LINE_SUFFIX, "");
    if (token && looksLikePath(token)) found.push({ start, end, path: token });
  }
  return found;
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
