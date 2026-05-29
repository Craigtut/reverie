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
      />
      <button
        type="button"
        aria-label="Minimize window"
        data-action="min"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('minimize')}
      />
      <button
        type="button"
        aria-label="Maximize window"
        data-action="max"
        data-tauri-drag-region={false}
        onClick={() => void invokeWindowControl('toggleMaximize')}
      />
    </div>
  );
}

const lightsClass = css({
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  '& button': {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    border: '0.5px solid rgba(0,0,0,0.28)',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    boxShadow: 'inset 0 -0.5px 0 rgba(0,0,0,0.18), inset 0 0.5px 0 rgba(255,255,255,0.18)',
    transition: 'transform 140ms ease, filter 140ms ease',
  },
  '& button[data-action="close"]': { background: '#ED6A5E' },
  '& button[data-action="min"]': { background: '#F4BF4F' },
  '& button[data-action="max"]': { background: '#61C554' },
  '& button:hover': { transform: 'scale(1.05)', filter: 'brightness(1.05)' },
});
