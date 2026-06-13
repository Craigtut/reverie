import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { CaretRight, GitBranch } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { DashboardStatus } from '../../domain';
import { CloseGlyph } from '../glyphs';
import { Typography } from '../primitives/Typography';
import {
  caretIconClass,
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
// of its own. The trailing session count crossfades to the remove action on
// hover. Children render under a hairline guide rail when expanded. The leading
// folder icon doubles as a status light: it rolls the worst session state inside
// the project upward, going green while an agent is working and amber when one
// needs you, so a collapsed project still signals what is happening beneath it.
// When the project's dashboard is the active surface a short accent lights its
// left gutter.
export function ProjectGroup({
  icon,
  title,
  count,
  attention = 0,
  finished = 0,
  tone = 'recent',
  gitInsertions = 0,
  gitDeletions = 0,
  expanded,
  active = false,
  onToggle,
  onOpen,
  onRemove,
  removeTitle,
  removeTestId = 'remove-project-button',
  testId,
  children,
}: {
  icon?: ReactNode;
  title: string;
  count: number;
  attention?: number;
  finished?: number;
  tone?: DashboardStatus;
  // Uncommitted line counts when the project folder is a git repo. Shown as
  // quiet monochrome facts (not status color) so they never compete with the
  // folder status light or the attention/ready badges. Zero hides them.
  gitInsertions?: number;
  gitDeletions?: number;
  expanded: boolean;
  active?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onRemove?: (event: MouseEvent<HTMLElement>) => void;
  removeTitle?: string;
  removeTestId?: string;
  testId?: string;
  children: ReactNode;
}) {
  // Openable groups (projects) split the row: the caret toggles, the body opens.
  // The General group has no dashboard, so its body falls back to toggling.
  const opens = Boolean(onOpen);
  return (
    <div className={projectGroupClass}>
      <div className={rowShellClass} data-active={active ? 'true' : 'false'} data-row-shell="true">
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
        <button
          className={rowPrimaryClass}
          type="button"
          onClick={onOpen ?? onToggle}
          aria-expanded={opens ? undefined : expanded}
          data-testid={opens ? 'nav-project-open' : testId}
          data-expanded={expanded ? 'true' : 'false'}
          data-project-title={opens ? title : undefined}
        >
          {icon ? (
            <span
              className={folderToneClass}
              data-tone={toneAttr(tone)}
              style={folderToneStyle(tone)}
              aria-hidden="true"
            >
              {icon}
            </span>
          ) : null}
          <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
            {title}
          </Typography>
        </button>
        <div className={rowTrailingClass}>
          {attention > 0 ? (
            <Typography
              as="span"
              variant="caption"
              tone="warn"
              className={rowAttentionBadgeClass}
              data-row-meta={onRemove ? 'true' : undefined}
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
              data-row-meta={onRemove ? 'true' : undefined}
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
                <Typography as="span" variant="caption" tone="inherit" className={gitInsertClass}>
                  +{gitInsertions}
                </Typography>
                <Typography as="span" variant="caption" tone="inherit" className={gitDeleteClass}>
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
                data-row-meta={onRemove ? 'true' : undefined}
              >
                {count}
              </Typography>
            ) : null}
            {onRemove ? (
              <button
                className={rowActionClass}
                type="button"
                onClick={onRemove}
                title={removeTitle ?? `Remove ${title}`}
                data-testid={removeTestId}
                data-row-action="true"
              >
                <CloseGlyph size={11} />
              </button>
            ) : null}
          </span>
        </div>
      </div>
      {expanded ? <div className={childrenClass}>{children}</div> : null}
    </div>
  );
}

// Only the demanding tones tint the folder; idle / finished projects keep the
// calm default icon color (no data-tone attribute, so the rule below misses).
function toneAttr(tone: DashboardStatus): 'attention' | 'live' | undefined {
  return tone === 'attention' || tone === 'live' ? tone : undefined;
}

// The hue rides an inline custom property so the static class can stay shared;
// `recent` carries no property because the data-tone selector never matches it.
function folderToneStyle(tone: DashboardStatus): CSSProperties | undefined {
  if (tone === 'attention') return { '--folder-tone': 'var(--warn)' } as CSSProperties;
  if (tone === 'live') return { '--folder-tone': 'var(--good)' } as CSSProperties;
  return undefined;
}

// Wraps the folder icon so it can carry the rollup hue. The `&[data-tone] svg`
// selector outranks rowPrimaryClass's default `& svg` muted color (one extra
// attribute selector), so when a tone is present the folder takes it; absent the
// attribute the icon falls back to that calm default. The color eases so a
// session starting or finishing work fades the folder rather than snapping it.
const folderToneClass = css({
  display: 'inline-flex',
  flexShrink: 0,
  '& svg': { transition: 'color 180ms ease' },
  '&[data-tone] svg': { color: 'var(--folder-tone)' },
});

// The uncommitted-changes indicator in the nav. At rest it is just a small
// warn-tinted branch glyph: enough to pull a little attention to "there is
// uncommitted work here" without spelling out numbers. On row hover the glyph
// collapses and the color-coded +/- line counts expand in (green added, red
// removed), so the detail appears only once the user reaches for the row. Both
// transitions are driven off the row's `data-row-shell` hover/focus so the
// indicator stays in step with the count-to-remove crossfade beside it.
const gitDirtyClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  overflow: 'hidden',
});

const gitDirtyRestClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  overflow: 'hidden',
  maxWidth: '16px',
  opacity: 1,
  transition: 'opacity 130ms ease, max-width 160ms ease',
  '& svg': { color: 'var(--warn)' },
  '[data-row-shell]:hover &': { opacity: 0, maxWidth: 0 },
  '[data-row-shell]:has(:focus-visible) &': { opacity: 0, maxWidth: 0 },
});

const gitDirtyExpandClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  overflow: 'hidden',
  maxWidth: 0,
  opacity: 0,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
  transition: 'opacity 130ms ease 40ms, max-width 200ms cubic-bezier(0.22, 1, 0.36, 1)',
  '[data-row-shell]:hover &': { opacity: 1, maxWidth: '72px' },
  '[data-row-shell]:has(:focus-visible) &': { opacity: 1, maxWidth: '72px' },
});

// On the row the user is actively engaging, the numbers earn status color: green
// for additions, red for deletions. (The resting glyph stays warn so it reads as
// one calm "attention" beacon, not a rainbow.)
const gitInsertClass = css({ color: 'var(--good)' });
const gitDeleteClass = css({ color: 'var(--bad)' });

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
