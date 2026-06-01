import { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { primaryComposerButtonClass, secondaryComposerButtonClass } from '../primitives/buttons';
import { Typography } from '../primitives/Typography';

// Shown only when the initial workspace load has exhausted its retries. A cold
// start can transiently fail to read the database (the backend is still opening
// and seeding it when the webview fires its first request), and the data is
// intact on disk. This surface says that plainly and offers a one-tap retry,
// instead of stranding the user on the empty fallback shell, which reads as
// total data loss. `onRetry` re-runs the same bounded-backoff load; success
// clears the failure flag and unmounts this overlay.
export function WorkspaceLoadError({ onRetry }: { onRetry: () => Promise<unknown> }) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className={overlayClass} data-testid="workspace-load-error">
      <motion.div
        className={cardClass}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24 }}
      >
        <span className={iconClass}>
          <WarningCircle size={26} weight="duotone" />
        </span>
        <Typography as="h1" variant="subtitle" tone="default" align="center">
          Couldn't load your workspace
        </Typography>
        <Typography
          as="p"
          variant="smallBody"
          tone="muted"
          align="center"
          className={proseClass}
          style={{ lineHeight: 1.7 }}
        >
          Your projects and sessions are safe on disk. The app just couldn't read them while
          starting up. Retry to load them again.
        </Typography>
        <div className={actionsClass}>
          <button
            type="button"
            className={primaryComposerButtonClass}
            onClick={handleRetry}
            disabled={retrying}
            data-testid="workspace-load-retry"
          >
            <ArrowClockwise size={15} />
            <Typography as="span" variant="smallBody" tone="inherit">
              {retrying ? 'Retrying' : 'Retry'}
            </Typography>
          </button>
          <button
            type="button"
            className={secondaryComposerButtonClass}
            onClick={() => window.location.reload()}
          >
            <Typography as="span" variant="smallBody" tone="inherit">
              Reload window
            </Typography>
          </button>
        </div>
      </motion.div>
    </div>
  );
}

const overlayClass = css({
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'grid',
  placeItems: 'center',
  padding: '24px',
  background: 'color-mix(in srgb, var(--bg) 90%, transparent)',
  backdropFilter: 'blur(6px)',
});

const cardClass = css({
  display: 'grid',
  justifyItems: 'center',
  gap: '14px',
  width: 'min(420px, calc(100vw - 80px))',
  padding: '28px 30px',
  borderRadius: '20px',
  border: '1px solid var(--line)',
  background: 'var(--surface-1)',
  boxShadow: 'var(--shadow)',
  textAlign: 'center',
  '& p': { margin: 0 },
});

const iconClass = css({
  display: 'inline-flex',
  color: 'var(--warn)',
});

const proseClass = css({
  maxWidth: '340px',
});

const actionsClass = css({
  display: 'flex',
  gap: '10px',
  flexWrap: 'wrap',
  justifyContent: 'center',
  marginTop: '4px',
});
