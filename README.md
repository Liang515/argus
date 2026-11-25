# Argus

[繁體中文](README.zh-TW.md)

A terminal workspace for coding agents on macOS (and, in preview, Windows). Keep every project in its own tab, run Claude Code, Antigravity CLI (`agy`) or Codex in it, and see at a glance which agent is working, which one is waiting for you, and which one is done.

![Argus demo showing tab status lights, live Git changes, HANDOFF.md sidebar, agent launcher, and quick switcher](docs/demo.gif)

## Features

- **Status lights on every tab**: running (pulsing yellow), waiting for your confirmation (red), done (green). You don't need to switch tabs to know who needs you.
- **One launcher for several agents**: start or resume Claude Code, `agy` or Codex from the tab bar. If the tab is busy, the chosen agent opens in a new tab for the same folder instead of interrupting the current one.
- **Project sidebar** with three views: **Activity** (Claude's to-do plan with a progress bar, and each step as Claude or `agy` works: files read and edited, commands run with ✓/✗ and duration), **Changes** (live Git status) and **Handoff** (the project's `HANDOFF.md` or `CLAUDE.md`, rendered as it is updated).
- **Recent work across projects (⌘J)**: all projects sorted by last activity, showing the status light, branch, last prompt, edited files, and uncommitted Git count — the last prompt and edited files stay even after the tab is closed. Search and press Enter to jump back or reopen it.
- **Handoff protocol**: one click adds rules to the project's `CLAUDE.md` so the agent keeps `HANDOFF.md` up to date. When you switch agents or people, the next one can pick up where the last one stopped.
- **Several tabs per project**: same folder, or a new Git worktree so two agents don't overwrite each other (⌘⇧T). Tab names stay readable; when they don't fit, an "all tabs" menu lists them and lights up if a hidden tab needs you.
- **Open the project in your editor or Finder**: VS Code, Cursor, Windsurf, Antigravity or Zed. Only the editors you have installed are listed, and Argus remembers the one you pick.
- **⌘-click file paths in the terminal**: code and text files open in your editor at the right line (`src/App.tsx:313`), other files in their default app. ⌘⌥-click reveals the file in Finder. Apps, scripts and installers are never run from a click.
- **macOS editing keys in the terminal**: ⌘← / ⌘→ for line start/end, ⌥← / ⌥→ by word, ⌘⌫ to delete to line start, ⇧↩ for a newline in Claude Code.
- **Keyboard first**: ⌘K project and action switcher, ⌘J recent work, ⌘1–9 to jump to a tab, ⌘+ / ⌘− / ⌘0 to zoom the terminal text, ⌘/ for all shortcuts.
- **Color themes**: Argus, Clear Dark, or match your macOS Terminal profile (⌘K, search "theme").
- **Updates itself**: a small "Update" button appears when a new release is out; one click downloads, installs and restarts.
- **Easy agent setup**: agents that aren't installed show their official install command, ready to run in a new tab.

## Agent support

|                                 | Claude Code | agy       | Codex                          |
| ------------------------------- | ----------- | --------- | ------------------------------ |
| Start / resume from the tab bar | ✓           | ✓         | ✓                              |
| Running and done lights         | ✓           | ✓         | –                              |
| Waiting-for-you light           | ✓           | –         | best effort (from screen text) |
| New chat / switch chat buttons  | ✓           | –         | –                              |
| Activity panel                  | ✓           | ✓ (steps) | –                              |
| Recent work (prompt & files)    | ✓           | ✓         | time only                      |

### Custom agents (local models and more)

Add your own entries to the agent menu in `~/.argus/agents.json`. Use ⌘K → "Edit custom agents" to create the file with examples. For instance, to run Claude Code or Codex against a local model with [Ollama](https://ollama.com):

```json
{
  "agents": [
    {
      "name": "Claude (local Ollama)",
      "command": "ANTHROPIC_BASE_URL=http://localhost:11434 ANTHROPIC_AUTH_TOKEN=ollama claude --model qwen3-coder"
    },
    { "name": "Codex (local)", "command": "codex --oss" }
  ]
}
```

The command is typed into the tab like any shell command. If it runs `claude`, `agy` or `codex`, the status lights work as usual. Check your model provider's documentation for the exact settings. You can also ask your agent to edit `~/.argus/agents.json` for you.

The interface follows your macOS language: Traditional Chinese or English. To switch it, open ⌘K and search "Language".

## Install

Download the latest `Argus_*.dmg` from [Releases](https://github.com/Liang515/argus/releases), open it and drag Argus into Applications. The app is signed and notarized by Apple, so it opens normally.

Or install with [Homebrew](https://brew.sh):

```sh
brew trust --tap liang515/tap   # only needed once
brew install --cask liang515/tap/argus
```

### Windows (preview)

Download the latest `Argus_*_x64-setup.exe` from [Releases](https://github.com/Liang515/argus/releases) and run it. The installer isn't code-signed yet, so Windows may say "Windows protected your PC": click **More info** → **Run anyway**.

The Windows version runs PowerShell (PowerShell 7 if installed) in each tab and uses Ctrl+Shift shortcuts like Windows Terminal: Ctrl+Shift+T new tab, Ctrl+Shift+K switcher, Ctrl+Shift+J recent work, Ctrl+Tab next tab, Ctrl+1–9 jump to a tab, Ctrl+Shift+C / Ctrl+V copy and paste, Ctrl+click to open a path. Press Ctrl+Shift+/ for all of them.

Status lights, the Activity panel and Recent work work as on macOS: when you start `claude` or `agy` in an Argus tab, their hooks report back to Argus through `argus.exe`. The "match Terminal" theme is macOS only.

Requirements:

- macOS on Apple Silicon or Intel, or Windows 10/11 (x64; Arm64 runs it through emulation).
- On macOS, zsh as your shell (the default) for the status lights.
- At least one agent: [Claude Code](https://code.claude.com/docs/en/setup), [Antigravity CLI](https://antigravity.google/docs/cli/install) or [Codex](https://developers.openai.com/codex/cli/). Argus shows install links for the ones you don't have and picks them up as soon as they are installed.

## What Argus writes on your machine

Argus never edits your own shell or agent settings. It writes only:

- `~/.argus/`: saved tabs, recent work summaries (`recap.json`, created once an agent works), the Claude Code status hook, and a zsh wrapper that loads your normal zsh config and then adds the hook to `claude` inside Argus tabs only. `~/.argus/agents.json` is created only when you choose "Edit custom agents".
- `~/.gemini/config/plugins/argus/`: a status plugin for `agy`, only if `agy` is installed. It does nothing outside Argus.
- `CLAUDE.md` in a project, only when you click "add handoff rules" in the sidebar.
- A sibling folder `<project>-wt-N`, only when you open a tab as a new Git worktree.

On Windows the same places are under `%USERPROFILE%`. Instead of the shell hook and zsh wrapper, `.argus\hooks.json` points the hooks at `argus.exe`, and each PowerShell tab defines a `claude` function that adds them.

## Build from source

Requires Node.js 20+, Rust (stable) and the Xcode Command Line Tools (on Windows: the Visual Studio C++ Build Tools and WebView2, see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
npm ci
npm run tauri dev     # run in development
npm run tauri build   # macOS: Argus.app and a .dmg; Windows: an NSIS installer
```

Builds are ad-hoc signed by default. To sign with your own certificate, set `APPLE_SIGNING_IDENTITY` before building. Update packages (`.app.tar.gz` and its signature) are only produced by the release workflow, so you don't need a signing key to build.

Checks: `npm run lint`, `npm run typecheck`, `npm test`, and in `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`.

## Contributing

Issues and pull requests are welcome. Please run the checks above before opening a pull request.

## License

[MIT](LICENSE)
