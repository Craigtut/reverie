import { create } from 'zustand';

import type { RepoStatus } from '../domain';
import { preserveStoreAcrossHmr } from './hmr';
import { resolveSetStateAction, type SetStateAction } from './setter';

// Per-project git context, keyed by project id. Fed by the `git_status_changed`
// event stream (see hooks/useGitStatus). A value of `null` means the folder is
// not a git repository; an absent key means we have not computed it yet. Kept
// out of the shell store so per-tick repo churn (agents editing files) never
// replaces the sessions array or re-renders the whole tree.

interface GitStatusStoreState {
  repoStatus: Record<string, RepoStatus | null>;
  setRepoStatus: (action: SetStateAction<Record<string, RepoStatus | null>>) => void;
}

export const useGitStatusStore = create<GitStatusStoreState>(set => ({
  repoStatus: {},
  setRepoStatus: action =>
    set(s => ({ repoStatus: resolveSetStateAction(action, s.repoStatus) })),
}));

// Preserve repo status across HMR so the dashboard strip and nav counts do not
// blank between event ticks while an edit reloads. See store/hmr.ts.
preserveStoreAcrossHmr(useGitStatusStore, import.meta.hot, s => ({
  repoStatus: s.repoStatus,
}));
