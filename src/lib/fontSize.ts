/** 終端機字體大小：⌘＋／⌘－ 一次一級，⌘0 回到預設。 */
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 24;

/** delta：1 放大、-1 縮小、0 恢復預設；超出範圍就停在頭尾。 */
export function nextFontSize(current: number, delta: -1 | 0 | 1): number {
  if (delta === 0) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta));
}

/** 從儲存的設定讀回字體大小；不合理的值用預設。 */
export function parseFontSize(saved: string | null): number {
  const n = Number(saved);
  return Number.isInteger(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE ? n : DEFAULT_FONT_SIZE;
}
