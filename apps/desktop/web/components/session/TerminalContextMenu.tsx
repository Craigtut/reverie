import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';
import { Typography } from '../primitives/Typography';
import type { MenuItemModel, MenuModel } from '../../terminal/interaction';

export interface TerminalContextMenuProps {
  model: MenuModel | null;
  onClose: () => void;
}

const VIEWPORT_MARGIN_PX = 8;

// The terminal right-click menu. It renders a flat, pre-resolved MenuModel: it
// has no knowledge of targets, actions, or the registry. Dividers are drawn
// where the group changes. Keyboard: arrows move the highlight across enabled
// items, Enter invokes, Escape closes; an outside pointer-down also closes.
export function TerminalContextMenu({ model, onClose }: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);

  const open = Boolean(model?.open);
  const items = model?.items ?? [];

  // Reset the highlight to the first enabled item whenever the menu (re)opens.
  // Keyed off open + position on purpose: `items` is a fresh array each render,
  // so depending on it would reset the highlight every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional open/position key
  useEffect(() => {
    if (!open) return;
    const first = items.findIndex(item => item.enabled);
    setActiveIndex(first);
    menuRef.current?.focus();
  }, [open, model?.x, model?.y]);

  // Flip/clamp the menu so it stays within the window.
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

  // Close on any pointer-down outside the menu.
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
    if (items.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < items.length; step += 1) {
      next = (next + delta + items.length) % items.length;
      if (items[next].enabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function invoke(item: MenuItemModel) {
    if (!item.enabled) return;
    onClose();
    item.onInvoke();
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
      if (activeIndex >= 0 && items[activeIndex]) invoke(items[activeIndex]);
    }
  }

  return (
    <div
      ref={menuRef}
      className={menuClass}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      data-testid="terminal-context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const showDivider = index > 0 && items[index - 1].group !== item.group;
        return (
          <div key={item.id} className={showDivider ? dividerWrapClass : undefined}>
            {showDivider ? <div className={dividerClass} aria-hidden /> : null}
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              data-testid={`menu-item-${item.id}`}
              data-active={index === activeIndex ? 'true' : undefined}
              disabled={!item.enabled}
              // A click inside the menu never triggers the outside-close handler
              // (it checks contains()), so a plain onClick is safe and works for
              // both real pointers and synthetic clicks.
              onClick={() => invoke(item)}
              onMouseEnter={() => item.enabled && setActiveIndex(index)}
            >
              <Typography variant="smallBody" tone={item.enabled ? 'default' : 'ghost'}>
                {item.label}
              </Typography>
            </button>
          </div>
        );
      })}
    </div>
  );
}

const menuClass = css({
  position: 'fixed',
  zIndex: 60,
  minWidth: '184px',
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
  '&:disabled': { cursor: 'default', _hover: { background: 'transparent' } },
});

const dividerWrapClass = css({ display: 'contents' });

const dividerClass = css({
  height: '1px',
  margin: '4px 6px',
  background: 'var(--line)',
});
