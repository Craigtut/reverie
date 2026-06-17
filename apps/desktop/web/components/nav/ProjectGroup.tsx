import type { MouseEvent, ReactNode } from 'react';
import { CaretRight, GitBranch, Plus, WarningCircle } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';
import { InlineRename } from './InlineRename';
import {
  caretIconClass,
  liveIconAttrs,
  liveStatusIconClass,
  rowAccentClass,
  rowActionClass,
  rowAttentionBadgeClass,
  rowCaretButtonClass,
  rowLabelClass,
  rowMetaClass,
  rowPrimaryClass,
  rowReadyBadgeClass,
  rowShellClass,
  rowTrailingCapClass,
  rowTrailingClass,
} from './navStyles';

// A collapsible top-level group in the left nav (a project, or the General
// group). The caret always toggles the accordion. The row body's job depends on
// whether the group is openable: a project (with `onOpen`) opens its dashboard
// and reveals its topics, mirroring how a topic row opens its own dashboard,
// while the General group (no `onOpen`) simply toggles since it has no overview
// of its own. The trailing session count crossfades to an add (plus) action on
// hover, which creates a child: a new topic under a project, a new session under
// General. Children render under a hairline guide rail when expanded. The leading
// folder icon doubles as the project's rollup mark: a steady amber while a
// session inside needs you (the pending ask wins the icon, so a collapsed project
// still signals it), and once nothing needs you, a slow soft green breath while
// an agent is still working beneath, a calm sign of life. When the project's
// dashboard is the active surface a short accent lights its left gutter.
export function ProjectGroup({
  icon,
  title,
  count,
  attention = 0,
  finished = 0,
  live = false,
  gitInsertions = 0,
  gitDeletions = 0,
  folderMissing = false,
  expanded,
  active = false,
  renaming = false,
  onToggle,
  onOpen,
  onAdd,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  addTitle,
  addTestId = 'add-project-topic-button',
  testId,
  children,
}: {
  icon?: ReactNode;
  title: string;
  count: number;
  attention?: number;
  finished?: number;
  // True when any session inside the project is actively working. Drives the
  // folder's slow green liveness breath, shown once nothing needs you (the
  // attention count wins the icon while it is non-zero).
  live?: boolean;
  // Uncommitted line counts when the project folder is a git repo. Shown as
  // quiet monochrome facts (not status color) so they never compete with the
  // folder status light or the attention/ready badges. Zero hides them.
  gitInsertions?: number;
  gitDeletions?: number;
  // The project's folder is not on disk and could not be auto-reconnected. Shows
  // a warn indicator so even a collapsed project signals it needs locating.
  folderMissing?: boolean;
  expanded: boolean;
  active?: boolean;
  // Rename support, used by real projects only. The General group passes none of
  // these, so it has no inline editor and no right-click menu.
  renaming?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onAdd?: (event: MouseEvent<HTMLElement>) => void;
  onStartRename?: () => void;
  onCommitRename?: (value: string) => void;
  onCancelRename?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  addTitle?: string;
  addTestId?: string;
  testId?: string;
  children: ReactNode;
}) {
  // Openable groups (projects) split the row: the caret toggles, the body opens.
  // The General group has no dashboard, so its body falls back to toggling.
  const opens = Boolean(onOpen);
  const canRename = renaming && Boolean(onCommitRename && onCancelRename);
  return (
    <div className={projectGroupClass}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the nav context menu; the row's real targets are its inner buttons */}
      <div
        className={rowShellClass}
        data-active={active ? 'true' : 'false'}
        data-row-shell="true"
        onContextMenu={onContextMenu}
      >
        {active ? <span className={rowAccentClass} aria-hidden="true" /> : null}
        <button
          className={rowCaretButtonClass}
          type="button"
          onClick={onToggle}
          {...(opens
            ? {
                'aria-expanded': expanded,
                title: expanded ? `Collapse ${title}` : `Expand ${title}`,
                'data-testid': 'project-toggle-button',
              }
            : { tabIndex: -1, 'aria-hidden': true })}
        >
          <span className={caretIconClass(expanded)}>
            <CaretRight size={11} weight="bold" />
          </span>
        </button>
        {canRename ? (
          <div className={rowPrimaryClass}>
            {icon ? (
              <span
                className={liveStatusIconClass}
                {...liveIconAttrs(live, attention)}
                aria-hidden="true"
              >
                {icon}
              </span>
            ) : null}
            <InlineRename
              initialValue={title}
              ariaLabel={`Rename project ${title}`}
              onCommit={onCommitRename as (value: string) => void}
              onCancel={onCancelRename as () => void}
            />
          </div>
        ) : (
          <button
            className={rowPrimaryClass}
            type="button"
            onClick={onOpen ?? onToggle}
            onDoubleClick={onStartRename}
            aria-expanded={opens ? undefined : expanded}
            data-testid={opens ? 'nav-project-open' : testId}
            data-expanded={expanded ? 'true' : 'false'}
            data-project-title={opens ? title : undefined}
          >
            {icon ? (
              <span
                className={liveStatusIconClass}
                {...liveIconAttrs(live, attention)}
                aria-hidden="true"
              >
                {icon}
              </span>
            ) : null}
            <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
              {title}
            </Typography>
          </button>
        )}
        <div className={rowTrailingClass}>
          {folderMissing ? (
            <span
              className={folderMissingClass}
              role="img"
              title="This folder is missing. Right-click to locate it."
              aria-label="Folder missing"
            >
              <WarningCircle size={13} weight="bold" />
            </span>
          ) : null}
          {attention > 0 ? (
            <Typography
              as="span"
              variant="caption"
              tone="warn"
              className={rowAttentionBadgeClass}
              data-row-meta={onAdd ? 'true' : undefined}
              title={`${attention} need${attention === 1 ? 's' : ''} you`}
            >
              {attention}
            </Typography>
          ) : null}
          {finished > 0 ? (
            <Typography
              as="span"
              variant="caption"
              tone="muted"
              className={rowReadyBadgeClass}
              data-row-meta={onAdd ? 'true' : undefined}
              title={`${finished} ready for you`}
            >
              {finished}
            </Typography>
          ) : null}
          {gitInsertions > 0 || gitDeletions > 0 ? (
            // Resting: a warn-tinted branch glyph that just says "uncommitted
            // work here," pulling a little attention. On row hover the glyph
            // collapses and the color-coded line counts expand in beside the
            // remove button, progressively disclosing the detail once the user
            // has shown intent by reaching for the row.
            <span
              className={gitDirtyClass}
              title={`${gitInsertions} added, ${gitDeletions} removed (uncommitted)`}
            >
              <span className={gitDirtyRestClass} data-git-rest aria-hidden="true">
                <GitBranch size={12} weight="bold" />
              </span>
              <span className={gitDirtyExpandClass} data-git-expand>
                <Typography as="span" variant="caption" tone="good">
                  +{gitInsertions}
                </Typography>
                <Typography as="span" variant="caption" tone="bad">
                  −{gitDeletions}
                </Typography>
              </span>
            </span>
          ) : null}
          <span className={rowTrailingCapClass}>
            {count ? (
              <Typography
                as="span"
                variant="caption"
                tone="ghost"
                className={rowMetaClass}
                data-row-meta={onAdd ? 'true' : undefined}
              >
                {count}
              </Typography>
            ) : null}
            {onAdd ? (
              <button
                className={rowActionClass}
                type="button"
                onClick={onAdd}
                title={addTitle ?? `Add to ${title}`}
                data-testid={addTestId}
                data-row-action="true"
              >
                <Plus size={13} weight="bold" />
              </button>
            ) : null}
          </span>
        </div>
      </div>
      {expanded ? <div className={childrenClass}>{children}</div> : null}
    </div>
  );
}

// The uncommitted-changes indicator in the nav. At rest it is just a small
// warn-tinted branch glyph: enough to pull a little attention to "there is
// uncommitted work here" without spelling out numbers. On row hover the glyph
// collapses and the color-coded +/- line counts expand in (green added, red
// removed), so the detail appears only once the user reaches for the row. Both
// transitions are driven off the row's `data-row-shell` hover/focus so the
// indicator stays in step with the count-to-remove crossfade beside it.
// The indicator occupies only the glyph's footprint at rest. On hover/focus the
// counts take real layout space, so the project title yields with ellipsis
// instead of being painted over. It never intercepts pointer events, so a click
// over it always reaches the row's caret/primary targets behind it.
const gitDirtyClass = css({
  position: 'relative',
  display: 'inline-grid',
  alignItems: 'center',
  justifyItems: 'end',
  flexShrink: 0,
  pointerEvents: 'none',
});

// The missing-folder mark: a small warn-tinted warning glyph in the trailing
// slot, present even while the project is collapsed so a moved/renamed folder is
// visible at a glance. Non-interactive; the action lives in the context menu.
const folderMissingClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  pointerEvents: 'none',
  '& svg': { color: 'var(--warn)' },
});

const gitDirtyRestClass = css({
  gridArea: '1 / 1',
  display: 'inline-flex',
  alignItems: 'center',
  justifySelf: 'end',
  opacity: 1,
  transition: 'opacity 130ms ease',
  '& svg': { color: 'var(--warn)' },
  '[data-row-shell]:hover &': { opacity: 0 },
  '[data-row-shell]:has(:focus-visible) &': { opacity: 0 },
});

// The numbers share the glyph's right edge, but expand from zero width into the
// row's normal flex layout. That gives the dirty counts priority over a long
// project title while keeping the resting row compact.
// Color comes from each number's Typography tone (good/bad), not a className,
// because Typography sets color as an inline style that a class can't override.
const gitDirtyExpandClass = css({
  gridArea: '1 / 1',
  justifySelf: 'end',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  width: 'max-content',
  maxWidth: '0px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
  opacity: 0,
  transform: 'translateX(8px)',
  transition: 'opacity 130ms ease, transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
  '[data-row-shell]:hover &': { maxWidth: 'none', opacity: 1, transform: 'translateX(0)' },
  '[data-row-shell]:has(:focus-visible) &': {
    maxWidth: 'none',
    opacity: 1,
    transform: 'translateX(0)',
  },
});

const projectGroupClass = css({
  display: 'grid',
  // One column that fills the rail but may shrink below its content, so a long
  // row truncates instead of pushing its trailing slot off the edge (grid items
  // default to min-width: auto, which otherwise sizes the track to max-content).
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '2px',
});

const childrenClass = css({
  marginLeft: '11px',
  paddingLeft: '8px',
  borderLeft: '1px solid var(--line-faint)',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '1px',
});
