//! 右側看板需要的專案資訊：git 變更、交接文件、外部工具、檔案監聽。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 依序尋找的交接文件。
const DOC_NAMES: [&str; 2] = ["HANDOFF.md", "CLAUDE.md"];
const MAX_DOC_BYTES: u64 = 512 * 1024;
const MAX_CHANGES: usize = 500;

#[derive(Serialize, Debug, PartialEq)]
pub struct GitChange {
    /// porcelain 的兩碼狀態，例如 " M"、"A "、"??"。
    pub code: String,
    pub path: String,
}

/// 解析 `git status --porcelain=v1 -z`；改名的項目後面多一段舊路徑，略過。
pub fn parse_porcelain(output: &str) -> Vec<GitChange> {
    let mut changes = Vec::new();
    let mut entries = output.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let code = &entry[..2];
        if code.contains('R') || code.contains('C') {
            entries.next();
        }
        changes.push(GitChange {
            code: code.to_string(),
            path: entry[3..].to_string(),
        });
    }
    changes
}

/// 不是 git repo 時回傳 None。
#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<Vec<GitChange>>, String> {
    let output = crate::sys::command("git")
        .args(["status", "--porcelain=v1", "-z"])
        .current_dir(&path)
        // 不搶 index.lock，避免跟 Claude 同時執行的 git 指令衝突
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("git_failed: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let mut changes = parse_porcelain(&String::from_utf8_lossy(&output.stdout));
    changes.truncate(MAX_CHANGES);
    Ok(Some(changes))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ProjectDoc {
    pub name: String,
    pub content: String,
}

pub fn find_doc(dir: &Path) -> Option<ProjectDoc> {
    DOC_NAMES.iter().find_map(|name| {
        let file = dir.join(name);
        let meta = fs::metadata(&file).ok()?;
        if !meta.is_file() || meta.len() > MAX_DOC_BYTES {
            return None;
        }
        Some(ProjectDoc {
            name: name.to_string(),
            content: fs::read_to_string(file).ok()?,
        })
    })
}

#[tauri::command]
pub fn read_project_doc(path: String) -> Option<ProjectDoc> {
    find_doc(Path::new(&path))
}

/// 交接規則的標題，也用來判斷 CLAUDE.md 是否已經加過。
pub const HANDOFF_MARKER: &str = "## Session Handoff Protocol";

const HANDOFF_PROTOCOL: &str = "## Session Handoff Protocol
- 每次開始新任務前，請先檢查根目錄是否存在 `HANDOFF.md`，若有請優先讀取以掌握最新進度。
- 每次完成一個階段性修改、準備結束對話、或我下達「交接 / handoff」指令時，請主動更新根目錄的 `HANDOFF.md`，內容包含：
  1. **目前狀態 (Current Status)：** 剛完成的功能與已驗證結果。
  2. **變更檔案 (Modified Files)：** 本次修改的核心檔案清單。
  3. **待辦下一步 (Next Steps)：** 下一個 Agent 接手後應優先處理的具體事項。
";

const HANDOFF_PROTOCOL_EN: &str = "## Session Handoff Protocol
- Before starting a new task, check whether `HANDOFF.md` exists in the project root. If it does, read it first to catch up on the latest progress.
- Whenever you finish a meaningful step, are about to end the conversation, or I say \"handoff\", update `HANDOFF.md` in the project root with:
  1. **Current Status:** what was just finished and how it was verified.
  2. **Modified Files:** the key files changed in this session.
  3. **Next Steps:** what the next agent should do first.
";

/// 介面語言是中文就寫中文版規則，其他寫英文版；標題相同，判斷「是否加過」不受語言影響。
fn protocol_for(lang: &str) -> &'static str {
    if lang.starts_with("zh") {
        HANDOFF_PROTOCOL
    } else {
        HANDOFF_PROTOCOL_EN
    }
}

/// 把交接規則接在 CLAUDE.md 後面；已經有了就回傳 None（不用寫）。
pub fn with_handoff_protocol(existing: Option<&str>, protocol: &str) -> Option<String> {
    match existing {
        Some(text) if text.contains(HANDOFF_MARKER) => None,
        Some(text) if !text.trim().is_empty() => Some(format!("{}\n\n{protocol}", text.trim_end())),
        _ => Some(protocol.to_string()),
    }
}

/// 在專案根目錄的 CLAUDE.md 加上交接規則（沒有就建立），只寫這一個檔案。
#[tauri::command]
pub fn add_handoff_protocol(path: String, lang: Option<String>) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("dir_missing".into());
    }
    let file = dir.join("CLAUDE.md");
    let existing = match fs::read_to_string(&file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("read_claude_md: {e}")),
    };
    let protocol = protocol_for(lang.as_deref().unwrap_or("en"));
    if let Some(updated) = with_handoff_protocol(existing.as_deref(), protocol) {
        fs::write(&file, updated).map_err(|e| format!("write_claude_md: {e}"))?;
    }
    Ok(())
}

/// 用 Spotlight 依 bundle id 找 App；Spotlight 關掉時退回檢查預設安裝位置。
#[cfg(target_os = "macos")]
pub(crate) fn app_installed(bundle: &str, default_name: &str) -> bool {
    let query = format!("kMDItemCFBundleIdentifier == '{bundle}'");
    let found = crate::sys::command("/usr/bin/mdfind")
        .arg(&query)
        .output()
        .map(|out| out.status.success() && !out.stdout.trim_ascii().is_empty())
        .unwrap_or(false);
    found
        || [
            PathBuf::from("/Applications"),
            dirs::home_dir().unwrap_or_default().join("Applications"),
        ]
        .iter()
        .any(|dir| dir.join(default_name).is_dir())
}

/// 用 Finder／檔案總管或支援的編輯器打開專案資料夾；
/// target 只能是 "finder"（兩個平台都用這個 id）或 [`crate::editors::EDITORS`] 裡的 id。
#[tauri::command]
pub fn open_in(path: String, target: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("dir_missing".into());
    }
    let opened = if target == "finder" {
        crate::sys::open_default(Path::new(&path)).is_ok()
    } else {
        let editor = crate::editors::find(&target).ok_or("app_missing")?;
        crate::editors::open_with(editor, &path)
    };
    if opened {
        Ok(())
    } else {
        Err("app_missing".into())
    }
}

/// worktree 放在 repo 旁邊：`<repo>-wt-<n>`，分支 `wt/<n>`，取第一個資料夾與分支都沒被用掉的 n。
pub fn pick_worktree(
    repo_root: &Path,
    branch_exists: impl Fn(&str) -> bool,
) -> Option<(PathBuf, String)> {
    let name = repo_root.file_name()?.to_string_lossy().into_owned();
    let parent = repo_root.parent()?;
    (2..100).find_map(|n| {
        let dir = parent.join(format!("{name}-wt-{n}"));
        let branch = format!("wt/{n}");
        (!dir.exists() && !branch_exists(&branch)).then_some((dir, branch))
    })
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = crate::sys::command("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git_failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 從目前的 HEAD 開一個新 worktree，回傳它的路徑。
#[tauri::command]
pub async fn create_worktree(path: String) -> Result<String, String> {
    let root = PathBuf::from(
        git(Path::new(&path), &["rev-parse", "--show-toplevel"])
            .map_err(|_| "not_git".to_string())?,
    );
    let (dir, branch) = pick_worktree(&root, |b| {
        git(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{b}"),
            ],
        )
        .is_ok()
    })
    .ok_or("no_worktree_name")?;
    let dir_str = dir.to_string_lossy().into_owned();
    git(&root, &["worktree", "add", "-b", &branch, &dir_str])
        .map_err(|e| format!("worktree_failed: {e}"))?;
    Ok(dir_str)
}

/// Argus 支援的 agent 指令。
const AGENT_BINARIES: [&str; 3] = ["claude", "agy", "codex"];

/// 在 PATH 裡找出有安裝的 agent（依 AGENT_BINARIES 的順序）。
pub fn find_agents(path_var: &str) -> Vec<String> {
    AGENT_BINARIES
        .iter()
        .filter(|bin| crate::sys::find_in(path_var, bin).is_some())
        .map(|b| b.to_string())
        .collect()
}

#[cfg_attr(windows, allow(dead_code))]
#[cfg_attr(windows, allow(dead_code))]
const PATH_MARK: &str = "__ARGUS_PATH__";
/// 互動式 shell 可能被使用者設定拖住（自動更新、tmux 等），超過就改用 App 自己的 PATH。
const SHELL_PATH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg_attr(windows, allow(dead_code))]
/// 取標記下一行：shell 設定可能也會印東西。`printenv PATH` 在 zsh、bash、fish 都是冒號分隔。
pub fn path_after_marker(stdout: &str) -> Option<String> {
    let mut lines = stdout.lines();
    lines.find(|l| l.trim() == PATH_MARK)?;
    lines
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

#[cfg_attr(windows, allow(dead_code))]
/// 執行指令並在時限內取得 stdout；逾時就結束它並回傳 None。
pub fn stdout_within(mut cmd: Command, limit: std::time::Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    // shell 留在背景的子行程可能一直佔著 stdout，所以用時限等讀取結果，而不是等到 EOF
    match rx.recv_timeout(limit) {
        Ok(s) => {
            let _ = child.wait();
            Some(s)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Windows 的 GUI App 本來就拿到使用者的 PATH，不必另外問 shell。
#[cfg(windows)]
#[tauri::command]
pub async fn detect_agents() -> Vec<String> {
    find_agents(&std::env::var("PATH").unwrap_or_default())
}

/// GUI App 拿不到使用者的 PATH，所以問一次 login shell（會載入 .zshrc）。
#[cfg(not(windows))]
#[tauri::command]
pub async fn detect_agents() -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = crate::sys::command(&shell);
    cmd.args([
        "-l",
        "-i",
        "-c",
        &format!("printf '%s\\n' {PATH_MARK}; printenv PATH"),
    ]);
    let path_var = stdout_within(cmd, SHELL_PATH_TIMEOUT)
        .and_then(|out| path_after_marker(&out))
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    find_agents(&path_var)
}

#[derive(Clone, Serialize, Default, Debug, PartialEq)]
pub struct ProjectChange {
    pub id: String,
    pub doc: bool,
    pub git: bool,
}

/// 判斷檔案事件影響哪一塊：交接文件，或 git（HEAD / index 變動）。
pub fn classify(paths: &[PathBuf]) -> (bool, bool) {
    let mut doc = false;
    let mut git = false;
    for p in paths {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let in_git = p
            .parent()
            .and_then(|d| d.file_name())
            .is_some_and(|d| d == ".git");
        if in_git {
            git |= matches!(name, "HEAD" | "index");
        } else {
            doc |= DOC_NAMES.contains(&name);
        }
    }
    (doc, git)
}

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

/// 只監聽專案根目錄與 `.git` 本身（不遞迴），不會被 node_modules 之類的大量檔案拖慢。
#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    state: State<'_, Watchers>,
    id: String,
    path: String,
) -> Result<(), String> {
    let event_id = id.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let (doc, git) = classify(&event.paths);
        if doc || git {
            let _ = app.emit(
                "project-changed",
                ProjectChange {
                    id: event_id.clone(),
                    doc,
                    git,
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;
    let root = Path::new(&path);
    watcher
        .watch(root, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    let git_dir = root.join(".git");
    if git_dir.is_dir() {
        let _ = watcher.watch(&git_dir, RecursiveMode::NonRecursive);
    }
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_project(state: State<'_, Watchers>, id: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_including_renames_and_spaces() {
        let out = " M src/main.rs\0?? 新檔案 name.md\0R  new.rs\0old.rs\0A  added.ts\0";
        let changes = parse_porcelain(out);
        let summary: Vec<(&str, &str)> = changes
            .iter()
            .map(|c| (c.code.as_str(), c.path.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (" M", "src/main.rs"),
                ("??", "新檔案 name.md"),
                ("R ", "new.rs"),
                ("A ", "added.ts"),
            ]
        );
    }

    #[test]
    fn reads_path_after_marker_even_with_noisy_shell_config() {
        let out = "Welcome!\n__ARGUS_PATH__\n/usr/bin:/opt/homebrew/bin\n";
        assert_eq!(
            path_after_marker(out).as_deref(),
            Some("/usr/bin:/opt/homebrew/bin")
        );
        assert_eq!(path_after_marker("no marker\n"), None);
        assert_eq!(path_after_marker("__ARGUS_PATH__\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn shell_query_gives_up_after_the_time_limit() {
        let start = std::time::Instant::now();
        let mut slow = Command::new("sh");
        slow.args(["-c", "sleep 5"]);
        assert_eq!(
            stdout_within(slow, std::time::Duration::from_millis(300)),
            None
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));

        let mut fast = Command::new("sh");
        fast.args(["-c", "printf '%s\\n' __ARGUS_PATH__; printenv PATH"]);
        let out = stdout_within(fast, std::time::Duration::from_secs(5)).unwrap();
        assert!(path_after_marker(&out).is_some_and(|p| p.contains('/')));
    }

    #[test]
    fn handoff_protocol_is_appended_once() {
        let fresh = with_handoff_protocol(None, HANDOFF_PROTOCOL).unwrap();
        assert!(fresh.starts_with(HANDOFF_MARKER));
        assert_eq!(
            with_handoff_protocol(Some("  \n"), HANDOFF_PROTOCOL).unwrap(),
            fresh
        );

        let appended =
            with_handoff_protocol(Some("# 規則\n- 用繁中\n\n"), HANDOFF_PROTOCOL).unwrap();
        assert!(appended.starts_with("# 規則\n- 用繁中\n\n## Session"));
        assert_eq!(
            with_handoff_protocol(Some(&appended), HANDOFF_PROTOCOL),
            None
        );
        // 加過中文版，就算介面換成英文也不會再加一次
        assert_eq!(
            with_handoff_protocol(Some(&appended), HANDOFF_PROTOCOL_EN),
            None
        );
    }

    #[test]
    fn add_handoff_protocol_writes_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        add_handoff_protocol(path.clone(), Some("en".into())).unwrap();
        add_handoff_protocol(path, Some("zh-TW".into())).unwrap();
        let text = fs::read_to_string(dir.path().join("CLAUDE.md")).unwrap();
        assert_eq!(text.matches(HANDOFF_MARKER).count(), 1);
        assert!(text.contains("Before starting a new task"));
        assert_eq!(
            add_handoff_protocol("/no/such/dir".into(), None),
            Err("dir_missing".into())
        );
    }

    #[test]
    fn prefers_handoff_over_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(find_doc(dir.path()), None);
        fs::write(dir.path().join("CLAUDE.md"), "# rules").unwrap();
        assert_eq!(find_doc(dir.path()).unwrap().name, "CLAUDE.md");
        fs::write(dir.path().join("HANDOFF.md"), "# handoff").unwrap();
        let doc = find_doc(dir.path()).unwrap();
        assert_eq!(
            (doc.name.as_str(), doc.content.as_str()),
            ("HANDOFF.md", "# handoff")
        );
    }

    #[test]
    fn classifies_watch_events() {
        let p = |s: &str| vec![PathBuf::from(s)];
        assert_eq!(classify(&p("/proj/HANDOFF.md")), (true, false));
        assert_eq!(classify(&p("/proj/.git/index")), (false, true));
        assert_eq!(classify(&p("/proj/.git/index.lock")), (false, false));
        assert_eq!(classify(&p("/proj/README.md")), (false, false));
        assert_eq!(classify(&p("/proj/.git/CLAUDE.md")), (false, false));
    }

    #[cfg(unix)]
    #[test]
    fn open_in_rejects_unknown_targets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        assert_eq!(open_in(path, "/bin/sh".into()), Err("app_missing".into()));
    }

    #[test]
    fn git_status_on_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let not_repo = tauri::async_runtime::block_on(git_status(path.clone())).unwrap();
        assert_eq!(not_repo, None);
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir.path())
            .status()
            .unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        let changes = tauri::async_runtime::block_on(git_status(path))
            .unwrap()
            .unwrap();
        assert_eq!(
            changes,
            vec![GitChange {
                code: "??".into(),
                path: "a.txt".into()
            }]
        );
    }

    #[test]
    fn watcher_sees_doc_written_in_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = tx.send(classify(&event.paths));
            }
        })
        .unwrap();
        watcher
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        fs::write(dir.path().join("HANDOFF.md"), "# v1").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut saw_doc = false;
        while let Ok((doc, _)) = rx.recv_timeout(deadline - std::time::Instant::now()) {
            if doc {
                saw_doc = true;
                break;
            }
        }
        assert!(saw_doc, "沒有收到 HANDOFF.md 的變動事件");
    }

    #[test]
    fn picks_first_free_worktree_slot() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("demo");
        fs::create_dir_all(dir.path().join("demo-wt-2")).unwrap();
        let (path, branch) = pick_worktree(&repo, |b| b == "wt/3").unwrap();
        assert_eq!(path, dir.path().join("demo-wt-4"));
        assert_eq!(branch, "wt/4");
    }

    #[test]
    fn creates_worktree_in_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("proj");
        fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .args([
                        "-c",
                        "user.name=t",
                        "-c",
                        "user.email=t@t",
                        "-c",
                        "commit.gpgsign=false"
                    ])
                    .args(args)
                    .current_dir(&repo)
                    .status()
                    .unwrap()
                    .success()
            );
        };
        run(&["init", "-q"]);
        fs::write(repo.join("a.txt"), "x").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);

        let created =
            tauri::async_runtime::block_on(create_worktree(repo.to_string_lossy().into())).unwrap();
        let created = PathBuf::from(created);
        assert_eq!(created.file_name().unwrap(), "proj-wt-2");
        assert!(created.join("a.txt").exists());
        assert_eq!(
            git(&created, &["branch", "--show-current"]).unwrap(),
            "wt/2"
        );

        let not_repo = tempfile::tempdir().unwrap();
        assert!(
            tauri::async_runtime::block_on(create_worktree(
                not_repo.path().to_string_lossy().into()
            ))
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn finds_executable_agents_in_path_order() {
        let dir = tempfile::tempdir().unwrap();
        let bin_a = dir.path().join("a");
        let bin_b = dir.path().join("b");
        fs::create_dir_all(&bin_a).unwrap();
        fs::create_dir_all(&bin_b).unwrap();
        let make = |p: PathBuf, exec: bool| {
            fs::write(&p, "#!/bin/sh\n").unwrap();
            let mode = if exec { 0o755 } else { 0o644 };
            fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(mode)).unwrap();
        };
        make(bin_a.join("agy"), true);
        make(bin_b.join("claude"), true);
        make(bin_b.join("codex"), false);
        let path = format!("{}::{}", bin_a.display(), bin_b.display());
        assert_eq!(find_agents(&path), vec!["claude", "agy"]);
        assert!(find_agents("").is_empty());
    }
}
