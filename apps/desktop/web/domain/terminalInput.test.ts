import type { WheelEvent } from 'react';

import { describe, it, expect } from 'vitest';

import type { TerminalSurface } from '../terminalScrollback';
import type { TerminalModes } from '../terminalTypes';
import {
  terminalInputForKey,
  terminalInputForKeyUp,
  terminalWheelDeltaPixels,
  terminalWheelDeltaRows,
} from './terminalInput';

interface FakeKey {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

function keyEvent(parts: FakeKey) {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: parts.isComposing ?? false },
    ...parts,
  };
}

function wheelEvent(parts: { deltaY: number; deltaMode?: number }): WheelEvent<HTMLElement> {
  return { deltaMode: 0, ...parts } as unknown as WheelEvent<HTMLElement>;
}

function surface(overrides: Partial<TerminalSurface> = {}): TerminalSurface {
  return {
    cols: 80,
    rows: 24,
    cellWidth: 8,
    cellHeight: 16,
    fontSize: 14,
    baseline: 12,
    fontFamily: 'monospace',
    ...overrides,
  };
}

const appModes: TerminalModes = { cursorKeyApplication: true };

describe('terminalInputForKey', () => {
  it('returns null when the meta key is held (reserved for app shortcuts)', () => {
    expect(terminalInputForKey(keyEvent({ key: 'c', metaKey: true }))).toBeNull();
    expect(terminalInputForKey(keyEvent({ key: 'Enter', metaKey: true }))).toBeNull();
  });

  it('maps the macOS Cmd line-editing combos to readline control codes', () => {
    // Cmd+Backspace deletes to the beginning of the line (Ctrl-U).
    expect(terminalInputForKey(keyEvent({ key: 'Backspace', metaKey: true }))).toBe('\x15');
    // Cmd+Arrow jumps to the line start/end (Ctrl-A / Ctrl-E).
    expect(terminalInputForKey(keyEvent({ key: 'ArrowLeft', metaKey: true }))).toBe('\x01');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowRight', metaKey: true }))).toBe('\x05');
  });

  it('maps the macOS Option word-editing combos to Meta sequences', () => {
    // Option+Backspace deletes the previous word (Meta-DEL).
    expect(terminalInputForKey(keyEvent({ key: 'Backspace', altKey: true }))).toBe('\x1b\x7f');
    // Option+Arrow moves by word (Meta-b / Meta-f).
    expect(terminalInputForKey(keyEvent({ key: 'ArrowLeft', altKey: true }))).toBe('\x1bb');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowRight', altKey: true }))).toBe('\x1bf');
  });

  it('returns null while IME composition is active', () => {
    expect(terminalInputForKey(keyEvent({ key: 'a', isComposing: true }))).toBeNull();
    expect(terminalInputForKey(keyEvent({ key: 'Process' }))).toBeNull();
  });

  describe('ctrl combinations', () => {
    it('maps control letters to control codes', () => {
      expect(terminalInputForKey(keyEvent({ key: 'a', ctrlKey: true }))).toBe('\x01');
      expect(terminalInputForKey(keyEvent({ key: 'c', ctrlKey: true }))).toBe('\x03');
      expect(terminalInputForKey(keyEvent({ key: 'd', ctrlKey: true }))).toBe('\x04');
      expect(terminalInputForKey(keyEvent({ key: 'l', ctrlKey: true }))).toBe('\x0c');
      expect(terminalInputForKey(keyEvent({ key: 'u', ctrlKey: true }))).toBe('\x15');
      expect(terminalInputForKey(keyEvent({ key: 'w', ctrlKey: true }))).toBe('\x17');
    });

    it('is case-insensitive on the control letter', () => {
      expect(terminalInputForKey(keyEvent({ key: 'C', ctrlKey: true }))).toBe('\x03');
    });

    it('maps non-letter control combinations used by shells', () => {
      expect(terminalInputForKey(keyEvent({ key: ' ', ctrlKey: true }))).toBe('\x00');
      expect(terminalInputForKey(keyEvent({ key: '[', ctrlKey: true }))).toBe('\x1b');
      expect(terminalInputForKey(keyEvent({ key: ']', ctrlKey: true }))).toBe('\x1d');
      expect(terminalInputForKey(keyEvent({ key: 'Enter', ctrlKey: true }))).toBe('\r');
      expect(terminalInputForKey(keyEvent({ key: 'Backspace', ctrlKey: true }))).toBe('\x7f');
    });

    it('maps control navigation to modified xterm sequences', () => {
      expect(terminalInputForKey(keyEvent({ key: 'ArrowLeft', ctrlKey: true }))).toBe('\x1b[1;5D');
      expect(terminalInputForKey(keyEvent({ key: 'Delete', ctrlKey: true }))).toBe('\x1b[3;5~');
    });
  });

  it('prefixes a single alt character with ESC', () => {
    expect(terminalInputForKey(keyEvent({ key: 'b', altKey: true }))).toBe('\x1bb');
  });

  it('does not ESC-prefix a multi-char alt key, falling through to the switch', () => {
    // alt + Enter: altKey true but key length > 1, so the switch handles Enter.
    expect(terminalInputForKey(keyEvent({ key: 'Enter', altKey: true }))).toBe('\r');
  });

  it('maps the basic editing keys', () => {
    expect(terminalInputForKey(keyEvent({ key: 'Enter' }))).toBe('\r');
    expect(terminalInputForKey(keyEvent({ key: 'Backspace' }))).toBe('\x7f');
    expect(terminalInputForKey(keyEvent({ key: 'Tab' }))).toBe('\t');
    expect(terminalInputForKey(keyEvent({ key: 'Tab', shiftKey: true }))).toBe('\x1b[Z');
    expect(terminalInputForKey(keyEvent({ key: 'Escape' }))).toBe('\x1b');
    expect(terminalInputForKey(keyEvent({ key: 'Delete' }))).toBe('\x1b[3~');
    expect(terminalInputForKey(keyEvent({ key: 'PageUp' }))).toBe('\x1b[5~');
    expect(terminalInputForKey(keyEvent({ key: 'PageDown' }))).toBe('\x1b[6~');
  });

  it('emits normal cursor sequences by default', () => {
    expect(terminalInputForKey(keyEvent({ key: 'ArrowUp' }))).toBe('\x1b[A');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowDown' }))).toBe('\x1b[B');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowRight' }))).toBe('\x1b[C');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowLeft' }))).toBe('\x1b[D');
    expect(terminalInputForKey(keyEvent({ key: 'Home' }))).toBe('\x1b[H');
    expect(terminalInputForKey(keyEvent({ key: 'End' }))).toBe('\x1b[F');
  });

  it('emits application cursor sequences in cursor-key application mode', () => {
    expect(terminalInputForKey(keyEvent({ key: 'ArrowUp' }), appModes)).toBe('\x1bOA');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowDown' }), appModes)).toBe('\x1bOB');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowRight' }), appModes)).toBe('\x1bOC');
    expect(terminalInputForKey(keyEvent({ key: 'ArrowLeft' }), appModes)).toBe('\x1bOD');
    expect(terminalInputForKey(keyEvent({ key: 'Home' }), appModes)).toBe('\x1bOH');
    expect(terminalInputForKey(keyEvent({ key: 'End' }), appModes)).toBe('\x1bOF');
  });

  it('emits modified navigation sequences', () => {
    expect(terminalInputForKey(keyEvent({ key: 'ArrowUp', shiftKey: true }))).toBe('\x1b[1;2A');
    expect(terminalInputForKey(keyEvent({ key: 'PageDown', altKey: true }))).toBe('\x1b[6;3~');
  });

  it('emits function-key sequences', () => {
    expect(terminalInputForKey(keyEvent({ key: 'F1' }))).toBe('\x1bOP');
    expect(terminalInputForKey(keyEvent({ key: 'F5' }))).toBe('\x1b[15~');
    expect(terminalInputForKey(keyEvent({ key: 'F12', ctrlKey: true }))).toBe('\x1b[24;5~');
  });

  it('passes through a single printable character', () => {
    expect(terminalInputForKey(keyEvent({ key: 'a' }))).toBe('a');
    expect(terminalInputForKey(keyEvent({ key: ' ' }))).toBe(' ');
  });

  it('returns null for an unknown multi-character key', () => {
    expect(terminalInputForKey(keyEvent({ key: 'CapsLock' }))).toBeNull();
  });

  describe('kitty keyboard protocol delegation', () => {
    const kitty: TerminalModes = { kittyKeyboardFlags: 0b1 }; // disambiguate

    it('keeps legacy encoding when no kitty flags are active', () => {
      // Shift+Enter falls back to LF (the non-kitty newline convention), plain
      // Enter stays CR, and ctrl combos keep their C0 codes.
      expect(terminalInputForKey(keyEvent({ key: 'Enter' }))).toBe('\r');
      expect(terminalInputForKey(keyEvent({ key: 'Enter', shiftKey: true }))).toBe('\n');
      expect(terminalInputForKey(keyEvent({ key: 'c', ctrlKey: true }))).toBe('\x03');
    });

    it('routes through the kitty encoder once flags are set', () => {
      expect(terminalInputForKey(keyEvent({ key: 'Enter', shiftKey: true }), kitty)).toBe(
        '\x1b[13;2u',
      );
      // Ctrl+C becomes CSI u; the app that enabled the protocol decodes it.
      expect(terminalInputForKey(keyEvent({ key: 'c', ctrlKey: true }), kitty)).toBe('\x1b[99;5u');
      // Plain typing still passes through as text.
      expect(terminalInputForKey(keyEvent({ key: 'a' }), kitty)).toBe('a');
    });

    it('still swallows Cmd combos in kitty mode (app shortcuts win)', () => {
      expect(terminalInputForKey(keyEvent({ key: 'c', metaKey: true }), kitty)).toBeNull();
      expect(terminalInputForKey(keyEvent({ key: 'Backspace', metaKey: true }), kitty)).toBe(
        '\x15',
      );
    });
  });
});

describe('terminalInputForKeyUp', () => {
  it('sends nothing without the report-events flag', () => {
    expect(terminalInputForKeyUp(keyEvent({ key: 'a' }))).toBeNull();
    expect(terminalInputForKeyUp(keyEvent({ key: 'a' }), { kittyKeyboardFlags: 0b1 })).toBeNull();
  });

  it('encodes a release when report-events is active', () => {
    const modes: TerminalModes = { kittyKeyboardFlags: 0b11 }; // disambiguate + events
    expect(terminalInputForKeyUp(keyEvent({ key: 'ArrowUp' }), modes)).toBe('\x1b[1;1:3A');
  });
});

describe('terminalWheelDeltaRows', () => {
  it('returns 0 for a zero deltaY', () => {
    expect(terminalWheelDeltaRows(wheelEvent({ deltaY: 0 }), surface())).toBe(0);
  });

  it('returns 0 for a non-finite deltaY', () => {
    expect(terminalWheelDeltaRows(wheelEvent({ deltaY: Number.NaN }), surface())).toBe(0);
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: Number.POSITIVE_INFINITY }), surface()),
    ).toBe(0);
  });

  it('treats deltaMode line (1) as a row count', () => {
    expect(terminalWheelDeltaRows(wheelEvent({ deltaY: 3, deltaMode: 1 }), surface())).toBe(3);
    // ceil of a fractional line count
    expect(terminalWheelDeltaRows(wheelEvent({ deltaY: 2.2, deltaMode: 1 }), surface())).toBe(3);
  });

  it('treats deltaMode page (2) as a whole surface of rows', () => {
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: 1, deltaMode: 2 }), surface({ rows: 30 })),
    ).toBe(30);
  });

  it('converts pixel deltas (deltaMode 0) into rows via cellHeight', () => {
    // 32px / 16px cellHeight = 2 rows
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: 32, deltaMode: 0 }), surface({ cellHeight: 16 })),
    ).toBe(2);
    // ceil rounding: 17px / 16 = 1.06 -> 2
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: 17, deltaMode: 0 }), surface({ cellHeight: 16 })),
    ).toBe(2);
  });

  it('preserves sign for upward (negative) scrolls', () => {
    expect(
      terminalWheelDeltaRows(
        wheelEvent({ deltaY: -48, deltaMode: 0 }),
        surface({ cellHeight: 16 }),
      ),
    ).toBe(-3);
    expect(terminalWheelDeltaRows(wheelEvent({ deltaY: -5, deltaMode: 1 }), surface())).toBe(-5);
  });

  it('clamps the magnitude to at least 1 row', () => {
    // 4px / 16px = 0.25 -> ceil 1, clamped min 1
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: 4, deltaMode: 0 }), surface({ cellHeight: 16 })),
    ).toBe(1);
  });

  it('clamps large wheel flings to four surface pages', () => {
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: 99, deltaMode: 1 }), surface({ rows: 24 })),
    ).toBe(96);
    expect(
      terminalWheelDeltaRows(wheelEvent({ deltaY: -99, deltaMode: 1 }), surface({ rows: 24 })),
    ).toBe(-96);
  });
});

describe('terminalWheelDeltaPixels', () => {
  it('returns 0 for a zero or invalid deltaY', () => {
    expect(terminalWheelDeltaPixels(wheelEvent({ deltaY: 0 }), surface())).toBe(0);
    expect(terminalWheelDeltaPixels(wheelEvent({ deltaY: Number.NaN }), surface())).toBe(0);
  });

  it('preserves pixel deltas without row rounding', () => {
    expect(terminalWheelDeltaPixels(wheelEvent({ deltaY: 4 }), surface({ cellHeight: 16 }))).toBe(
      4,
    );
    expect(
      terminalWheelDeltaPixels(wheelEvent({ deltaY: -0.75 }), surface({ cellHeight: 16 })),
    ).toBe(-0.75);
  });

  it('converts line and page deltas to pixels', () => {
    expect(
      terminalWheelDeltaPixels(
        wheelEvent({ deltaY: 2.5, deltaMode: 1 }),
        surface({ cellHeight: 16 }),
      ),
    ).toBe(40);
    expect(
      terminalWheelDeltaPixels(
        wheelEvent({ deltaY: -1, deltaMode: 2 }),
        surface({ rows: 24, cellHeight: 16 }),
      ),
    ).toBe(-384);
  });

  it('clamps large wheel flings to four surface pages in pixels', () => {
    expect(
      terminalWheelDeltaPixels(
        wheelEvent({ deltaY: 10_000 }),
        surface({ rows: 24, cellHeight: 16 }),
      ),
    ).toBe(1536);
    expect(
      terminalWheelDeltaPixels(
        wheelEvent({ deltaY: -10_000 }),
        surface({ rows: 24, cellHeight: 16 }),
      ),
    ).toBe(-1536);
  });
});
