import { CornersOut, Minus, X } from '@phosphor-icons/react';
import { css } from '../../styled-system/css';
import { invokeWindowControl } from '../../services/windowControls';

// macOS-style window controls in the titlebar.
export function TrafficLights() {
  return (
    <div className={lightsClass} aria-label="Window controls" data-testid="window-controls">
      <button
        type="button"
        aria-label="Close window"
        data-action="close"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('close')}
      >
        <X size={8} weight="bold" />
      </button>
      <button
        type="button"
        aria-label="Minimize window"
        data-action="min"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('minimize')}
      >
        <Minus size={8} weight="bold" />
      </button>
      <button
        type="button"
        aria-label="Toggle full screen"
        data-action="max"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('toggleFullscreen')}
      >
        <CornersOut size={8} weight="bold" />
      </button>
    </div>
  );
}

const lightsClass = css({
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  // Centering uses grid + placeItems on the button itself, the same proven
  // pattern as the left-nav row action buttons (navStyles rowActionClass).
  '& button': {
    boxSizing: 'border-box',
    display: 'grid',
    placeItems: 'center',
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '0.5px solid rgba(0,0,0,0.28)',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    boxShadow: 'inset 0 -0.5px 0 rgba(0,0,0,0.18), inset 0 0.5px 0 rgba(255,255,255,0.18)',
  },
  '& button[data-action="close"]': { background: '#ED6A5E' },
  '& button[data-action="min"]': { background: '#F4BF4F' },
  '& button[data-action="max"]': { background: '#61C554' },
  // Glyphs are tinted and hidden until the cluster is hovered.
  '& svg': {
    display: 'block',
    gridArea: '1 / 1',
    color: 'rgba(0,0,0,0.55)',
    opacity: 0,
    transition: 'opacity 140ms ease',
  },
  '&:hover svg': { opacity: 1 },
});
