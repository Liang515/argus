import { Channel, invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ILink, type ITheme, Terminal } from "@xterm/xterm";
import { type ActivityEvent, parseActivity } from "./activity";
import type { AgentId } from "./agents";
import { parseOsc52 } from "./clipboard";
import { handleEditKeyEvent } from "./editKeys";
import {
  findPathCandidates,
  hyperlinkTarget,
  lineText,
  pickExisting,
  URL_REGEX,
} from "./filePaths";
import { DEFAULT_FONT_SIZE } from "./fontSize";
import { t } from "./i18n";
import { isMac } from "./platform";
import { openPath } from "./project";
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

const ACTIVITY_TAG = "argus-activity;";

/** 新開的分頁用目前選的配色（App 啟動與切換配色時更新）。 */
let currentTheme: ITheme = BUILT_IN.argus.terminal;

/** 連結要按住 ⌘（Windows：Ctrl）再點才開，一般點擊留給選取文字。 */
function linkModifier(event: MouseEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

export function setDefaultTerminalTheme(theme: ITheme) {
  currentTheme = theme;
}

/** 新開的分頁用目前的字體大小（⌘＋／⌘－ 調整時更新）。 */
let currentFontSize = DEFAULT_FONT_SIZE;

export function setDefaultFontSize(size: number) {
  currentFontSize = size;
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
  private pending: { text: string; submit: boolean } | null = null;

  constructor(
    readonly id: string,
    readonly cwd: string,
    private readonly onStatus: (id: string, status: ClaudeStatus, agent: AgentId) => void,
    /** agent：送出這筆活動的 agent（hook 先送燈號再送活動，收到時已經知道是誰） */
    private readonly onActivity: (
      id: string,
      event: ActivityEvent,
      agent: AgentId,
    ) => void = () => {},
  ) {
    this.element.style.height = "100%";
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: '"SF Mono", Menlo, Monaco, "PingFang TC", monospace',
      fontSize: currentFontSize,
      lineHeight: 1.15,
      scrollback: 10000,
      // 只有正在打字的分頁閃游標（見 setBlink），背景分頁不必一直重繪
      cursorBlink: false,
      macOptionIsMeta: true,
      theme: currentTheme,
      // 程式用 OSC 8 標的超連結（agy 等）：xterm 預設會跳瀏覽器確認框再 window.open，
      // 在 App 裡打不開，所以自己處理；和其他連結一樣要 ⌘（Windows：Ctrl）＋點擊
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, uri) => {
          if (!linkModifier(event)) return;
          const target = hyperlinkTarget(uri);
          if (target?.kind === "url") void openUrl(target.url).catch(() => {});
          else if (target?.kind === "path")
            void openPath(target.path, event.altKey).catch(() => {});
        },
      },
    });
    this.term.loadAddon(this.fitAddon);
    // 網址和檔案路徑一樣要 ⌘＋點擊才開，一般點擊留給選取文字；只開 http(s)
    this.term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (linkModifier(event) && /^https?:\/\//i.test(uri)) void openUrl(uri);
        },
        { urlRegex: URL_REGEX },
      ),
    );
    // 寬度要和 agent（string-width）及 macOS「終端機」一致：⚠️ 這類「符號＋表情變體」算 2 格。
    // 舊的 Unicode 11 規則算 1 格，長對話重畫時會整個偏一行（接回對話時輸入框多一行空白）。
    this.term.loadAddon(new UnicodeGraphemesAddon());
    this.term.registerLinkProvider({
      provideLinks: (y, callback) => void this.pathLinks(y).then(callback),
    });
    this.term.parser.registerOscHandler(DECK_OSC, (data) => {
      this.handleHookOsc(data);
      return true;
    });

    // 終端機裡的程式（例如 Claude Code 選取文字後）請我們寫入剪貼簿；只寫不讀，見 clipboard.ts
    this.term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data);
      if (text !== null) void writeText(text).catch(() => {});
      return true;
    });

    this.term.attachCustomKeyEventHandler((e) => {
      // App 快捷鍵不送進 shell，交給 window 上的監聽處理
      if (shortcutAction(e)) return false;
      // ⌘← ⌘→ ⇧↩ 等編輯鍵：keydown 時送對應按鍵，其他事件也攔下，避免重複輸入
      const passThrough = handleEditKeyEvent(
        e,
        (edit) => {
          if (edit.type === "select-all") this.term.selectAll();
          else if (edit.type === "copy") {
            const text = this.term.getSelection();
            // 直接寫系統剪貼簿：WebView2 的 navigator.clipboard 不一定允許
            if (text) void writeText(text).catch(() => {});
            this.term.clearSelection();
          } else if (edit.type === "send" && this.running) this.send(edit.data);
        },
        this.term.hasSelection(),
      );
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

  /**
   * hook 送來的 OSC 7777 內容（`7777;` 之後的部分）。macOS 經終端機輸出送達；
   * Windows 經 named pipe 由後端以 `argus-hook` 事件轉來，內容相同。
   */
  handleHookOsc(data: string) {
    // 側欄「活動」的摘要（hook 和燈號一起送）
    if (data.startsWith(ACTIVITY_TAG)) {
      const event = parseActivity(data.slice(ACTIVITY_TAG.length));
      if (event) this.onActivity(this.id, event, this.agent);
      return;
    }
    const parsed = parseArgusOsc(data);
    if (parsed) {
      this.hooksSeen = true;
      // 有 hook 事件代表 Claude 已經在這個分頁跑起來了，不必再等「背景執行中」的訊息
      this.resumeWatchUntil = 0;
      this.setStatus(parsed.status, parsed.agent);
    }
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

  /** 改字體大小後重新排版，終端機欄數變了也會通知 shell 和 agent。 */
  setFontSize(size: number) {
    if (this.term.options.fontSize === size) return;
    this.term.options.fontSize = size;
    this.fit();
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
    else this.pending = { text: command, submit: true };
  }

  /** 只把指令打好、不按 Enter，讓使用者確認後自己執行（例如從網路下載的安裝指令）。 */
  typeWhenReady(command: string) {
    if (this.running) {
      this.send(command);
      this.focus();
    } else this.pending = { text: command, submit: false };
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
    // 有空白的檔名會同時有長短幾個候選，重疊的只留最長的存在路徑
    for (const i of pickExisting(
      found,
      found.map((_, i) => Boolean(resolved[i])),
    )) {
      const c = found[i];
      const target = resolved[i];
      if (!target) continue;
      const last = c.end - 1;
      links.push({
        range: { start: { x: col[c.start] + 1, y }, end: { x: col[last] + width[last], y } },
        text: text.slice(c.start, c.end),
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => {
          if (!linkModifier(event)) return;
          void openPath(target.path, event.altKey, c.line, c.column).catch(() => {});
        },
      });
    }
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
        const { text, submit } = this.pending;
        this.pending = null;
        if (submit) this.run(text);
        else {
          this.send(text);
          this.focus();
        }
      }
    } catch (err) {
      this.running = false;
      this.term.write(`\r\n\x1b[31m${t("term.startFailed", { err: String(err) })}\x1b[0m\r\n`);
    }
  }
}
