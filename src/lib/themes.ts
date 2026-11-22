import type { ITheme } from "@xterm/xterm";

/** 可選的配色；只在 ⌘K 切換，介面上不多放按鈕。 */
export type ThemeId = "argus" | "clear-dark" | "terminal-app";
export const THEME_IDS: ThemeId[] = ["argus", "clear-dark", "terminal-app"];

/** 分頁列、側欄等外框用的顏色（對應 index.css 的 --color-deck-*）。 */
export interface UiColors {
  bg: string;
  panel: string;
  border: string;
  hover: string;
  text: string;
  muted: string;
}

export interface Theme {
  terminal: ITheme;
  ui: UiColors;
}

const ACCENT = "#a594ff";

const ARGUS: Theme = {
  terminal: {
    background: "#0d0f12",
    foreground: "#d7dae0",
    cursor: ACCENT,
    cursorAccent: "#0d0f12",
    selectionBackground: "#3a4150",
    black: "#1c1f26",
    red: "#f07178",
    green: "#9ece6a",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d7dae0",
    brightBlack: "#5c6370",
    brightRed: "#ff8b92",
    brightGreen: "#b5e08b",
    brightYellow: "#f0d197",
    brightBlue: "#82c0f5",
    brightMagenta: "#d896e8",
    brightCyan: "#7fd3dd",
    brightWhite: "#ffffff",
  },
  ui: {
    bg: "#0d0f12",
    panel: "#13161b",
    border: "#22262e",
    hover: "#1a1e25",
    text: "#d7dae0",
    muted: "#7d8590",
  },
};

/** macOS「終端機」內建的 Clear Dark 描述檔（從它的設定檔讀出的色碼，不含半透明）。 */
const CLEAR_DARK_TERMINAL: ITheme = {
  background: "#191d27",
  foreground: "#e0e0e0",
  selectionBackground: "#273d4c",
  black: "#35424c",
  red: "#b45648",
  green: "#6caa71",
  yellow: "#c4ac62",
  blue: "#6d96b4",
  magenta: "#bd7bcd",
  cyan: "#7ccbcd",
  white: "#dee5eb",
  brightBlack: "#465c6d",
  brightRed: "#df6c5a",
  brightGreen: "#79be7e",
  brightYellow: "#e5c872",
  brightBlue: "#67b5ed",
  brightMagenta: "#d389e5",
  brightCyan: "#84dde0",
  brightWhite: "#e5eff5",
};

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 兩色混合，amount 是 b 的比例（0～1）。 */
export function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  return `#${ca
    .map((v, i) => Math.round(v + (cb[i] - v) * amount))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 依終端機的背景與文字色推出外框顏色，讓分頁列、側欄和終端機看起來是同一套。 */
export function uiFromTerminal(terminal: ITheme): UiColors {
  const bg = terminal.background ?? ARGUS.ui.bg;
  const fg = terminal.foreground ?? ARGUS.ui.text;
  return {
    bg,
    panel: mix(bg, fg, 0.04),
    border: mix(bg, fg, 0.12),
    hover: mix(bg, fg, 0.08),
    text: fg,
    muted: mix(fg, bg, 0.45),
  };
}

/** 外來配色（「終端機」設定）補上 Argus 的游標色，缺的顏色用 Argus 的。 */
export function themeFromTerminal(terminal: ITheme): Theme {
  const full: ITheme = {
    ...ARGUS.terminal,
    ...terminal,
    cursor: terminal.cursor ?? ACCENT,
    cursorAccent: terminal.background ?? ARGUS.terminal.cursorAccent,
  };
  return { terminal: full, ui: uiFromTerminal(full) };
}

export const BUILT_IN: Record<Exclude<ThemeId, "terminal-app">, Theme> = {
  argus: ARGUS,
  "clear-dark": themeFromTerminal(CLEAR_DARK_TERMINAL),
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as string[]).includes(value);
}

/** 套用外框顏色：改 :root 上的 CSS 變數，Tailwind 的 deck-* 顏色就會跟著變。 */
export function applyUi(ui: UiColors) {
  const root = document.documentElement.style;
  root.setProperty("--color-deck-bg", ui.bg);
  root.setProperty("--color-deck-panel", ui.panel);
  root.setProperty("--color-deck-border", ui.border);
  root.setProperty("--color-deck-hover", ui.hover);
  root.setProperty("--color-deck-text", ui.text);
  root.setProperty("--color-deck-muted", ui.muted);
}
