import { useEffect, useState } from 'react';

import { css } from '../../styled-system/css';
import { refreshStateFieldColors, type CellState } from '../../stateField';
import { Typography } from '../primitives/Typography';
import { StateCell } from './StateCell';

// Dev-only tuning surface for the WebGL state cells, reachable at `?statecell=1`.
// Shows every state large (for motion tuning) plus at the card / row / tab sizes
// they ship at. Not wired into the app shell.
const STATES: { state: CellState; label: string; note: string }[] = [
  { state: 'fresh', label: 'Fresh', note: 'created, never launched (near-still seed)' },
  { state: 'idle', label: 'Idle', note: 'alive, waiting for your next prompt' },
  { state: 'active', label: 'Working', note: 'mid-turn, the presence drifts' },
  { state: 'attention', label: 'Attention', note: 'awaiting you, rings ping outward' },
  { state: 'error', label: 'Error', note: 'hard error, faster red rings' },
  {
    state: 'finished',
    label: 'Finished',
    note: 'finished a turn off-screen, unseen: blooms then rests bright ("Ready for you")',
  },
];

// A cell that loops active -> idle so the "settle" transition (the moment an
// agent finishes a turn) can be tuned. The toggle every few seconds replays it.
function TransitionShowcase() {
  const [state, setState] = useState<CellState>('active');
  useEffect(() => {
    const id = window.setInterval(() => {
      setState(prev => (prev === 'active' ? 'idle' : 'active'));
    }, 2600);
    return () => window.clearInterval(id);
  }, []);
  const replay = () => {
    setState('active');
    window.setTimeout(() => setState('idle'), 80);
  };
  return (
    <div className={cardClass}>
      <StateCell state={state} size={120} />
      <div className={metaClass}>
        <Typography as="strong" variant="smallBodyAlt" tone="inherit">
          active → idle · “settle”
        </Typography>
        <Typography as="span" variant="caption" tone="inherit" style={{ opacity: 0.55 }}>
          the working energy releases outward and comes to rest (auto-loops)
        </Typography>
        <button type="button" className={replayButtonClass} onClick={replay}>
          Replay
        </button>
      </div>
    </div>
  );
}

export function StateCellDemo() {
  useEffect(() => {
    refreshStateFieldColors();
  }, []);

  // Self-contained literal palette: the demo renders outside the themed app
  // shell, so it can't read the shell's CSS variables. The real cards resolve
  // proper themed colors; this is only a motion/shape tuning surface.
  return (
    <div className={demoClass}>
      <div className={headerClass}>
        <Typography as="h1" variant="title" tone="inherit">
          Session state cells
        </Typography>
        <Typography as="p" variant="smallBody" tone="inherit" style={{ opacity: 0.6 }}>
          WebGL dot-field motion per state. Large for tuning; card (22) / row (14) / tab (10) sizes
          on the right.
        </Typography>
      </div>
      <div className={gridClass}>
        <TransitionShowcase />
      </div>
      <div className={gridClass}>
        {STATES.map(({ state, label, note }) => (
          <div key={state} className={cardClass}>
            <StateCell state={state} size={120} />
            <div className={metaClass}>
              <Typography as="strong" variant="smallBodyAlt" tone="inherit">
                {label}
              </Typography>
              <Typography as="span" variant="caption" tone="inherit" style={{ opacity: 0.55 }}>
                {note}
              </Typography>
              <div className={scalesClass}>
                <StateCell state={state} size={22} />
                <StateCell state={state} size={14} />
                <StateCell state={state} size={10} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const demoClass = css({
  minHeight: '100vh',
  background: '#0B0A09',
  color: '#EDE6DA',
  padding: '48px',
  display: 'flex',
  flexDirection: 'column',
  gap: '28px',
});

const headerClass = css({ display: 'grid', gap: '6px' });

const gridClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: '18px',
});

const cardClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '20px',
  padding: '22px',
  borderRadius: '18px',
  border: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.025)',
});

const metaClass = css({ display: 'grid', gap: '5px', minWidth: 0 });

const scalesClass = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  marginTop: '8px',
});

const replayButtonClass = css({
  marginTop: '8px',
  alignSelf: 'start',
  padding: '4px 12px',
  borderRadius: '8px',
  border: '1px solid rgba(255,255,255,0.16)',
  background: 'rgba(255,255,255,0.04)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '12px',
  _hover: { background: 'rgba(255,255,255,0.09)' },
});
