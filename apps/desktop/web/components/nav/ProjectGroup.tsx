import type { MouseEvent, ReactNode } from 'react';
import { CaretRight, X } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';
import { navRowActionClass, navRowActionWrapClass, rowLabelClass, rowMetaClass } from './navStyles';

// A collapsible project header in the left nav, with its focuses nested beneath.
export function ProjectGroup({
  icon,
  title,
  count,
  active,
  onProjectClick,
  onRemoveProject,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  active: boolean;
  onProjectClick: () => void;
  onRemoveProject?: (event: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className={projectGroupClass}>
      <div className={navRowActionWrapClass}>
        <button className={projectRowClass({ active })} type="button" onClick={onProjectClick}>
          <span className={caretClass}>
            <CaretRight size={11} weight="bold" />
          </span>
          {icon}
          <Typography as="span" variant="smallBody" tone="inherit" className={rowLabelClass}>
            {title}
          </Typography>
          <Typography as="span" variant="caption" tone="ghost" className={rowMetaClass}>
            {count || ''}
          </Typography>
        </button>
        {onRemoveProject ? (
          <button
            className={navRowActionClass}
            type="button"
            onClick={onRemoveProject}
            title={`Remove project ${title}`}
            data-testid="remove-project-button"
          >
            <X size={11} />
          </button>
        ) : null}
      </div>
      <div className={childrenClass}>{children}</div>
    </div>
  );
}

const projectGroupClass = css({
  display: 'grid',
  gap: '2px',
});

function projectRowClass({ active }: { active: boolean }) {
  return css({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '6px 10px',
    borderRadius: '8px',
    color: active ? 'var(--text)' : 'var(--text-2)',
    background: active ? 'var(--surface-3)' : 'transparent',
    cursor: 'pointer',
    userSelect: 'none',
    textAlign: 'left',
    position: 'relative',
    _hover: { background: 'var(--surface-2)', color: 'var(--text)' },
    '& svg': { color: active ? 'var(--text)' : 'var(--text-3)', flexShrink: 0 },
  });
}

const caretClass = css({
  width: '14px',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-3)',
  transform: 'rotate(90deg)',
});

const childrenClass = css({
  paddingLeft: '18px',
  display: 'grid',
  gap: '1px',
});
