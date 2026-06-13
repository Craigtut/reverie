import { useEffect } from 'react';
import { ArrowUUpLeft } from '@phosphor-icons/react';

import { css, cx } from '../../styled-system/css';
import { rimLitPanelClass } from '../../themes/surfaces';
import { useOverlayStore, type Toast as ToastModel } from '../../store';
import { Typography } from '../primitives/Typography';

// Bottom-anchored stack of transient toasts. Quiet, reversible actions (closing
// a session) drop one here with an Undo so the action stays snappy without a
// modal gate. Each toast owns its own auto-dismiss timer.
export function ToastStack() {
  const toasts = useOverlayStore(s => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={stackClass} data-testid="toast-stack" aria-live="polite">
      {toasts.map(toast => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: ToastModel }) {
  const dismissToast = useOverlayStore(s => s.dismissToast);

  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismissToast]);

  return (
    <div className={cx(rimLitPanelClass, toastClass)} role="status" data-testid="toast">
      <Typography as="span" variant="smallBody" tone="muted" className={messageClass}>
        {toast.message}
      </Typography>
      {toast.actionLabel && toast.onAction ? (
        <button
          type="button"
          className={undoButtonClass}
          data-testid="toast-action"
          onClick={() => {
            toast.onAction?.();
            dismissToast(toast.id);
          }}
        >
          <ArrowUUpLeft size={13} weight="bold" />
          <Typography as="span" variant="smallBody" tone="inherit">
            {toast.actionLabel}
          </Typography>
        </button>
      ) : null}
    </div>
  );
}

const stackClass = css({
  position: 'fixed',
  right: '22px',
  bottom: '22px',
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column-reverse',
  alignItems: 'flex-end',
  gap: '8px',
  pointerEvents: 'none',
});

const toastClass = css({
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  padding: '10px 12px 10px 16px',
  borderRadius: '12px',
  minWidth: '260px',
  maxWidth: '380px',
  animation: 'reverieRiseIn 160ms cubic-bezier(0.22, 1, 0.36, 1)',
});

const messageClass = css({
  position: 'relative',
  zIndex: 2,
  flex: 1,
  minWidth: 0,
});

const undoButtonClass = css({
  position: 'relative',
  zIndex: 2,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
  padding: '5px 10px',
  borderRadius: '8px',
  border: '1px solid var(--line)',
  background: 'var(--surface-2)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  transition: 'background 130ms ease, color 130ms ease, border-color 130ms ease',
  _hover: {
    background: 'var(--surface-hi)',
    color: 'var(--text)',
    borderColor: 'var(--line-strong)',
  },
  '& svg': { color: 'inherit' },
});
