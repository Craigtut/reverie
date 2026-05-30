import { useEffect, useRef } from 'react';

import { css, cx } from '../../styled-system/css';
import { rimLitPanelClass } from '../../themes/surfaces';
import { useOverlayStore } from '../../store';
import { Typography } from '../primitives/Typography';

// A single, shell-level confirmation sheet for deliberate or hard-to-reverse
// actions (removing a focus or project). It reads the pending request from the
// overlay store; raising one is a plain function call from any hook. Quiet,
// reversible actions (closing a session) skip this and use an Undo toast
// instead. Esc or a click on the scrim cancels; Enter confirms.
export function ConfirmDialog() {
  const confirm = useOverlayStore(s => s.confirm);
  const dismissConfirm = useOverlayStore(s => s.dismissConfirm);
  const acceptRef = useRef<HTMLButtonElement | null>(null);

  // Esc cancels, Enter confirms. Self-contained so it depends only on the
  // request and the stable store action, never a function defined below.
  useEffect(() => {
    if (!confirm) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissConfirm();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const action = confirm?.onConfirm;
        dismissConfirm();
        action?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, dismissConfirm]);

  // Move focus to the primary action when the sheet opens, so Enter/Space and
  // screen readers land on it without an autofocus attribute.
  useEffect(() => {
    if (confirm) acceptRef.current?.focus();
  }, [confirm]);

  if (!confirm) return null;

  function accept() {
    const action = confirm?.onConfirm;
    dismissConfirm();
    action?.();
  }

  return (
    <div className={backdropClass} data-testid="confirm-backdrop">
      {/* A real button as the dismiss scrim keeps the click target accessible
          without making the card's container interactive. */}
      <button
        type="button"
        className={scrimClass}
        aria-label="Cancel"
        tabIndex={-1}
        onClick={dismissConfirm}
      />
      <div
        className={cx(rimLitPanelClass, cardClass)}
        role="alertdialog"
        aria-modal="true"
        aria-label={confirm.title}
        data-testid="confirm-dialog"
      >
        <Typography variant="subtitle" tone="default" className={titleClass}>
          {confirm.title}
        </Typography>
        {confirm.body ? (
          <Typography as="p" variant="smallBody" tone="muted" className={bodyClass}>
            {confirm.body}
          </Typography>
        ) : null}
        <div className={actionsClass}>
          <button
            type="button"
            className={cancelButtonClass}
            onClick={dismissConfirm}
            data-testid="confirm-cancel"
          >
            <Typography as="span" variant="smallBody" tone="inherit">
              {confirm.cancelLabel}
            </Typography>
          </button>
          <button
            ref={acceptRef}
            type="button"
            className={confirm.danger ? dangerButtonClass : primaryButtonClass}
            onClick={accept}
            data-testid="confirm-accept"
          >
            <Typography as="span" variant="smallBody" tone="inherit">
              {confirm.confirmLabel}
            </Typography>
          </button>
        </div>
      </div>
    </div>
  );
}

const backdropClass = css({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  padding: '24px',
  background: 'color-mix(in srgb, var(--bg-deep) 55%, transparent)',
  backdropFilter: 'blur(3px)',
  animation: 'reverieFadeIn 120ms ease',
});

const scrimClass = css({
  position: 'absolute',
  inset: 0,
  border: 0,
  padding: 0,
  background: 'transparent',
  cursor: 'default',
});

const cardClass = css({
  position: 'relative',
  width: 'min(420px, 100%)',
  padding: '22px 22px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  animation: 'reverieSheetIn 150ms cubic-bezier(0.22, 1, 0.36, 1)',
});

const titleClass = css({
  position: 'relative',
  zIndex: 2,
});

const bodyClass = css({
  position: 'relative',
  zIndex: 2,
  maxWidth: '46ch',
});

const actionsClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '8px',
});

const buttonBase = {
  padding: '8px 14px',
  borderRadius: '9px',
  border: '1px solid',
  cursor: 'pointer',
  transition: 'background 130ms ease, color 130ms ease, border-color 130ms ease',
} as const;

const cancelButtonClass = css({
  ...buttonBase,
  borderColor: 'var(--line)',
  color: 'var(--text-2)',
  background: 'transparent',
  _hover: {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    borderColor: 'var(--line-strong)',
  },
});

const primaryButtonClass = css({
  ...buttonBase,
  borderColor: 'var(--line-strong)',
  color: 'var(--text)',
  background: 'var(--surface-3)',
  _hover: { background: 'var(--surface-hi)' },
});

const dangerButtonClass = css({
  ...buttonBase,
  borderColor: 'color-mix(in srgb, var(--bad) 45%, var(--line))',
  color: 'var(--bad)',
  background: 'color-mix(in srgb, var(--bad) 12%, transparent)',
  _hover: { background: 'color-mix(in srgb, var(--bad) 20%, transparent)' },
});
