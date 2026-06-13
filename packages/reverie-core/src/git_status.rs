//! Read-only git inspection for project folders.
//!
//! When a project folder happens to be a git repository, Reverie surfaces a
//! little repository context (branch, sync state, dirty line counts, last
//! commit) on the project dashboard and in the left nav. This module computes
//! that snapshot with `gix` (pure Rust, no networking).
//!
//! Mutating sync (pull/push) is deliberately NOT here. The desktop app shells
//! out to the user's own `git` for those rare, user-initiated operations so
//! their credential helper, SSH agent, and hooks behave exactly as they expect.

use std::path::Path;

use gix::remote::Direction;
use serde::{Deserialize, Serialize};

/// A point-in-time snapshot of a project folder's git state. A `None` return
/// from [`compute_repo_status`] means the folder is not a git repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// Short branch name (e.g. `main`). `None` when HEAD is detached.
    pub branch: Option<String>,
    /// True when HEAD points directly at a commit rather than a branch.
    pub detached: bool,
    /// Short upstream tracking ref (e.g. `origin/main`), when configured.
    pub upstream: Option<String>,
    /// Commits the local branch is ahead of its upstream.
    pub ahead: usize,
    /// Commits the local branch is behind its upstream.
    pub behind: usize,
    /// Working-tree change summary. Clean when every field is zero.
    pub dirty: DirtyStat,
    /// The commit HEAD resolves to, for a "where did this leave off" line.
    pub last_commit: Option<CommitSummary>,
}

/// A summary of uncommitted changes in the working tree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyStat {
    /// Number of changed paths (modified, added, deleted, or untracked).
    pub files_changed: usize,
    /// Total inserted lines across changed and new files.
    pub insertions: usize,
    /// Total deleted lines across changed and removed files.
    pub deletions: usize,
}

impl DirtyStat {
    /// True when the working tree carries no changes at all.
    pub fn is_clean(&self) -> bool {
        self.files_changed == 0 && self.insertions == 0 && self.deletions == 0
    }
}

/// The minimum we show about the commit HEAD points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    /// First line of the commit message.
    pub subject: String,
    /// Commit time in seconds since the Unix epoch (the UI formats it relative).
    pub time_seconds: i64,
}

/// Compute a [`RepoStatus`] for the folder at `path`, or `None` when the folder
/// is not the root of a git repository. This is the read-only hot path the poll
/// loop calls; it never mutates the repository or touches the network.
pub fn compute_repo_status(path: &Path) -> Option<RepoStatus> {
    let repo = gix::open(path).ok()?;

    let head = repo.head().ok()?;
    let detached = head.is_detached();
    let branch = repo
        .head_name()
        .ok()
        .flatten()
        .map(|name| name.shorten().to_string());

    let last_commit = repo.head_commit().ok().and_then(|commit| {
        let subject = commit.message().ok()?.summary().to_string();
        let time_seconds = commit.time().ok()?.seconds;
        Some(CommitSummary {
            subject,
            time_seconds,
        })
    });

    let (upstream, ahead, behind) = ahead_behind(&repo).unwrap_or((None, 0, 0));
    let dirty = dirty_stat(&repo);

    Some(RepoStatus {
        branch,
        detached,
        upstream,
        ahead,
        behind,
        dirty,
        last_commit,
    })
}

/// Resolve the upstream tracking branch and count how far the local branch is
/// ahead/behind it. Returns `None` when there is no configured upstream.
fn ahead_behind(repo: &gix::Repository) -> Option<(Option<String>, usize, usize)> {
    let head_name = repo.head_name().ok().flatten()?;
    let tracking = repo
        .branch_remote_tracking_ref_name(head_name.as_ref(), Direction::Fetch)?
        .ok()?;
    let upstream_short = tracking.shorten().to_string();

    let local = repo.head_id().ok()?.detach();
    let upstream = repo
        .find_reference(upstream_short.as_str())
        .ok()?
        .into_fully_peeled_id()
        .ok()?
        .detach();

    // No common ancestor means we cannot express a meaningful ahead/behind; show
    // the upstream name but leave the counts at zero rather than guess.
    let base = repo.merge_base(local, upstream).ok()?.detach();

    let ahead = count_to_boundary(repo, local, base);
    let behind = count_to_boundary(repo, upstream, base);

    Some((Some(upstream_short), ahead, behind))
}

/// Count commits reachable from `tip` walking back until (but not including)
/// `boundary`. With `boundary` set to the merge-base this yields the number of
/// commits on `tip`'s side of the fork.
fn count_to_boundary(repo: &gix::Repository, tip: gix::ObjectId, boundary: gix::ObjectId) -> usize {
    match repo.rev_walk(Some(tip)).with_boundary(Some(boundary)).all() {
        Ok(walk) => walk.filter(|info| info.is_ok()).count(),
        Err(_) => 0,
    }
}

/// Summarize uncommitted changes against the last commit: how many paths differ
/// from HEAD and the total inserted/deleted lines across them. This is the
/// "what have my agents changed since the last commit" view the dashboard shows.
fn dirty_stat(repo: &gix::Repository) -> DirtyStat {
    let Some(workdir) = repo.workdir().map(Path::to_path_buf) else {
        return DirtyStat::default();
    };
    let paths = changed_paths(repo);
    let head_tree = repo
        .head_commit()
        .ok()
        .and_then(|commit| commit.tree().ok());

    let mut stat = DirtyStat {
        files_changed: paths.len(),
        insertions: 0,
        deletions: 0,
    };
    for path in &paths {
        let (insertions, deletions) = line_delta(head_tree.as_ref(), &workdir, path);
        stat.insertions += insertions;
        stat.deletions += deletions;
    }
    stat
}

/// The set of paths that differ from HEAD, deduped across staged (tree vs index)
/// and unstaged (index vs worktree) changes, including untracked files.
fn changed_paths(repo: &gix::Repository) -> std::collections::HashSet<Vec<u8>> {
    use std::collections::HashSet;

    let mut paths: HashSet<Vec<u8>> = HashSet::new();
    let Ok(platform) = repo.status(gix::progress::Discard) else {
        return paths;
    };
    let Ok(iter) = platform
        .untracked_files(gix::status::UntrackedFiles::Files)
        .into_iter(None)
    else {
        return paths;
    };
    for item in iter {
        let Ok(item) = item else { continue };
        paths.insert(item.location().to_vec());
    }
    paths
}

/// Count inserted/deleted lines for one path comparing its HEAD blob to the file
/// on disk. New files count every line as an insertion, deleted files count the
/// old blob's lines as deletions, and binary files contribute no line counts.
fn line_delta(head_tree: Option<&gix::Tree<'_>>, workdir: &Path, rel: &[u8]) -> (usize, usize) {
    let rel_path = Path::new(std::str::from_utf8(rel).unwrap_or_default());
    if rel_path.as_os_str().is_empty() {
        return (0, 0);
    }

    let old = head_tree
        .and_then(|tree| tree.clone().lookup_entry_by_path(rel_path).ok().flatten())
        .and_then(|entry| entry.object().ok())
        .map(|object| object.data.clone());
    let new = std::fs::read(workdir.join(rel_path)).ok();

    count_lines_delta(old.as_deref(), new.as_deref())
}

/// Inserted/deleted line counts between two optional byte buffers, skipping any
/// content that looks binary (a NUL byte in the scanned prefix, matching git's
/// heuristic). Lines are diffed with the histogram algorithm, matching git's
/// default and producing intuitive counts.
fn count_lines_delta(old: Option<&[u8]>, new: Option<&[u8]>) -> (usize, usize) {
    use gix::diff::blob::{Algorithm, Diff, InternedInput};

    let old = old.unwrap_or(b"");
    let new = new.unwrap_or(b"");
    if looks_binary(old) || looks_binary(new) {
        return (0, 0);
    }

    let input = InternedInput::new(old, new);
    let diff = Diff::compute(Algorithm::Histogram, &input);
    (
        diff.count_additions() as usize,
        diff.count_removals() as usize,
    )
}

/// Git's binary heuristic: a NUL byte within the first 8 KB marks the content as
/// binary, so we skip line counting for it.
fn looks_binary(bytes: &[u8]) -> bool {
    let scan = &bytes[..bytes.len().min(8000)];
    scan.contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.email", "t@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn none_when_not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(compute_repo_status(dir.path()).is_none());
    }

    #[test]
    fn reads_branch_commit_and_dirt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        fs::write(root.join("a.txt"), "one\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "init"]);

        let clean = compute_repo_status(root).expect("repo");
        assert!(clean.branch.is_some(), "branch should be set");
        assert!(!clean.detached);
        assert_eq!(
            clean.last_commit.as_ref().map(|c| c.subject.as_str()),
            Some("init")
        );
        assert!(clean.dirty.is_clean(), "fresh checkout should be clean");

        // One tracked edit (+1 line) + one untracked file (+1 line): two changed
        // paths, two insertions, no deletions.
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(root.join("b.txt"), "new\n").unwrap();
        let dirty = compute_repo_status(root).expect("repo");
        assert_eq!(dirty.dirty.files_changed, 2, "edit + untracked = 2 paths");
        assert_eq!(dirty.dirty.insertions, 2, "one added line in each file");
        assert_eq!(dirty.dirty.deletions, 0, "no lines removed");
    }

    #[test]
    fn counts_deletions_and_skips_binary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        fs::write(root.join("text.txt"), "a\nb\nc\nd\n").unwrap();
        fs::write(root.join("blob.bin"), [1u8, 0, 2, 0, 3]).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "seed"]);

        // Drop two lines from the text file; mutate the binary file.
        fs::write(root.join("text.txt"), "a\nd\n").unwrap();
        fs::write(root.join("blob.bin"), [9u8, 0, 9, 0, 9, 0]).unwrap();
        let dirty = compute_repo_status(root).expect("repo");
        assert_eq!(dirty.dirty.files_changed, 2, "both files changed");
        assert_eq!(dirty.dirty.deletions, 2, "two text lines removed");
        assert_eq!(
            dirty.dirty.insertions, 0,
            "binary change contributes no lines"
        );
    }
}
