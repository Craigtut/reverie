import { useEffect, useMemo, useRef } from 'react';

import type { GitStatusEventPayload } from '../domain';
import { requestGitStatus, setGitWatchProjects } from '../services/gitApi';
import { listen, type UnlistenFn } from '../services/runtime';
import { useGitStatusStore, useNavigationStore, useShellStore } from '../store';

// Owns the live git-context feed for project folders:
//  - subscribes to the `git_status_changed` event stream for the app's lifetime,
//    folding each per-project update into the git status store, and
//  - declares the watched set (projects expanded in the nav, plus the open
//    project dashboard) to the backend so its poll loop only recomputes repos
//    the user can actually see. The backend additionally watches any project
//    with a running session, so a collapsed project with a live agent still
//    updates without us declaring it.
export function useGitStatus() {
  const setRepoStatus = useGitStatusStore(s => s.setRepoStatus);
  const projects = useShellStore(s => s.shell.projects);
  const collapsedProjectIds = useNavigationStore(s => s.collapsedProjectIds);
  const selectedProjectId = useNavigationStore(s => s.selectedProjectId);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        const fn = await listen<GitStatusEventPayload>('git_status_changed', event => {
          if (cancelled) return;
          const { projectId, status } = event.payload;
          setRepoStatus(current => ({ ...current, [projectId]: status }));
        });
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        // The browser harness has no Tauri event bus; quietly skip.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setRepoStatus]);

  // Projects worth watching: expanded in the nav (not collapsed), plus the open
  // project dashboard. Sorted so the declared set is order-stable.
  const watchedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const project of projects) {
      if (project.archived) continue;
      if (!collapsedProjectIds.has(project.id)) ids.add(project.id);
    }
    if (typeof selectedProjectId === 'string') ids.add(selectedProjectId);
    return Array.from(ids).sort();
  }, [projects, collapsedProjectIds, selectedProjectId]);

  const watchedKey = watchedIds.join(',');
  const previousWatched = useRef<Set<string>>(new Set());
  useEffect(() => {
    void setGitWatchProjects(watchedIds).catch(() => {});
    // Fill in newly revealed projects right away instead of waiting for the next
    // poll tick.
    const previous = previousWatched.current;
    for (const id of watchedIds) {
      if (!previous.has(id)) void requestGitStatus(id).catch(() => {});
    }
    previousWatched.current = new Set(watchedIds);
    // watchedKey is the stable serialization of watchedIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey]);
}
