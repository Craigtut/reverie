import { css } from '../../styled-system/css';
import type { GroupedSessions } from '../../domain';
import { Typography } from '../primitives/Typography';

// The header count pills shared by Home and the project dashboard: a calm tally
// of working / needs-attention / ready / idle across the surface's sessions.
// Each pill lights its dot only when its bucket is non-empty, so the row reads as
// status at a glance rather than a wall of numbers. The topic view keeps its own
// active/archived caption instead, so it does not use these.
export function DashboardCountPills({ groups }: { groups: GroupedSessions }) {
  return (
    <div className={dashboardCountsClass}>
      <Typography
        as="span"
        variant="caption"
        tone="muted"
        data-tone={groups.active.length > 0 ? 'live' : 'idle'}
        data-testid="dashboard-live-count"
      >
        <i style={{ background: groups.active.length > 0 ? 'var(--good)' : 'var(--text-4)' }} />
        {groups.active.length} working
      </Typography>
      <Typography
        as="span"
        variant="caption"
        tone="muted"
        data-tone={groups.attention.length > 0 ? 'attention' : 'idle'}
        data-testid="dashboard-attention-count"
      >
        <i style={{ background: groups.attention.length > 0 ? 'var(--warn)' : 'var(--text-4)' }} />
        {groups.attention.length} need attention
      </Typography>
      <Typography
        as="span"
        variant="caption"
        tone="muted"
        data-tone="recent"
        data-testid="dashboard-ready-count"
      >
        <i style={{ background: groups.finished.length > 0 ? 'var(--text-2)' : 'var(--text-4)' }} />
        {groups.finished.length} ready
      </Typography>
      <Typography
        as="span"
        variant="caption"
        tone="muted"
        data-tone="recent"
        data-testid="dashboard-recent-count"
      >
        <i style={{ background: 'var(--text-4)' }} />
        {groups.idle.length} idle
      </Typography>
    </div>
  );
}

const dashboardCountsClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  flexWrap: 'wrap',
  '& span': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '7px',
    padding: '5px 11px',
    background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)',
    border: '1px solid var(--line)',
    borderRadius: '999px',
    fontVariantNumeric: 'tabular-nums',
  },
  '& span i': {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    display: 'inline-block',
  },
});
