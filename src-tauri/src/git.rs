//! 直接讀 `.git/HEAD` 取得目前分支，不必啟動 git 子行程。

use std::fs;
use std::path::{Path, PathBuf};

/// 解析 HEAD 內容：分支回傳分支名，detached HEAD 回傳 7 碼 commit。
pub fn branch_from_head(content: &str) -> Option<String> {
    let content = content.trim();
    if let Some(reference) = content.strip_prefix("ref:") {
        let reference = reference.trim();
        return Some(
            reference
                .strip_prefix("refs/heads/")
                .unwrap_or(reference)
                .to_string(),
        );
    }
    let is_sha = content.len() >= 7 && content.chars().all(|c| c.is_ascii_hexdigit());
    is_sha.then(|| content[..7].to_string())
}

/// 往上找 `.git`；worktree / submodule 的 `.git` 是指向實際目錄的檔案。
fn find_head(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors() {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git.join("HEAD"));
        }
        if dot_git.is_file() {
            let content = fs::read_to_string(&dot_git).ok()?;
            let gitdir = content.trim().strip_prefix("gitdir:")?.trim();
            return Some(dir.join(gitdir).join("HEAD"));
        }
    }
    None
}

#[tauri::command]
pub fn git_branch(path: String) -> Option<String> {
    let head = find_head(Path::new(&path))?;
    branch_from_head(&fs::read_to_string(head).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_ref() {
        assert_eq!(
            branch_from_head("ref: refs/heads/feature/x\n").as_deref(),
            Some("feature/x")
        );
    }

    #[test]
    fn parses_detached_head() {
        assert_eq!(
            branch_from_head("0123456789abcdef0123456789abcdef01234567").as_deref(),
            Some("0123456")
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(branch_from_head("hello"), None);
    }

    #[test]
    fn finds_head_in_subdir_and_worktree() {
        let root = tempfile::tempdir().unwrap();
        let git = root.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let sub = root.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            git_branch(sub.to_string_lossy().into()).as_deref(),
            Some("main")
        );

        let wt_git = root.path().join("wtgit");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("HEAD"), "ref: refs/heads/wt\n").unwrap();
        let wt = root.path().join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        assert_eq!(
            git_branch(wt.to_string_lossy().into()).as_deref(),
            Some("wt")
        );
    }

    #[test]
    fn non_repo_has_no_branch() {
        let dir = tempfile::tempdir().unwrap();
        // tempdir 在 /var/folders 底下，不會位於任何 repo 內
        assert_eq!(git_branch(dir.path().to_string_lossy().into()), None);
    }
}
