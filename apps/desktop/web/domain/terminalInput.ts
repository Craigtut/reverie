import type { KeyboardEvent } from 'react';

import type { TerminalSurface } from '../terminalScrollback';
import type { TerminalModes } from '../terminalTypes';

// Pure translation of browser keyboard/wheel events into terminal bytes and
// scroll deltas. No DOM mutation, no React state; the event objects are read
// only for their data.

export function terminalInputForKey(
  event: KeyboardEvent<HTMLCanvasElement>,
  modes?: TerminalModes,
) {
  if (event.metaKey) return null;

  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'c') return '\x03';
    if (key === 'd') return '\x04';
    if (key === 'l') return '\x0c';
    if (key === 'u') return '\x15';
    if (key === 'w') return '\x17';
    return null;
  }

  if (event.altKey && event.key.length === 1) {
    return `\x1b${event.key}`;
  }

  const cursorApplication = Boolean(modes?.cursorKeyApplication);
  const cursorSequence = (normal: string, application: string) =>
    cursorApplication ? application : normal;

  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return cursorSequence('\x1b[A', '\x1bOA');
    case 'ArrowDown':
      return cursorSequence('\x1b[B', '\x1bOB');
    case 'ArrowRight':
      return cursorSequence('\x1b[C', '\x1bOC');
    case 'ArrowLeft':
      return cursorSequence('\x1b[D', '\x1bOD');
    case 'Delete':
      return '\x1b[3~';
    case 'Home':
      return cursorSequence('\x1b[H', '\x1bOH');
    case 'End':
      return cursorSequence('\x1b[F', '\x1bOF');
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

// Accepts any wheel-like delta (a React WheelEvent or a plain {deltaY, deltaMode})
// so the same conversion serves the viewport handler and the shell-level
// edge-to-edge wheel forwarder.
export function terminalWheelDeltaRows(
  event: { deltaY: number; deltaMode: number },
  surface: TerminalSurface,
) {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;

  const sign = event.deltaY > 0 ? 1 : -1;
  let rows: number;
  if (event.deltaMode === 1) {
    rows = Math.ceil(Math.abs(event.deltaY));
  } else if (event.deltaMode === 2) {
    rows = surface.rows;
  } else {
    rows = Math.ceil(Math.abs(event.deltaY) / surface.cellHeight);
  }

  return sign * Math.max(1, Math.min(surface.rows, rows));
}
