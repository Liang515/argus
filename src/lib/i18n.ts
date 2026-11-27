import { platformText } from "./platform";

/** 介面語言：依系統偏好語言的順序，先遇到中文就用繁體中文，先遇到英文或都沒有就用英文。 */
export type Lang = "zh-TW" | "en";

export function detectLang(languages: readonly string[]): Lang {
  for (const l of languages) {
    const code = l.toLowerCase();
    if (code.startsWith("zh")) return "zh-TW";
    if (code.startsWith("en")) return "en";
  }
  return "en";
}

const zh = {
  "status.idle": "待命中",
  "status.running": "執行中",
  "status.needsInput": "等待你確認",
  "status.done": "已完成",

  "term.exited": "[shell 已結束，按 Enter 重新啟動]",
  "term.startFailed": "無法啟動 shell：{err}",
  "term.cwdMissing": "找不到資料夾 {path}，已改在家目錄開啟。",

  "open.failedTitle": "開啟失敗",
  "open.failed": "無法用 {app} 開啟：{err}",

  "tab.dragHint": "拖曳可調整順序（⌘⇧← →）",
  "tab.close": "關閉分頁",
  "tab.add": "新增專案分頁",
  "tab.addTitle": "開啟專案資料夾 (⌘T)",
  "tab.shortcuts": "鍵盤快捷鍵",
  "tab.shortcutsTitle": "鍵盤快捷鍵 (⌘/)",
  "tab.allTabs": "全部分頁",
  "tab.hiddenCount": "還有 {count} 個分頁不在畫面上，點開看全部分頁",

  "palette.folderMissing": "找不到資料夾：{path}",
  "palette.placeholder": "搜尋專案或動作，或輸入路徑（~/…）開新分頁",
  "palette.hintSelect": "↑↓ 選擇",
  "palette.hintOpen": "↵ 開啟",
  "palette.hintClose": "esc 關閉",
  "palette.hintAll": "⌘/ 所有快捷鍵",
  "palette.browse": "瀏覽其他資料夾…",
  "palette.openPath": "開啟 {path}",

  "side.openWith": "用 {app} 開啟這個專案",
  "side.editor": "編輯器",
  "custom.run": "執行 {name}（{cmd}）",
  "custom.edit": "編輯自訂 agent（~/.argus/agents.json）",
  "custom.editFailed": "無法打開自訂 agent 設定檔：{err}",
  "custom.heading": "自訂",
  "side.pickEditor": "選擇編輯器",
  "side.editorFooter": "選過的會記住，⌘＋點擊檔案路徑也用它開",
  "side.notInstalled": "還沒安裝 {app}。點一下打開下載頁，裝好後切回 Argus 就能一鍵開啟專案",
  "side.gitChanges": "Git 變更",
  "side.tabActivity": "活動",
  "side.tabChanges": "變更",
  "side.tabHandoff": "交接",
  "act.empty": "Claude 或 Antigravity 開始工作後，這裡會即時顯示計畫和每一步動作。",
  "act.plan": "計畫",
  "act.recent": "最近動作",
  "act.you": "你",
  "act.read": "讀取",
  "act.edit": "修改",
  "act.write": "寫入",
  "act.run": "執行",
  "act.search": "搜尋",
  "act.web": "網路",
  "act.agent": "子任務",
  "act.other": "工具",
  "act.expand": "點一下看完整內容",
  "act.collapse": "點一下收起",
  "act.openFile": "用編輯器打開這個檔案",
  "side.refreshGit": "重新整理 git 變更",
  "side.loading": "讀取中…",
  "side.notRepo": "不是 git repo",
  "side.noChanges": "沒有未提交的變更",
  "side.handoffPitch":
    "讓 agent 每做完一段就把進度寫進 HANDOFF.md，這裡會即時顯示，換人或換 agent 接手也不會斷。",
  "side.handoffTitle": "在專案根目錄的 CLAUDE.md 加上交接規則（沒有就建立），下次開對話時生效",
  "side.handoffButton": "在 CLAUDE.md 加入交接規則",
  "side.image": "[圖片：{alt}]",
  "side.noDoc": "專案根目錄還沒有 HANDOFF.md 或 CLAUDE.md。",

  "agent.newChat": "新對話",
  "agent.newChatTitle": "清掉目前對話，重新開始（{cmd}；舊對話之後還能用「切換對話」找回）",
  "agent.switch": "切換對話",
  "agent.switchTitle": "切換到這個專案的其他 {agent} 對話（{cmd}）",
  "agent.handoffPrompt":
    "交接：更新專案根目錄的 HANDOFF.md（目前狀態、變更檔案、待辦下一步），寫完就停，不要繼續做其他事。",
  "agent.handoffWriting": "交接中…",
  "agent.handoffReady": "交接完成",
  "agent.handoffClear": "清除對話",
  "agent.handoffClearTitle": "清掉目前對話（{cmd}），下一個對話從 HANDOFF.md 接手",
  "agent.handoffCancel": "取消",
  "agent.handoffCancelTitle": "不清除，留在目前對話",
  "agent.install": "安裝 agent",
  "agent.installTitle": "還沒安裝任何 agent，看看怎麼安裝",
  "agent.installFooter": "裝好後切回 Argus，這裡就能直接啟動",
  "agent.startTitle": "在這個分頁啟動 {agent}（{cmd}）",
  "agent.defaultFooter": "選過的會變成這個分頁的預設",
  "agent.pickOther": "選擇其他 agent",
  "agent.resume": "接續",
  "agent.resumeTitle": "從過去的 {agent} 對話挑一個接續（{cmd}）",
  "agent.newTabFooter": "在同資料夾的新分頁開，不影響這個分頁",
  "agent.newTabTitle": "在新分頁開其他 agent",
  "agent.notInstalled": "未安裝",
  "agent.notInstalledTitle": "還沒安裝 {agent}，點一下看怎麼安裝",
  "agent.installHeading": "安裝 {agent}",
  "agent.installRun": "在新分頁執行",
  "agent.installCopy": "複製",
  "agent.installCopied": "已複製",
  "agent.installHint":
    "會開一個新分頁並打好這行官方安裝指令，確認後按 Enter 執行。裝好後打開這個選單，就能直接啟動。",
  "agent.installDocs": "看官方安裝說明 ↗",

  "app.pickFolder": "選擇專案資料夾",
  "app.worktreeFailed": "無法建立 worktree",
  "app.closeBusy": "這個分頁還有程式在執行（例如 agent），確定要關閉嗎？",
  "app.closeTab": "關閉分頁",
  "app.quitTitle": "結束 Argus",
  "app.quitBusy":
    "{count} 個分頁還有程式在執行。結束會關閉這些終端機，執行中的指令會被中斷；Claude Code 的對話之後仍可用「接續」找回。要結束 Argus 嗎？",
  "app.quitOk": "結束",
  "app.cancel": "取消",
  "update.button": "新版 v{version}",
  "update.buttonTitle": "有新版本 v{version}，點一下下載、安裝並重開 Argus",
  "update.installing": "更新中…",
  "update.title": "更新到 v{version}",
  "update.busy":
    "{count} 個分頁還有程式在執行。更新會重開 Argus，執行中的指令會被中斷；Claude Code 的對話之後仍可用「接續」找回。要更新嗎？",
  "update.ok": "更新並重開",
  "update.failed": "更新失敗",
  "app.dupSame": "同一個資料夾（共用檔案，適合看 log、跑指令）",
  "app.dupWorktree": "新的 git worktree（獨立資料夾與分支，兩個 agent 不會互相覆蓋）",
  "app.dupPlaceholder": "在目前專案再開一個分頁…",
  "app.hideSidebar": "隱藏側欄",
  "app.zoomIn": "放大終端機字體",
  "app.zoomOut": "縮小終端機字體",
  "app.zoomReset": "終端機字體恢復預設大小",
  "app.showSidebar": "顯示側欄",
  "app.shortcutHelp": "鍵盤快捷鍵說明",
  "app.openIn": "用 {app} 開啟目前專案",
  "app.run": "執行 {agent}（{cmd}）",
  "app.resumePast": "接續過去的 {agent} 對話（{cmd}）",
  "app.agentNew": "{agent} 新對話（{cmd}）",
  "app.agentSwitch": "切換 {agent} 對話（{cmd}）",
  "app.agentHandoff": "{agent} 交接（寫好 HANDOFF.md 後再確認清除對話）",
  "app.handoffClear": "交接完成：清除 {agent} 對話（{cmd}）",
  "app.handoffCancel": "取消交接，留在目前對話",
  "app.runInNewTab": "在新分頁執行 {agent}（{cmd}）",
  "app.anotherTab": "再開一個分頁：{label}",
  "app.closeCurrent": "關閉目前分頁",
  "theme.pick": "配色：{name}",
  "theme.argus": "Argus",
  "theme.clearDark": "Clear Dark",
  "theme.terminalApp": "跟隨「終端機」App",
  "app.emptyTitle": "開啟一個專案資料夾開始工作",
  "app.openFolder": "開啟專案資料夾",
  "app.justTerminal": "或 直接開一個終端機",
  "app.emptySearch": "搜尋、切換專案",
  "app.emptySidebar": "開關右側看板",
  "app.emptyAll": "所有快捷鍵",

  "help.title": "鍵盤快捷鍵",
  "help.close": "按 esc 或 ⌘/ 關閉",
  "help.tabs": "分頁",
  "help.tabs.open": "開啟專案資料夾",
  "help.tabs.duplicate": "在目前專案再開一個分頁（同資料夾或 worktree）",
  "help.tabs.close": "關閉分頁（有程式在跑會先問）",
  "help.tabs.jump": "跳到第 N 個分頁",
  "help.tabs.last": "跳到最後一個分頁",
  "help.tabs.prevNext": "上一個／下一個分頁",
  "help.tabs.move": "把目前分頁往左／往右移（也可以用滑鼠拖曳）",
  "help.panels": "切換與面板",
  "help.panels.palette": "切換器：搜尋專案、動作，或輸入路徑開新分頁",
  "help.panels.sidebar": "開關右側看板",
  "help.panels.help": "顯示這份快捷鍵說明",
  "help.panels.themeKeys": "⌘K 搜尋「配色」",
  "help.panels.zoom": "放大／縮小終端機字體，⌘0 恢復預設",
  "help.panels.theme": "切換配色（Argus、Clear Dark、跟隨「終端機」）",
  "help.panels.themeWin": "切換配色（Argus、Clear Dark）",
  "help.palette": "切換器裡",
  "help.palette.select": "選擇",
  "help.palette.open": "開啟",
  "help.palette.close": "關閉",
  "help.typing": "輸入時",
  "help.typing.lineEnds": "移到行首／行尾",
  "help.typing.words": "往左／往右跳一個字",
  "help.typing.deleteLine": "刪除游標前的整行",
  "help.typing.selectAll": "全選終端機內容（可接著 ⌘C 複製）",
  "help.typing.newline": "在 Claude Code 輸入框換行（不送出）",
  "help.typing.copy": "複製選取的文字（有選取時 Ctrl+C 也可以）",
  "help.typing.paste": "貼上",
  "help.links": "連結",
  "help.links.openKeys": "⌘＋點擊路徑",
  "help.links.open":
    "開啟檔案：程式碼用 VS Code／Antigravity 並跳到行號，HTML 用瀏覽器預覽，資料夾開在 Finder",
  "help.links.revealKeys": "⌘⌥＋點擊路徑",
  "help.links.reveal": "在 Finder 顯示並選取",
  "help.links.urlKeys": "⌘＋點擊網址",
  "help.links.url": "用瀏覽器開啟",
  "help.agents": "Agent",
  "help.agents.buttonsKeys": "右上按鈕",
  "help.agents.ownKeys": "Claude／Antigravity 裡按 ?",
  "help.agents.own": "查看 agent 自己的按鍵（例如 Claude 的 ⇧Tab 切換模式）",
  "help.agents.buttons":
    "沒有 agent：啟動／接續；Claude／Antigravity 閒置：新對話／切換對話；agent 執行中：在新分頁開其他 agent",

  "err.dir_missing": "資料夾不存在",
  "err.file_missing": "檔案不存在",
  "err.open_failed": "無法開啟",
  "err.app_missing": "找不到對應的 App，請確認已安裝",
  "err.not_git": "這個資料夾不是 git repo，無法建立 worktree",
  "err.git_failed": "無法執行 git：{detail}",
  "err.worktree_failed": "建立 worktree 失敗：{detail}",
  "err.read_claude_md": "讀取 CLAUDE.md 失敗：{detail}",
  "err.write_claude_md": "寫入 CLAUDE.md 失敗：{detail}",
  "err.no_home": "找不到家目錄",
  "err.no_worktree_name": "找不到可用的 worktree 名稱",
  "recap.title": "近況",
  "recap.placeholder": "搜尋專案或做過的事",
  "recap.empty": "還沒有紀錄。agent 在專案裡動作後，這裡會列出最後一句指令和改過的檔案。",
  "recap.noMatch": "沒有符合的專案",
  "recap.noPrompt": "（沒有記到指令）",
  "recap.promptBy": "{agent}：",
  "recap.files": "改了 {count} 個檔：{names}",
  "recap.filesOne": "改了 1 個檔：{names}",
  "recap.filesEarlier": "上一輪改了 {count} 個檔：{names}",
  "recap.filesEarlierOne": "上一輪改了 1 個檔：{names}",
  "recap.uncommitted": "{count} 個未提交",
  "recap.closed": "分頁已關",
  "recap.hintOpen": "↵ 切過去",
  "recap.justNow": "剛剛",
  "recap.minutes": "{n} 分鐘前",
  "recap.hours": "{n} 小時前",
  "recap.yesterday": "昨天",
  "recap.days": "{n} 天前",
  "help.panels.recap": "近況：各專案最近做了什麼、做到哪",
  "app.emptyRecap": "各專案最近做了什麼",
} as const;

export type MessageKey = keyof typeof zh;

/** 所有文字的鍵，測試用來檢查中英文是否對齊。 */
export const MESSAGE_KEYS = Object.keys(zh) as MessageKey[];

const en: Record<MessageKey, string> = {
  "status.idle": "Idle",
  "status.running": "Running",
  "status.needsInput": "Waiting for you",
  "status.done": "Done",

  "term.exited": "[shell exited, press Enter to restart]",
  "term.startFailed": "Couldn't start the shell: {err}",
  "term.cwdMissing": "Folder {path} not found, opened in your home folder instead.",

  "open.failedTitle": "Couldn't open",
  "open.failed": "Couldn't open with {app}: {err}",

  "tab.dragHint": "Drag to reorder (⌘⇧← →)",
  "tab.close": "Close tab",
  "tab.add": "New project tab",
  "tab.addTitle": "Open a project folder (⌘T)",
  "tab.shortcuts": "Keyboard shortcuts",
  "tab.shortcutsTitle": "Keyboard shortcuts (⌘/)",
  "tab.allTabs": "All tabs",
  "tab.hiddenCount": "{count} more tab(s) out of view. Click to see all tabs",

  "palette.folderMissing": "Folder not found: {path}",
  "palette.placeholder": "Search projects or actions, or type a path (~/…) to open it",
  "palette.hintSelect": "↑↓ select",
  "palette.hintOpen": "↵ open",
  "palette.hintClose": "esc close",
  "palette.hintAll": "⌘/ all shortcuts",
  "palette.browse": "Browse for a folder…",
  "palette.openPath": "Open {path}",

  "side.openWith": "Open this project in {app}",
  "side.editor": "Editor",
  "custom.run": "Run {name} ({cmd})",
  "custom.edit": "Edit custom agents (~/.argus/agents.json)",
  "custom.editFailed": "Couldn't open the custom agents file: {err}",
  "custom.heading": "Custom",
  "side.pickEditor": "Choose editor",
  "side.editorFooter": "Remembered, and used for ⌘-clicked file paths too",
  "side.notInstalled":
    "{app} isn't installed. Click to open its download page. Once it's installed, come back to Argus to open projects in it.",
  "side.gitChanges": "Git changes",
  "side.tabActivity": "Activity",
  "side.tabChanges": "Changes",
  "side.tabHandoff": "Handoff",
  "act.empty":
    "Once Claude or Antigravity starts working, its plan and each step show up here as they happen.",
  "act.plan": "Plan",
  "act.recent": "Recent",
  "act.you": "You",
  "act.read": "Read",
  "act.edit": "Edit",
  "act.write": "Write",
  "act.run": "Run",
  "act.search": "Search",
  "act.web": "Web",
  "act.agent": "Agent",
  "act.other": "Tool",
  "act.expand": "Click to see the full text",
  "act.collapse": "Click to collapse",
  "act.openFile": "Open this file in your editor",
  "side.refreshGit": "Refresh Git changes",
  "side.loading": "Loading…",
  "side.notRepo": "Not a Git repository",
  "side.noChanges": "No uncommitted changes",
  "side.handoffPitch":
    "Have the agent write its progress to HANDOFF.md after each step. It shows up here as it changes, so another person or agent can pick up where it left off.",
  "side.handoffTitle":
    "Adds handoff rules to CLAUDE.md in the project root (creates it if needed). Takes effect in the next conversation.",
  "side.handoffButton": "Add handoff rules to CLAUDE.md",
  "side.image": "[image: {alt}]",
  "side.noDoc": "No HANDOFF.md or CLAUDE.md in the project root yet.",

  "agent.newChat": "New chat",
  "agent.newChatTitle":
    "Clear the conversation and start over ({cmd}). Earlier conversations stay available under Switch chat.",
  "agent.switch": "Switch chat",
  "agent.switchTitle": "Switch to another {agent} conversation in this project ({cmd})",
  "agent.handoffPrompt":
    "Handoff: update HANDOFF.md in the project root (current status, modified files, next steps), then stop without doing anything else.",
  "agent.handoffWriting": "Handing off…",
  "agent.handoffReady": "Handoff done",
  "agent.handoffClear": "Clear chat",
  "agent.handoffClearTitle":
    "Clear this conversation ({cmd}); the next one picks up from HANDOFF.md",
  "agent.handoffCancel": "Cancel",
  "agent.handoffCancelTitle": "Keep the current conversation",
  "agent.install": "Install an agent",
  "agent.installTitle": "No agent is installed yet. See how to install one",
  "agent.installFooter": "Once installed, come back to Argus to start it here",
  "agent.startTitle": "Start {agent} in this tab ({cmd})",
  "agent.defaultFooter": "Your choice becomes this tab's default",
  "agent.pickOther": "Choose another agent",
  "agent.resume": "Resume",
  "agent.resumeTitle": "Pick a past {agent} conversation to continue ({cmd})",
  "agent.newTabFooter": "Opens in a new tab for the same folder; this tab is left alone",
  "agent.newTabTitle": "Open an agent in a new tab",
  "agent.notInstalled": "Not installed",
  "agent.notInstalledTitle": "{agent} isn't installed. Click to see how to install it",
  "agent.installHeading": "Install {agent}",
  "agent.installRun": "Run in a new tab",
  "agent.installCopy": "Copy",
  "agent.installCopied": "Copied",
  "agent.installHint":
    "Opens a new tab with the official install command typed in. Check it, then press Enter. Once installed, open this menu again to start it.",
  "agent.installDocs": "Official install guide ↗",

  "app.pickFolder": "Choose a project folder",
  "app.worktreeFailed": "Couldn't create the worktree",
  "app.closeBusy": "Something is still running in this tab (such as an agent). Close it anyway?",
  "app.closeTab": "Close tab",
  "app.quitTitle": "Quit Argus",
  "app.quitBusy":
    "{count} tab(s) still have something running. Quitting closes these terminals and interrupts running commands; Claude Code conversations can still be resumed later. Quit Argus?",
  "app.quitOk": "Quit",
  "app.cancel": "Cancel",
  "update.button": "Update v{version}",
  "update.buttonTitle":
    "Version v{version} is available. Click to download, install and restart Argus",
  "update.installing": "Updating…",
  "update.title": "Update to v{version}",
  "update.busy":
    "{count} tab(s) still have something running. Updating restarts Argus and interrupts running commands; Claude Code conversations can still be resumed later. Update now?",
  "update.ok": "Update and restart",
  "update.failed": "Update failed",
  "app.dupSame": "Same folder (shared files; good for logs and commands)",
  "app.dupWorktree":
    "New Git worktree (its own folder and branch, so two agents don't overwrite each other)",
  "app.dupPlaceholder": "Open another tab for this project…",
  "app.hideSidebar": "Hide sidebar",
  "app.zoomIn": "Make terminal text bigger",
  "app.zoomOut": "Make terminal text smaller",
  "app.zoomReset": "Reset terminal text size",
  "app.showSidebar": "Show sidebar",
  "app.shortcutHelp": "Keyboard shortcuts",
  "app.openIn": "Open current project in {app}",
  "app.run": "Run {agent} ({cmd})",
  "app.resumePast": "Resume a past {agent} conversation ({cmd})",
  "app.agentNew": "New {agent} conversation ({cmd})",
  "app.agentSwitch": "Switch {agent} conversation ({cmd})",
  "app.agentHandoff": "{agent} handoff (write HANDOFF.md, then confirm clearing the chat)",
  "app.handoffClear": "Handoff done: clear the {agent} conversation ({cmd})",
  "app.handoffCancel": "Cancel handoff and keep the current conversation",
  "app.runInNewTab": "Run {agent} in a new tab ({cmd})",
  "app.anotherTab": "Another tab: {label}",
  "app.closeCurrent": "Close current tab",
  "theme.pick": "Theme: {name}",
  "theme.argus": "Argus",
  "theme.clearDark": "Clear Dark",
  "theme.terminalApp": "Match the Terminal app",
  "app.emptyTitle": "Open a project folder to get started",
  "app.openFolder": "Open project folder",
  "app.justTerminal": "or just open a terminal",
  "app.emptySearch": "Search and switch projects",
  "app.emptySidebar": "Show or hide the sidebar",
  "app.emptyAll": "All shortcuts",

  "help.title": "Keyboard shortcuts",
  "help.close": "Press esc or ⌘/ to close",
  "help.tabs": "Tabs",
  "help.tabs.open": "Open a project folder",
  "help.tabs.duplicate": "Another tab for this project (same folder or a worktree)",
  "help.tabs.close": "Close the tab (asks first if something is running)",
  "help.tabs.jump": "Go to tab N",
  "help.tabs.last": "Go to the last tab",
  "help.tabs.prevNext": "Previous / next tab",
  "help.tabs.move": "Move the tab left / right (or drag it)",
  "help.panels": "Switcher and panels",
  "help.panels.palette": "Switcher: search projects and actions, or type a path to open it",
  "help.panels.sidebar": "Show or hide the sidebar",
  "help.panels.help": "Show these shortcuts",
  "help.panels.themeKeys": "⌘K, search “theme”",
  "help.panels.zoom": "Bigger / smaller terminal text; ⌘0 resets",
  "help.panels.theme": "Change the color theme (Argus, Clear Dark, match Terminal)",
  "help.panels.themeWin": "Change the color theme (Argus, Clear Dark)",
  "help.palette": "In the switcher",
  "help.palette.select": "Select",
  "help.palette.open": "Open",
  "help.palette.close": "Close",
  "help.typing": "While typing",
  "help.typing.lineEnds": "Line start / end",
  "help.typing.words": "Back / forward one word",
  "help.typing.deleteLine": "Delete to line start",
  "help.typing.selectAll": "Select the whole terminal (then ⌘C to copy)",
  "help.typing.newline": "New line in Claude Code's input without sending",
  "help.typing.copy": "Copy the selection (Ctrl+C works too while text is selected)",
  "help.typing.paste": "Paste",
  "help.links": "Links",
  "help.links.openKeys": "⌘-click a path",
  "help.links.open":
    "Open the file: code in VS Code / Antigravity at the line, HTML in your browser, folders in Finder",
  "help.links.revealKeys": "⌘⌥-click a path",
  "help.links.reveal": "Reveal in Finder",
  "help.links.urlKeys": "⌘-click a URL",
  "help.links.url": "Open in your browser",
  "help.agents": "Agents",
  "help.agents.buttonsKeys": "Top-right buttons",
  "help.agents.ownKeys": "? in Claude / Antigravity",
  "help.agents.own": "Show the agent's own keys (e.g. ⇧Tab in Claude switches modes)",
  "help.agents.buttons":
    "No agent: start / resume. Claude / Antigravity idle: new chat / switch chat. Agent busy: open another agent in a new tab",

  "err.dir_missing": "Folder not found",
  "err.file_missing": "File not found",
  "err.open_failed": "Couldn't open it",
  "err.app_missing": "App not found. Is it installed?",
  "err.not_git": "This folder isn't a Git repository, so a worktree can't be created",
  "err.git_failed": "Couldn't run git: {detail}",
  "err.worktree_failed": "Creating the worktree failed: {detail}",
  "err.read_claude_md": "Couldn't read CLAUDE.md: {detail}",
  "err.write_claude_md": "Couldn't write CLAUDE.md: {detail}",
  "err.no_home": "Home folder not found",
  "err.no_worktree_name": "No free worktree name is left",
  "recap.title": "Recent work",
  "recap.placeholder": "Search projects or what you did",
  "recap.empty":
    "Nothing yet. Once an agent works in a project, its last prompt and edited files show up here.",
  "recap.noMatch": "No matching projects",
  "recap.noPrompt": "(no prompt recorded)",
  "recap.promptBy": "{agent}: ",
  "recap.files": "{count} files edited: {names}",
  "recap.filesOne": "1 file edited: {names}",
  "recap.filesEarlier": "{count} files edited in the previous turn: {names}",
  "recap.filesEarlierOne": "1 file edited in the previous turn: {names}",
  "recap.uncommitted": "{count} uncommitted",
  "recap.closed": "tab closed",
  "recap.hintOpen": "↵ go there",
  "recap.justNow": "just now",
  "recap.minutes": "{n}m ago",
  "recap.hours": "{n}h ago",
  "recap.yesterday": "yesterday",
  "recap.days": "{n}d ago",
  "help.panels.recap": "Recent work: what each project did last and where it stopped",
  "app.emptyRecap": "Recent work across projects",
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { "zh-TW": zh, en };

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

const LANG_KEY = "argus.lang";

/** 使用者在 ⌘K 選過語言就用它，否則跟著系統。 */
export function resolveLang(saved: string | null, languages: readonly string[]): Lang {
  return saved === "zh-TW" || saved === "en" ? saved : detectLang(languages);
}

function savedLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

// 讓 <html lang> 跟著介面語言（index.html 預設寫的是繁中）
function applyHtmlLang() {
  if (typeof document !== "undefined")
    document.documentElement.lang = lang === "en" ? "en" : "zh-Hant";
}

export let lang: Lang = resolveLang(savedLang(), systemLanguages());
applyHtmlLang();

/** 切換介面語言並記住；畫面要由呼叫者重新繪製（App 會跟著重畫）。 */
export function setLang(next: Lang) {
  lang = next;
  applyHtmlLang();
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // 存不了就只在這次開啟期間有效
  }
}

export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function translate(
  language: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return format(MESSAGES[language][key], vars);
}

/** 介面上直接寫的按鍵或 App 名稱（例如 "⌘B"、"Finder"），換成目前平台的說法。 */
export function keys(text: string): string {
  return platformText(text, lang);
}

/**
 * 目前語言的文字；`{name}` 換成 vars 裡的值。
 * Windows 上把 ⌘ 按鍵與 Finder 換成對應的說法（見 platform.ts）。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return platformText(translate(lang, key, vars), lang);
}

/**
 * 後端回傳的錯誤是代碼（`dir_missing`）或「代碼: 細節」（`git_failed: …`），轉成目前語言。
 * 不認得的錯誤原樣顯示。
 */
export function translateError(err: unknown, language: Lang = lang): string {
  const text = String(err);
  const sep = text.indexOf(": ");
  const code = sep === -1 ? text : text.slice(0, sep);
  const detail = sep === -1 ? "" : text.slice(sep + 2);
  const key = `err.${code}` as MessageKey;
  return key in zh ? translate(language, key, { detail }) : text;
}
