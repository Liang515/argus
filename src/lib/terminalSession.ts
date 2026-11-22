import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ILink, type ITheme, Terminal } from "@xterm/xterm";
import type { AgentId } from "./agents";
import { handleEditKeyEvent } from "./editKeys";
import { findPathCandidates, lineText } from "./filePaths";
import { t } from "./i18n";
import {
  backgroundSessionId,
  type ClaudeStatus,
  DECK_OSC,
  looksLikePermissionPrompt,
  parseArgusOsc,
  stripAnsi,
} from "./status";
import { shortcutAction } from "./tabs";
import { BUILT_IN } from "./themes";

const ENTER_DELAY_MS = 80;
/** 送出 claude --resume 後留意「背景執行中」訊息的時間（包含在清單裡挑對話的時間） */
const RESUME_WATCH_MS = 120_000;
/** 偵測到後最多等 shell 回到前景的次數與間隔 */
const ATTACH_RETRIES = 10;
const ATTACH_RETRY_MS = 200;

/** 備援偵測保留的尾端文字長度，避免提示字被切在兩批輸出之間。 */
const FALLBACK_TAIL = 300;

/** 新開的分頁用目前選的配色（App 啟動與切換配色時更新）。 */
let currentTheme: ITheme = BUILT_IN.argus.terminal;

export function setDefaultTerminalTheme(theme: ITheme) {
  currentTheme = theme;
}

function toBytes(data: unknown): Uint8Array | string {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data);
  return String(data);
}

/**
 * 一個分頁的終端機：xterm 實例與後端 PTY 的連線。
 * 生命週期獨立於 React，切換分頁時只是隱藏，不會中斷背景 shell。
 */
export class TerminalSession {
  readonly element = document.createElement("div");
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private opened = false;
  private running = false;
  private disposed = false;
  private status: ClaudeStatus = "off";
  private agent: AgentId = "claude";
  /** 在這個時間之前，留意「對話在背景執行中」的訊息（Argus 剛送出 claude --resume） */
  private resumeWatchUntil = 0;
  private resumeTail = "";
  /** 最近一次由 Argus 啟動的 agent：沒有 hook 的 agent（Codex）靠文字偵測時，用它標示燈號。 */
  private lastLaunched: AgentId = "claude";
  /** 收過 hook 訊號後就以 hook 為準，不再用文字比對。 */
  private hooksSeen = false;
  private readonly decoder = new TextDecoder();
  private tail = "";
  /** shell 還沒啟動時要執行的指令（例如新分頁直接開 agent）。 */
  private pending: string | null = null;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly onStatus: (id: string, status: ClaudeStatus, agent: AgentId) => void,
  ) {
    this.element.style.height = "100%";
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: '"SF Mono", Menlo, Monaco, "PingFang TC", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10000,
      // 只有正在打字的分頁閃游標（見 setBlink），背景分頁不必一直重繪
      cursorBlink: false,
      macOptionIsMeta: true,
      theme: currentTheme,
    });
    this.term.loadAddon(this.fitAddon);
    // 網址和檔案路徑一樣要 ⌘＋點擊才開，一般點擊留給選取文字；只開 http(s)
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey && /^https?:\/\//i.test(uri)) void openUrl(uri);
      }),
    );
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.registerLinkProvider({
      provideLinks: (y, callback) => void this.pathLinks(y).then(callback),
    });
    this.term.parser.registerOscHandler(DECK_OSC, (data) => {
      const parsed = parseArgusOsc(data);
      if (parsed) {
        this.hooksSeen = true;
        // 有 hook 事件代表 Claude 已經在這個分頁跑起來了，不必再等「背景執行中」的訊息
        this.resumeWatchUntil = 0;
        this.setStatus(parsed.status, parsed.agent);
      }
      return true;
    });

    this.term.attachCustomKeyEventHandler((e) => {
      // App 快捷鍵不送進 shell，交給 window 上的監聽處理
      if (shortcutAction(e)) return false;
      // ⌘← ⌘→ ⇧↩ 等編輯鍵：keydown 時送對應按鍵，其他事件也攔下，避免重複輸入
      const passThrough = handleEditKeyEvent(e, (edit) => {
        if (edit.type === "select-all") this.term.selectAll();
        else if (this.running) this.send(edit.data);
      });
      if (!passThrough) return false;
      return true;
    });
    this.term.onData((data) => {
      if (!this.hooksSeen && this.status === "needs-input") this.setStatus("off");
      if (this.running) this.send(data);
      else if (data === "\r") void this.start();
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.running) void invoke("pty_resize", { id: this.id, cols, rows }).catch(() => {});
    });
  }

  /** 第一次掛到 DOM 時才開啟 xterm 與 PTY（需要實際尺寸）。 */
  attach(host: HTMLElement) {
    if (this.element.parentElement !== host) host.appendChild(this.element);
    if (this.opened || this.disposed) return;
    this.opened = true;
    this.term.open(this.element);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // WebGL 不可用時退回預設 DOM renderer
    }
    this.fit();
    void this.start();
  }

  fit() {
    if (!this.opened || this.element.clientWidth === 0) return;
    this.fitAddon.fit();
  }

  focus() {
    this.term.focus();
  }

  setTheme(theme: ITheme) {
    this.term.options.theme = theme;
  }

  setBlink(on: boolean) {
    if (this.term.options.cursorBlink !== on) this.term.options.cursorBlink = on;
  }

  /**
   * 輸入一行指令並送出（shell 或 Claude 的輸入框都適用）。
   * Enter 稍後才送：整串一起送會被 Claude 當成貼上，Enter 變成換行而不是送出。
   */
  run(command: string) {
    if (this.running) {
      this.send(command);
      window.setTimeout(() => this.send("\r"), ENTER_DELAY_MS);
    }
    this.focus();
  }

  /**
   * 接下來幾秒留意 `claude --resume` 的回應：要接續的對話若已經在背景執行
   * （例如之前關掉 Argus 時 Claude 還在工作），自動改用 `claude attach` 接上。
   */
  watchResume() {
    this.resumeWatchUntil = Date.now() + RESUME_WATCH_MS;
    this.resumeTail = "";
  }

  /**
   * 等 `claude --resume` 退回 shell 再送 `claude attach`。前景還有程式（例如 Claude 正常接上了對話）
   * 就不送，避免把指令打進正在進行的對話裡。
   */
  private async attachWhenShellIsBack(id: string) {
    for (let i = 0; i < ATTACH_RETRIES; i++) {
      await new Promise((r) => window.setTimeout(r, ATTACH_RETRY_MS));
      const busy = await invoke<boolean>("pty_is_busy", { id: this.id }).catch(() => true);
      if (!busy) {
        this.run(`claude attach ${id}`);
        return;
      }
    }
  }

  /** 記下這個分頁接下來啟動的是哪個 agent（給沒有 hook 的 agent 標燈號用）。 */
  launched(agent: AgentId) {
    this.lastLaunched = agent;
  }

  /** 和 run 一樣，但 shell 還沒啟動時先記著，啟動後再送。 */
  runWhenReady(command: string) {
    if (this.running) this.run(command);
    else this.pending = command;
  }

  handleExit() {
    if (!this.running) return;
    this.running = false;
    this.hooksSeen = false;
    this.setStatus("off");
    this.term.write(`\r\n\x1b[2m${t("term.exited")}\x1b[0m\r\n`);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    void invoke("pty_kill", { id: this.id }).catch(() => {});
    this.term.dispose();
    this.element.remove();
  }

  /**
   * agent 已經離開（例如 agy 沒有結束事件、Claude 當掉），但燈號還停在舊狀態時，
   * 由外部確認 shell 已回到前景後呼叫，把狀態清掉。
   */
  clearStaleStatus() {
    this.hooksSeen = false;
    this.setStatus("off", this.agent);
  }

  /**
   * 這一行裡確實存在的檔案路徑變成連結（相對路徑以分頁的專案資料夾為準）。
   * ⌘＋點擊開啟（資料夾開在 Finder），⌘⌥＋點擊在 Finder 顯示；一般點擊留給選取文字。
   */
  private async pathLinks(y: number): Promise<ILink[] | undefined> {
    const line = this.term.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    const cells = Array.from({ length: line.length }, (_, x) => line.getCell(x)).filter(
      (c) => c !== undefined,
    );
    const { text, col, width } = lineText(cells);
    const found = findPathCandidates(text);
    if (found.length === 0) return undefined;
    const resolved = await invoke<({ path: string; isDir: boolean } | null)[]>("resolve_paths", {
      base: this.cwd,
      candidates: found.map((c) => c.path),
    }).catch(() => []);
    const links: ILink[] = [];
    found.forEach((c, i) => {
      const target = resolved[i];
      if (!target) return;
      const last = c.end - 1;
      links.push({
        range: { start: { x: col[c.start] + 1, y }, end: { x: col[last] + width[last], y } },
        text: text.slice(c.start, c.end),
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => {
          if (!event.metaKey) return;
          void invoke("open_path", {
            path: target.path,
            reveal: event.altKey,
            line: c.line ?? null,
            column: c.column ?? null,
          }).catch(() => {});
        },
      });
    });
    return links.length > 0 ? links : undefined;
  }

  /** agent 預設 Claude：文字備援偵測只認得 Claude 的權限提示。 */
  private setStatus(status: ClaudeStatus, agent: AgentId = "claude") {
    if (status === this.status && agent === this.agent) return;
    this.status = status;
    this.agent = agent;
    this.onStatus(this.id, status, agent);
  }

  private receive(data: unknown) {
    const bytes = toBytes(data);
    this.term.write(bytes);
    const watching = Date.now() < this.resumeWatchUntil;
    if (this.hooksSeen && !watching) return;
    const text = typeof bytes === "string" ? bytes : this.decoder.decode(bytes, { stream: true });
    const chunk = stripAnsi(text);
    if (watching) {
      this.resumeTail = (this.resumeTail + chunk).slice(-FALLBACK_TAIL);
      const id = backgroundSessionId(this.resumeTail);
      if (id) {
        this.resumeWatchUntil = 0;
        this.resumeTail = "";
        void this.attachWhenShellIsBack(id);
      }
    }
    if (this.hooksSeen) return;
    const plain = (this.tail + chunk).slice(-FALLBACK_TAIL * 2);
    if (looksLikePermissionPrompt(plain)) {
      this.setStatus("needs-input", this.lastLaunched);
      this.tail = "";
    } else {
      this.tail = plain.slice(-FALLBACK_TAIL);
    }
  }

  private send(data: string) {
    void invoke("pty_write", { id: this.id, data }).catch(() => {});
  }

  private async start() {
    if (this.disposed) return;
    const onData = new Channel<unknown>();
    onData.onmessage = (data) => this.receive(data);
    this.running = true;
    try {
      const cwdMissing = await invoke<boolean>("pty_spawn", {
        id: this.id,
        cwd: this.cwd,
        cols: this.term.cols,
        rows: this.term.rows,
        onData,
      });
      if (cwdMissing) {
        this.term.write(`\x1b[33m${t("term.cwdMissing", { path: this.cwd })}\x1b[0m\r\n`);
      }
      // 建立 PTY 的期間若視窗或側欄改變大小，那次 pty_resize 會因為 PTY 還不存在而失敗，
      // agent 就一直用舊寬度排版、重畫時留下殘影。建好後補送一次目前尺寸（尺寸沒變時不會通知程式）。
      void invoke("pty_resize", {
        id: this.id,
        cols: this.term.cols,
        rows: this.term.rows,
      }).catch(() => {});
      if (this.pending) {
        this.run(this.pending);
        this.pending = null;
      }
    } catch (err) {
      this.running = false;
      this.term.write(`\r\n\x1b[31m${t("term.startFailed", { err: String(err) })}\x1b[0m\r\n`);
    }
  }
}
