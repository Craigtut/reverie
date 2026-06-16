import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { css, cx } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';

// One row in a nav right-click menu. `icon` is the leading glyph (every item
// carries one so the column stays aligned); `dividerBefore` draws a separator
// above the item (used to fence the removal action off from the safe ones);
// `danger` tints both the icon and label. The model is flat and pre-resolved:
// the menu knows nothing about the entity it acts on, only how to render and
// invoke these items.
export interface NavMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  dividerBefore?: boolean;
  onSelect: () => void;
}

export interface NavMenuModel {
  x: number;
  y: number;
  items: NavMenuItem[];
}

const VIEWPORT_MARGIN_PX = 8;

// The left-nav right-click menu. Mirrors the terminal context menu's behavior so
// the two feel identical: arrows move the highlight, Enter invokes, Escape or an
// outside pointer-down closes, and the menu flips/clamps to stay on screen.
export function NavContextMenu({
  model,
  onClose,
}: {
  model: NavMenuModel | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [activeIndex, setActiveIndex] = useState(0);

  const open = Boolean(model);
  const items = model?.items ?? [];

  // Reset the highlight to the first item whenever the menu (re)opens. Keyed off
  // the open position, not `items` (a fresh array each render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional open/position key
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    menuRef.current?.focus();
  }, [open, model?.x, model?.y]);

  useLayoutEffect(() => {
    if (!open || !model || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - VIEWPORT_MARGIN_PX;
    const maxY = window.innerHeight - rect.height - VIEWPORT_MARGIN_PX;
    setPosition({
      x: Math.max(VIEWPORT_MARGIN_PX, Math.min(model.x, maxX)),
      y: Math.max(VIEWPORT_MARGIN_PX, Math.min(model.y, maxY)),
    });
  }, [open, model]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose]);

  if (!open || !model || items.length === 0) return null;

  function moveHighlight(delta: number) {
    setActiveIndex(current => (current + delta + items.length) % items.length);
  }

  function invoke(item: NavMenuItem) {
    onClose();
    item.onSelect();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (items[activeIndex]) invoke(items[activeIndex]);
    }
  }

  return (
    <div
      ref={menuRef}
      className={menuClass}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      data-testid="nav-context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <div key={item.id} className={item.dividerBefore ? dividerWrapClass : undefined}>
          {item.dividerBefore ? <div className={dividerClass} aria-hidden /> : null}
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            data-testid={`nav-menu-item-${item.id}`}
            data-active={index === activeIndex ? 'true' : undefined}
            onClick={() => invoke(item)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            {item.icon ? (
              <span className={cx(iconClass, item.danger && iconDangerClass)} aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <Typography variant="smallBody" tone={item.danger ? 'bad' : 'default'}>
              {item.label}
            </Typography>
          </button>
        </div>
      ))}
    </div>
  );
}

const menuClass = css({
  position: 'fixed',
  zIndex: 60,
  minWidth: '188px',
  padding: '5px',
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  background: 'color-mix(in srgb, var(--surface-1) 96%, transparent)',
  border: '1px solid var(--line-strong)',
  borderRadius: '12px',
  boxShadow: '0 24px 60px -18px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(10px)',
  outline: 'none',
});

const itemClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '9px',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  border: 0,
  borderRadius: '7px',
  background: 'transparent',
  cursor: 'pointer',
  transition: 'background 120ms ease',
  _hover: { background: 'var(--surface-3)' },
  '&[data-active="true"]': { background: 'var(--surface-3)' },
});

// The leading glyph. Quiet by default so the label leads; the danger variant
// turns it red to match the destructive label (the Archive action).
const iconClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  color: 'var(--text-3)',
});

const iconDangerClass = css({
  color: 'var(--bad)',
});

const dividerWrapClass = css({ display: 'contents' });

const dividerClass = css({
  height: '1px',
  margin: '4px 6px',
  background: 'var(--line)',
});
