import { useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch } from '@phosphor-icons/react';

import { errorMessage, relativeTimeFromSeconds } from '../../domain';
import type { RepoStatus } from '../../domain';
import { gitPull, gitPush } from '../../services/gitApi';
import { useOverlayStore } from '../../store';
import { css, cx } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';

// The project dashboard's git context band. Renders only when the project folder
// is a git repository (the parent gates on a non-null status), and scales its
// own visual weight with how much is going on: a clean repo with no remote shows
// just the branch; dirt and sync state appear only when present. Unlike the calm
// monochrome nav counts, the project page uses status color here (green/red for
// the +/- line counts, warn for "behind remote") to pull a little attention, per
// the design call for this developer-facing surface.
//
// Pull/Push are the only mutating affordances, and they appear only when there
// is something to sync (behind/ahead). They shell out to the user's own `git` on
// the backend. Pull is disabled while the tree is dirty, since a fast-forward
// pull can refuse or clobber live agent edits; push needs no such guard because
// it only sends committed objects.
export function RepoStrip({ status, projectId }: { status: RepoStatus; projectId: string }) {
  const { branch, detached, upstream, ahead, behind, dirty, lastCommit } = status;
  const isDirty = dirty.insertions > 0 || dirty.deletions > 0 || dirty.filesChanged > 0;
  const pushToast = useOverlayStore(s => s.pushToast);
  const [busy, setBusy] = useState<'pull' | 'push' | null>(null);

  const runSync = async (kind: 'pull' | 'push') => {
    if (busy) return;
    setBusy(kind);
    try {
      await (kind === 'pull' ? gitPull(projectId) : gitPush(projectId));
      pushToast({ message: kind === 'pull' ? 'Pulled latest changes' : 'Pushed your commits' });
    } catch (error) {
      const verb = kind === 'pull' ? 'Pull' : 'Push';
      pushToast({ message: `${verb} failed: ${errorMessage(error)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={stripClass} data-testid="repo-strip">
      <div className={rowClass}>
        <span className={branchClass} title={detached ? 'Detached HEAD' : (branch ?? '')}>
          <GitBranch size={13} weight="bold" />
          <Typography as="span" variant="caption" tone="default">
            {detached ? 'detached' : (branch ?? 'unknown')}
          </Typography>
        </span>

        {upstream && (ahead > 0 || behind > 0) ? (
          <span className={syncClass} title={`${ahead} ahead, ${behind} behind ${upstream}`}>
            {ahead > 0 ? (
              <span className={syncCellClass}>
                <ArrowUp size={11} weight="bold" />
                <Typography as="span" variant="caption" tone="muted">
                  {ahead}
                </Typography>
              </span>
            ) : null}
            {behind > 0 ? (
              <span className={cx(syncCellClass, behindClass)}>
                <ArrowDown size={11} weight="bold" />
                <Typography as="span" variant="caption" tone="inherit">
                  {behind}
                </Typography>
              </span>
            ) : null}
            {behind > 0 ? (
              <button
                type="button"
                className={syncButtonClass}
                disabled={isDirty || busy !== null}
                title={
                  isDirty
                    ? 'Commit or stash your changes before pulling'
                    : `Pull ${behind} from ${upstream}`
                }
                onClick={() => void runSync('pull')}
                data-testid="repo-pull-button"
              >
                <Typography as="span" variant="caption" tone="inherit">
                  {busy === 'pull' ? 'Pulling…' : 'Pull'}
                </Typography>
              </button>
            ) : null}
            {ahead > 0 ? (
              <button
                type="button"
                className={syncButtonClass}
                disabled={busy !== null}
                title={`Push ${ahead} to ${upstream}`}
                onClick={() => void runSync('push')}
                data-testid="repo-push-button"
              >
                <Typography as="span" variant="caption" tone="inherit">
                  {busy === 'push' ? 'Pushing…' : 'Push'}
                </Typography>
              </button>
            ) : null}
          </span>
        ) : null}

        {isDirty ? (
          <span
            className={dirtyClass}
            title={`${dirty.filesChanged} file${dirty.filesChanged === 1 ? '' : 's'} changed, uncommitted`}
          >
            <Typography as="span" variant="caption" tone="muted">
              {dirty.filesChanged} changed
            </Typography>
            <Typography as="span" variant="caption" tone="inherit" className={insertionsClass}>
              +{dirty.insertions}
            </Typography>
            <Typography as="span" variant="caption" tone="inherit" className={deletionsClass}>
              −{dirty.deletions}
            </Typography>
          </span>
        ) : null}
      </div>

      {lastCommit ? (
        <Typography as="p" variant="caption" tone="faint" className={lastCommitClass}>
          {`last commit "${lastCommit.subject}" · ${relativeTimeFromSeconds(lastCommit.timeSeconds)}`}
        </Typography>
      ) : null}
    </section>
  );
}

const stripClass = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  paddingTop: '14px',
  marginTop: '2px',
  borderTop: '1px solid var(--line)',
});

const rowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  flexWrap: 'wrap',
  fontVariantNumeric: 'tabular-nums',
});

const branchClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  color: 'var(--text-2)',
  '& svg': { color: 'var(--text-3)' },
});

const syncClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '10px',
});

const syncCellClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  color: 'var(--text-3)',
});

// Behind-remote is the one sync state worth a gentle nudge: warn-tinted so it
// reads as "there is something to pull" without shouting.
const behindClass = css({
  color: 'var(--warn)',
  '& svg': { color: 'var(--warn)' },
});

// Small pill action matching the calm chip language used elsewhere (rounded,
// hairline border, hover lift). Disabled state dims and drops the pointer.
const syncButtonClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  height: '24px',
  padding: '0 10px',
  borderRadius: '999px',
  border: '1px solid var(--line)',
  background: 'transparent',
  color: 'var(--text-2)',
  cursor: 'pointer',
  transition: 'border-color 0.15s ease, color 0.15s ease, background 0.15s ease',
  _hover: { borderColor: 'var(--line-strong)', color: 'var(--text)' },
  _disabled: { opacity: 0.45, cursor: 'default', _hover: { borderColor: 'var(--line)', color: 'var(--text-2)' } },
});

const dirtyClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  marginLeft: 'auto',
});

const insertionsClass = css({ color: 'var(--good)' });
const deletionsClass = css({ color: 'var(--bad)' });

const lastCommitClass = css({
  margin: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
});
