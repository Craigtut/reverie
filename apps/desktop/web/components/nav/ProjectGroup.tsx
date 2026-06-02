import type { MouseEvent, ReactNode } from 'react';
import { CaretRight } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { CloseGlyph } from '../glyphs';
import { Typography } from '../primitives/Typography';
import {
  caretIconClass,
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
// group). The whole header toggles the accordion; both the caret and the row
// body are toggle targets, so the user can hit anywhere across the row. The
// trailing session count crossfades to the remove action on hover. Children
// render under a hairline guide rail when expanded.
export function ProjectGroup({
  icon,
  title,
  count,
  attention = 0,
  finished = 0,
  expanded,
  onToggle,
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
  expanded: boolean;
  onToggle: () => void;
  onRemove?: (event: MouseEvent<HTMLElement>) => void;
  removeTitle?: string;
  removeTestId?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className={projectGroupClass}>
      <div className={rowShellClass} data-active="false">
        <button
          className={rowCaretButtonClass}
          type="button"
          onClick={onToggle}
          tabIndex={-1}
          aria-hidden="true"
        >
          <span className={caretIconClass(expanded)}>
            <CaretRight size={11} weight="bold" />
          </span>
        </button>
        <button
          className={rowPrimaryClass}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          data-testid={testId}
          data-expanded={expanded ? 'true' : 'false'}
        >
          {icon}
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
