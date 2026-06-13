import type { RepoStatus } from '../domain';
import { invoke } from './runtime';

// The git command surface the React shell invokes. Reads (status + watched set)
// are backed by the gix poll loop; mutating sync (pull/push) shells out to the
// user's own `git` on the backend so credentials, SSH, and hooks behave as they
// expect. Kept here so the command surface stays discoverable in one place.

// Declare which projects the UI currently wants watched (expanded in the nav, or
// the open dashboard). The backend additionally watches any project with a
// running session, so a collapsed project with a live agent still updates.
export function setGitWatchProjects(projectIds: string[]): Promise<void> {
  return invoke('set_git_watch_projects', { projectIds });
}

// Compute one project's git status immediately. Also emits the usual
// `git_status_changed` event so every listener stays in sync. Returns `null`
// when the folder is not a git repository.
export function requestGitStatus(projectId: string): Promise<RepoStatus | null> {
  return invoke('git_status', { projectId });
}

// Pull the current branch fast-forward only (the UI gates this on a clean tree).
// Rejects with git's stderr on failure. The backend recomputes status after.
export function gitPull(projectId: string): Promise<void> {
  return invoke('git_pull', { projectId });
}

// Push the current branch to its upstream. Pushes committed objects only, so a
// dirty tree is fine. Rejects with git's stderr on failure.
export function gitPush(projectId: string): Promise<void> {
  return invoke('git_push', { projectId });
}
