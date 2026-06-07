import type { TerminalSurface } from '../terminalScrollback';
import type { TerminalModes } from '../terminalTypes';

// Pure translation of browser keyboard/wheel events into terminal bytes and
// scroll deltas. No DOM mutation, no React state; the event objects are read
// only for their data.

export interface TerminalKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
}

export function terminalInputForKey(event: TerminalKeyInput, modes?: TerminalModes) {
  if (event.nativeEvent?.isComposing || event.key === 'Process') return null;

  // Cmd is reserved for app shortcuts (copy, palette, tab switching), so it is
  // swallowed by default. The exceptions are the macOS line-editing combos,
  // which terminals translate into the equivalent readline control codes.
  if (event.metaKey) {
    switch (event.key) {
      case 'Backspace':
        return '\x15'; // delete to beginning of line (Ctrl-U)
      case 'ArrowLeft':
        return '\x01'; // jump to beginning of line (Ctrl-A)
      case 'ArrowRight':
        return '\x05'; // jump to end of line (Ctrl-E)
      default:
        return null;
    }
  }

  if (event.ctrlKey) {
    const modified = modifiedControlSequence(event.key, modifierCode(event));
    if (modified) return modified;
    const control = controlCodeForKey(event.key);
    if (control !== null) return control;
    return null;
  }

  if (event.altKey) {
    // Option + a printable character sends it ESC-prefixed (Meta-x).
    if (event.key.length === 1) return `\x1b${event.key}`;
    // Option + an editing key does word-wise edits/motion, matching how macOS
    // terminals translate the Meta modifier for the CLI's line editor. Other
    // named keys (Enter, etc.) fall through to the plain switch below.
    switch (event.key) {
      case 'Backspace':
        return '\x1b\x7f'; // delete previous word (Meta-DEL)
      case 'ArrowLeft':
        return '\x1bb'; // move back one word (Meta-b)
      case 'ArrowRight':
        return '\x1bf'; // move forward one word (Meta-f)
    }
  }

  const cursorApplication = Boolean(modes?.cursorKeyApplication);
  const cursorSequence = (normal: string, application: string) =>
    cursorApplication ? application : normal;
  const modified = modifierCode(event);
  const modifiedCsi = modified > 1 ? `;${modified}` : '';

  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return event.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      if (modified > 1) return `\x1b[1${modifiedCsi}A`;
      return cursorSequence('\x1b[A', '\x1bOA');
    case 'ArrowDown':
      if (modified > 1) return `\x1b[1${modifiedCsi}B`;
      return cursorSequence('\x1b[B', '\x1bOB');
    case 'ArrowRight':
      if (modified > 1) return `\x1b[1${modifiedCsi}C`;
      return cursorSequence('\x1b[C', '\x1bOC');
    case 'ArrowLeft':
      if (modified > 1) return `\x1b[1${modifiedCsi}D`;
      return cursorSequence('\x1b[D', '\x1bOD');
    case 'Delete':
      return `\x1b[3${modifiedCsi}~`;
    case 'Home':
      if (modified > 1) return `\x1b[1${modifiedCsi}H`;
      return cursorSequence('\x1b[H', '\x1bOH');
    case 'End':
      if (modified > 1) return `\x1b[1${modifiedCsi}F`;
      return cursorSequence('\x1b[F', '\x1bOF');
    case 'PageUp':
      return `\x1b[5${modifiedCsi}~`;
    case 'PageDown':
      return `\x1b[6${modifiedCsi}~`;
    default:
      if (event.key.startsWith('F')) {
        return functionKeySequence(event.key, modified);
      }
      return event.key.length === 1 ? event.key : null;
  }
}

function controlCodeForKey(key: string): string | null {
  if (key.length === 1) {
    const lower = key.toLowerCase();
    const code = lower.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(code - 96);
    }
    switch (key) {
      case ' ':
      case '2':
        return '\x00';
      case '[':
      case '3':
        return '\x1b';
      case '\\':
      case '4':
        return '\x1c';
      case ']':
      case '5':
        return '\x1d';
      case '^':
      case '6':
        return '\x1e';
      case '_':
      case '7':
        return '\x1f';
      case '?':
      case '8':
        return '\x7f';
    }
  }
  switch (key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    default:
      return null;
  }
}

function modifiedControlSequence(key: string, modifier: number): string | null {
  const suffix = `;${modifier}`;
  switch (key) {
    case 'ArrowUp':
      return `\x1b[1${suffix}A`;
    case 'ArrowDown':
      return `\x1b[1${suffix}B`;
    case 'ArrowRight':
      return `\x1b[1${suffix}C`;
    case 'ArrowLeft':
      return `\x1b[1${suffix}D`;
    case 'Home':
      return `\x1b[1${suffix}H`;
    case 'End':
      return `\x1b[1${suffix}F`;
    case 'Delete':
      return `\x1b[3${suffix}~`;
    case 'PageUp':
      return `\x1b[5${suffix}~`;
    case 'PageDown':
      return `\x1b[6${suffix}~`;
    default:
      if (key.startsWith('F')) return functionKeySequence(key, modifier);
      return null;
  }
}

function modifierCode(event: Pick<TerminalKeyInput, 'altKey' | 'ctrlKey' | 'shiftKey'>) {
  let code = 1;
  if (event.shiftKey) code += 1;
  if (event.altKey) code += 2;
  if (event.ctrlKey) code += 4;
  return code;
}

function functionKeySequence(key: string, modifier = 1): string | null {
  const number = Number(key.slice(1));
  if (!Number.isInteger(number) || number < 1 || number > 12) return null;
  const ss3 = ['P', 'Q', 'R', 'S'][number - 1];
  if (ss3) return modifier > 1 ? `\x1b[1;${modifier}${ss3}` : `\x1bO${ss3}`;
  const csiByKey: Record<number, number> = {
    5: 15,
    6: 17,
    7: 18,
    8: 19,
    9: 20,
    10: 21,
    11: 23,
    12: 24,
  };
  const code = csiByKey[number];
  if (!code) return null;
  return modifier > 1 ? `\x1b[${code};${modifier}~` : `\x1b[${code}~`;
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

  const maxRowsPerWheel = Math.max(1, surface.rows * 4);
  return sign * Math.max(1, Math.min(maxRowsPerWheel, rows));
}

export function terminalWheelDeltaPixels(
  event: { deltaY: number; deltaMode: number },
  surface: TerminalSurface,
) {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;

  const sign = event.deltaY > 0 ? 1 : -1;
  let pixels: number;
  if (event.deltaMode === 1) {
    pixels = Math.abs(event.deltaY) * surface.cellHeight;
  } else if (event.deltaMode === 2) {
    pixels = surface.rows * surface.cellHeight;
  } else {
    pixels = Math.abs(event.deltaY);
  }

  const maxPixelsPerWheel = Math.max(surface.cellHeight, surface.rows * 4 * surface.cellHeight);
  return sign * Math.min(maxPixelsPerWheel, pixels);
}
