# Argus

[English](README.md)

給 coding agent 用的 macOS 終端機工作區。每個專案一個分頁，在裡面跑 Claude Code、Antigravity CLI（`agy`）或 Codex，一眼看出哪個 agent 正在工作、哪個在等你確認、哪個已經完成。

名字來自希臘神話的百眼巨人阿爾戈斯（Argus Panoptes）：睡覺時也總有幾隻眼睛睜著。

## 功能

- **每個分頁都有狀態燈**：執行中（黃色閃爍）、等你確認（紅色）、已完成（綠色）。不用切過去就知道誰需要你。
- **一個啟動器管多個 agent**：從分頁列啟動或接續 Claude Code、`agy`、Codex。分頁被占用時，選的 agent 會在同資料夾的新分頁開，不會打斷原本的。
- **專案側欄**：即時顯示 Git 變更，以及專案裡的 `HANDOFF.md`（或 `CLAUDE.md`）。
- **交接規則**：一鍵在專案的 `CLAUDE.md` 加上規則，讓 agent 隨時更新 `HANDOFF.md`。換 agent 或換人時，下一個能從上一個停下的地方接手。
- **同專案多分頁**：同一個資料夾，或新的 Git worktree，兩個 agent 不會互相覆蓋（⌘⇧T）。
- **用 VS Code、Antigravity 或 Finder 開啟專案**。沒安裝的編輯器會顯示下載連結。
- **終端機裡也能用 macOS 編輯鍵**：⌘← / ⌘→ 到行首／行尾、⌥← / ⌥→ 跳一個字、⌘⌫ 刪到行首、⇧↩ 在 Claude Code 裡換行。
- **鍵盤優先**：⌘K 切換專案與動作、⌘1–9 跳到分頁、⌘/ 看所有快捷鍵。

## 安裝

1. 從 [Releases](https://github.com/Liang515/argus/releases) 下載最新的 `Argus_*.dmg`，把 Argus 拖進「應用程式」。
2. 第一次打開時，因為 App 沒有經過 Apple 公證，macOS 會擋下來。按「完成」，到「系統設定 → 隱私權與安全性」，捲到最下面關於 Argus 的訊息，按「**強制打開**」。只需要做一次。

需求：

- macOS（Apple Silicon 或 Intel）。
- 狀態燈需要 shell 是 zsh（macOS 預設）。
- 至少一個 agent：[Claude Code](https://code.claude.com/docs/en/setup)、[Antigravity CLI](https://antigravity.google/docs/cli/install) 或 [Codex](https://developers.openai.com/codex/cli/)。沒裝的 Argus 會顯示安裝連結，裝好後就能直接用。

## Argus 會在你的電腦寫入什麼

Argus 不會改你自己的 shell 或 agent 設定，只會寫入：

- `~/.argus/`：存下的分頁、Claude Code 狀態 hook，以及 zsh 包裝：先照常載入你的 zsh 設定，再只在 Argus 分頁裡替 `claude` 加上 hook。
- `~/.gemini/config/plugins/argus/`：`agy` 的狀態外掛，只有裝了 `agy` 才會寫，在 Argus 以外不做任何事。
- 專案的 `CLAUDE.md`：只有你在側欄按「加入交接規則」時才會寫。
- 專案旁邊的 `<專案>-wt-N` 資料夾：只有你選擇用新的 Git worktree 開分頁時才會建立。

## 從原始碼 build

需要 Node.js 20 以上、Rust（stable）與 Xcode 命令列工具。

```sh
npm ci
npm run tauri dev     # 開發模式執行
npm run tauri build   # 產生 Argus.app 與 .dmg
```

預設用 ad-hoc 簽名。要用自己的憑證簽名，build 前設定環境變數 `APPLE_SIGNING_IDENTITY`。

檢查：`npm run lint`、`npm run typecheck`、`npm test`，以及在 `src-tauri/` 裡的 `cargo fmt --check`、`cargo clippy --all-targets`、`cargo test`。

## 參與貢獻

歡迎開 issue 或送 pull request。送 PR 前請先跑過上面的檢查。

## 授權

[MIT](LICENSE)
