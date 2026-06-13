import { describe, it, expect } from 'vitest';

import { encodeKittyKey, parseKittyFlags, type KittyKeyAction } from './kittyKeyboard';

// Progressive-enhancement flag bits, for readable test setup.
const DISAMBIGUATE = 0b1;
const REPORT_EVENTS = 0b10;
const REPORT_ALTERNATES = 0b100;
const REPORT_ALL = 0b1000;
const REPORT_ASSOCIATED = 0b10000;

interface FakeKey {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  isComposing?: boolean;
}

function keyEvent(parts: FakeKey) {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    code: parts.code,
    getModifierState: (name: string) => {
      if (name === 'CapsLock') return parts.capsLock ?? false;
      if (name === 'NumLock') return parts.numLock ?? false;
      return false;
    },
    nativeEvent: { isComposing: parts.isComposing ?? false },
    ...parts,
  };
}

function encode(parts: FakeKey, flags: number, action: KittyKeyAction = 'press') {
  return encodeKittyKey(keyEvent(parts), flags, action);
}

describe('parseKittyFlags', () => {
  it('decodes the progressive enhancement bitfield', () => {
    expect(parseKittyFlags(0)).toEqual({
      disambiguate: false,
      reportEvents: false,
      reportAlternates: false,
      reportAll: false,
      reportAssociated: false,
    });
    expect(parseKittyFlags(0b11111)).toEqual({
      disambiguate: true,
      reportEvents: true,
      reportAlternates: true,
      reportAll: true,
      reportAssociated: true,
    });
  });
});

describe('encodeKittyKey - disambiguate only', () => {
  const flags = DISAMBIGUATE;

  it('passes plain printable text straight through', () => {
    expect(encode({ key: 'a', code: 'KeyA' }, flags)).toBe('a');
    expect(encode({ key: ' ', code: 'Space' }, flags)).toBe(' ');
    expect(encode({ key: '1', code: 'Digit1' }, flags)).toBe('1');
  });

  it('keeps shift-only printable keys as their shifted text (shift is consumed)', () => {
    expect(encode({ key: 'A', code: 'KeyA', shiftKey: true }, flags)).toBe('A');
    expect(encode({ key: '!', code: 'Digit1', shiftKey: true }, flags)).toBe('!');
  });

  it('keeps unmodified Enter, Tab, Backspace as legacy bytes', () => {
    expect(encode({ key: 'Enter', code: 'Enter' }, flags)).toBe('\r');
    expect(encode({ key: 'Tab', code: 'Tab' }, flags)).toBe('\t');
    expect(encode({ key: 'Backspace', code: 'Backspace' }, flags)).toBe('\x7f');
  });

  it('encodes modified Enter, Tab, Backspace as CSI u (the Shift+Enter fix)', () => {
    expect(encode({ key: 'Enter', code: 'Enter', shiftKey: true }, flags)).toBe('\x1b[13;2u');
    expect(encode({ key: 'Enter', code: 'Enter', ctrlKey: true }, flags)).toBe('\x1b[13;5u');
    expect(encode({ key: 'Tab', code: 'Tab', shiftKey: true }, flags)).toBe('\x1b[9;2u');
    expect(encode({ key: 'Backspace', code: 'Backspace', shiftKey: true }, flags)).toBe(
      '\x1b[127;2u',
    );
  });

  it('encodes a bare Escape as CSI u so it is unambiguous', () => {
    expect(encode({ key: 'Escape', code: 'Escape' }, flags)).toBe('\x1b[27u');
  });

  it('encodes ctrl/alt letter combos as CSI u (app decodes them itself)', () => {
    expect(encode({ key: 'c', code: 'KeyC', ctrlKey: true }, flags)).toBe('\x1b[99;5u');
    expect(encode({ key: 'a', code: 'KeyA', ctrlKey: true }, flags)).toBe('\x1b[97;5u');
    expect(encode({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true }, flags)).toBe(
      '\x1b[97;6u',
    );
    expect(encode({ key: 'a', code: 'KeyA', altKey: true }, flags)).toBe('\x1b[97;3u');
    expect(encode({ key: ' ', code: 'Space', ctrlKey: true }, flags)).toBe('\x1b[32;5u');
  });

  it('derives the unshifted key number for shifted punctuation', () => {
    // Ctrl suppresses text, so this routes through CSI u keyed off the base '1'.
    expect(encode({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, flags)).toBe(
      '\x1b[49;6u',
    );
  });

  it('encodes cursor and navigation keys in CSI form, ignoring DECCKM', () => {
    expect(encode({ key: 'ArrowUp', code: 'ArrowUp' }, flags)).toBe('\x1b[A');
    expect(encode({ key: 'ArrowDown', code: 'ArrowDown' }, flags)).toBe('\x1b[B');
    expect(encode({ key: 'ArrowRight', code: 'ArrowRight' }, flags)).toBe('\x1b[C');
    expect(encode({ key: 'ArrowLeft', code: 'ArrowLeft' }, flags)).toBe('\x1b[D');
    expect(encode({ key: 'Home', code: 'Home' }, flags)).toBe('\x1b[H');
    expect(encode({ key: 'End', code: 'End' }, flags)).toBe('\x1b[F');
    expect(encode({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }, flags)).toBe('\x1b[1;2A');
    expect(encode({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }, flags)).toBe('\x1b[1;5D');
  });

  it('encodes the tilde-form keys', () => {
    expect(encode({ key: 'Delete', code: 'Delete' }, flags)).toBe('\x1b[3~');
    expect(encode({ key: 'Delete', code: 'Delete', shiftKey: true }, flags)).toBe('\x1b[3;2~');
    expect(encode({ key: 'Insert', code: 'Insert' }, flags)).toBe('\x1b[2~');
    expect(encode({ key: 'PageUp', code: 'PageUp' }, flags)).toBe('\x1b[5~');
    expect(encode({ key: 'PageDown', code: 'PageDown' }, flags)).toBe('\x1b[6~');
  });

  it('encodes function keys per the kitty table', () => {
    expect(encode({ key: 'F1', code: 'F1' }, flags)).toBe('\x1b[P');
    expect(encode({ key: 'F3', code: 'F3' }, flags)).toBe('\x1b[13~');
    expect(encode({ key: 'F5', code: 'F5' }, flags)).toBe('\x1b[15~');
    expect(encode({ key: 'F1', code: 'F1', shiftKey: true }, flags)).toBe('\x1b[1;2P');
    expect(encode({ key: 'F5', code: 'F5', ctrlKey: true }, flags)).toBe('\x1b[15;5~');
  });

  it('treats auto-repeat as a plain press when event types are not requested', () => {
    expect(encode({ key: 'a', code: 'KeyA', repeat: true }, flags, 'repeat')).toBe('a');
  });

  it('does not send standalone modifier keys without report_all', () => {
    expect(encode({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, flags)).toBeNull();
    expect(encode({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, flags)).toBeNull();
  });

  it('emits nothing for a release when event types are not requested', () => {
    expect(encode({ key: 'a', code: 'KeyA' }, flags, 'release')).toBeNull();
  });
});

describe('encodeKittyKey - report all keys (flag 8)', () => {
  const flags = DISAMBIGUATE | REPORT_ALL;

  it('encodes even unmodified text keys as CSI u', () => {
    expect(encode({ key: 'a', code: 'KeyA' }, flags)).toBe('\x1b[97u');
  });

  it('encodes Enter, Tab, Backspace as CSI u', () => {
    expect(encode({ key: 'Enter', code: 'Enter' }, flags)).toBe('\x1b[13u');
    expect(encode({ key: 'Tab', code: 'Tab' }, flags)).toBe('\x1b[9u');
    expect(encode({ key: 'Backspace', code: 'Backspace' }, flags)).toBe('\x1b[127u');
  });

  it('reports standalone modifier keys with their dedicated codes', () => {
    expect(encode({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, flags)).toBe(
      '\x1b[57441;2u',
    );
    expect(encode({ key: 'Control', code: 'ControlRight', ctrlKey: true }, flags)).toBe(
      '\x1b[57448;5u',
    );
  });
});

describe('encodeKittyKey - report alternates (flag 4)', () => {
  const flags = DISAMBIGUATE | REPORT_ALL | REPORT_ALTERNATES;

  it('includes the shifted codepoint as an alternate', () => {
    // Matches Ghostty: CSI 97:65 ; 2 u for shift+a on a US keyboard.
    expect(encode({ key: 'A', code: 'KeyA', shiftKey: true }, flags)).toBe('\x1b[97:65;2u');
  });

  it('omits alternates when the codepoint already matches the key', () => {
    expect(encode({ key: 'a', code: 'KeyA' }, flags)).toBe('\x1b[97u');
  });
});

describe('encodeKittyKey - report associated text (flag 16)', () => {
  const flags = DISAMBIGUATE | REPORT_ALL | REPORT_ASSOCIATED;

  it('appends the associated text codepoints', () => {
    expect(encode({ key: 'a', code: 'KeyA' }, flags)).toBe('\x1b[97;;97u');
    expect(encode({ key: 'A', code: 'KeyA', shiftKey: true }, flags)).toBe('\x1b[97;2;65u');
  });

  it('omits associated text when a command modifier prevents it', () => {
    expect(encode({ key: 'a', code: 'KeyA', ctrlKey: true }, flags)).toBe('\x1b[97;5u');
  });

  it('matches the Ghostty caps-lock alternate vector', () => {
    const capsFlags = DISAMBIGUATE | REPORT_ALL | REPORT_ALTERNATES | REPORT_ASSOCIATED;
    expect(encode({ key: 'J', code: 'KeyJ', capsLock: true }, capsFlags)).toBe('\x1b[106;65;74u');
  });
});

describe('encodeKittyKey - event types (flag 2)', () => {
  const flags = DISAMBIGUATE | REPORT_EVENTS;

  it('omits the :1 suffix for press events', () => {
    expect(encode({ key: 'Enter', code: 'Enter', shiftKey: true }, flags)).toBe('\x1b[13;2u');
  });

  it('encodes repeat as :2 and release as :3', () => {
    expect(encode({ key: 'Enter', code: 'Enter', shiftKey: true }, flags, 'repeat')).toBe(
      '\x1b[13;2:2u',
    );
    expect(encode({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }, flags, 'release')).toBe(
      '\x1b[1;2:3A',
    );
  });

  it('does not report release for Enter/Tab/Backspace unless report_all is set', () => {
    expect(encode({ key: 'Enter', code: 'Enter' }, flags, 'release')).toBeNull();
    expect(encode({ key: 'Tab', code: 'Tab' }, flags, 'release')).toBeNull();
    expect(encode({ key: 'Backspace', code: 'Backspace' }, flags, 'release')).toBeNull();

    const withAll = flags | REPORT_ALL;
    expect(encode({ key: 'Enter', code: 'Enter' }, withAll, 'release')).toBe('\x1b[13;1:3u');
  });
});

describe('encodeKittyKey - composition', () => {
  it('suppresses keys while composing', () => {
    expect(encode({ key: 'a', code: 'KeyA', isComposing: true }, DISAMBIGUATE)).toBeNull();
  });
});
