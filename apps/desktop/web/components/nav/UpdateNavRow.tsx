import { ArrowClockwise } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { relaunchToUpdate } from '../../hooks';
import { useUpdateStore } from '../../store';
import { Typography } from '../primitives/Typography';

// The ambient "Relaunch to update" affordance, anchored just above Settings in
// the rail footer. It appears only once an update has been found, never
// interrupts work, and hands the relaunch to the in-flight-work gate. While the
// bundle is still downloading it shows quiet progress and stays inert.
export function UpdateNavRow() {
  const phase = useUpdateStore(s => s.phase);
  const version = useUpdateStore(s => s.availableVersion);
  const progress = useUpdateStore(s => s.downloadProgress);

  const visible = phase === 'available' || phase === 'downloading' || phase === 'ready';
  if (!visible) return null;

  const downloading = phase === 'downloading';
  const label = downloading
    ? `Downloading update${progress != null ? ` ${Math.round(progress * 100)}%` : '…'}`
    : version
      ? `Relaunch to update to ${version}`
      : 'Relaunch to update';

  return (
    <button
      type="button"
      className={rowClass}
      data-testid="relaunch-to-update-button"
      disabled={downloading}
      aria-busy={downloading}
      onClick={() => void relaunchToUpdate()}
    >
      <ArrowClockwise size={15} weight="bold" />
      <Typography as="span" variant="smallBody" tone="inherit">
        {label}
      </Typography>
    </button>
  );
}

const rowClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  marginBottom: '6px',
  padding: '9px 10px',
  borderRadius: '8px',
  border: '1px solid var(--line-faint)',
  color: 'var(--text)',
  background: 'var(--surface-2)',
  cursor: 'pointer',
  userSelect: 'none',
  textAlign: 'left',
  transition: 'background 120ms ease, border-color 120ms ease',
  _hover: { background: 'var(--surface-3)', borderColor: 'var(--line)' },
  _disabled: { cursor: 'default', opacity: 0.8, _hover: { background: 'var(--surface-2)' } },
  '& svg': { color: 'var(--accent)', flexShrink: 0 },
  '& span': {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
