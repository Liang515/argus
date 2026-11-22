/**
 * 簡易模糊比對：query 的字元依序出現在 text 即算符合（不分大小寫）。
 * 分數越高越相關：連續命中、命中字首（/ - _ . 空白之後）加分，越早命中越好。
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 3;
    if (found === 0 || "/-_. ".includes(t[found - 1])) score += 2;
    score -= Math.min(found - ti, 5) * 0.1;
    prevMatch = found;
    ti = found + 1;
  }
  return score;
}

/** 依多個欄位排序（第一個欄位權重最高），過濾掉不符合的項目。 */
export function rank<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, index) => {
      const scores = fields(item).map((f, i) => {
        const s = fuzzyScore(query, f);
        return s === null ? null : s * (i === 0 ? 2 : 1);
      });
      const valid = scores.filter((s): s is number => s !== null);
      return { item, index, score: valid.length ? Math.max(...valid) : null };
    })
    .filter((r) => r.score !== null)
    .sort((a, b) => (b.score as number) - (a.score as number) || a.index - b.index)
    .map((r) => r.item);
}

/** 加入最近開過的清單：移到最前面、去重、限制數量。 */
export function pushRecent(recent: string[], path: string, limit = 30): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, limit);
}
