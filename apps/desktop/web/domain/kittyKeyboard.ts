// Kitty keyboard protocol encoder.
//
// When an application enables the kitty keyboard protocol (CSI > flags u), our
// backend records the active progressive-enhancement flags and surfaces them to
// the frontend as `modes.kittyKeyboardFlags`. This module turns a browser key
// event into the bytes the protocol specifies, so modern CLIs (Codex, Claude
// Code, Cortex) can finally tell Shift+Enter from Enter, Ctrl+C from a raw 0x03,
// and so on.
//
// The encoding mirrors Ghostty's reference encoder (src/input/key_encode.zig),
// which is the implementation these CLIs are validated against and which our
// libghostty-vt backend pairs with. The legacy (flags == 0) path lives in
// terminalInput.ts and is unchanged; this file is only consulted when at least
// one flag bit is set.
//
// Spec: https://sw.kovidgoyal.net/kitty/keyboard-protocol/

export interface KittyKeyInput {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  // Narrowed to the lock keys we read so a React KeyboardEvent's stricter
  // `(key: ModifierKey) => boolean` signature stays assignable here.
  getModifierState?: (key: 'CapsLock' | 'NumLock') => boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
}

export type KittyKeyAction = 'press' | 'repeat' | 'release';

export interface KittyFlags {
  disambiguate: boolean;
  reportEvents: boolean;
  reportAlternates: boolean;
  reportAll: boolean;
  reportAssociated: boolean;
}

export function parseKittyFlags(flags: number): KittyFlags {
  return {
    disambiguate: (flags & 0b1) !== 0,
    reportEvents: (flags & 0b10) !== 0,
    reportAlternates: (flags & 0b100) !== 0,
    reportAll: (flags & 0b1000) !== 0,
    reportAssociated: (flags & 0b10000) !== 0,
  };
}

interface KittyEntry {
  code: number;
  // Final byte. 'u' and '~' use the "full" form (with optional alternates and
  // text); the letters A/B/C/D/H/F/P/Q/S use the legacy CSI form, which carries
  // only modifiers and event type.
  final: string;
  modifier?: boolean;
}

// Functional keys keyed by KeyboardEvent.key. Ported from Ghostty's kitty.zig
// table. Enter/Tab/Backspace keep their legacy bytes when unmodified (handled
// below), but still appear here for the modified and report-all cases.
const FUNCTIONAL_BY_KEY: Record<string, KittyEntry> = {
  Escape: { code: 27, final: 'u' },
  Enter: { code: 13, final: 'u' },
  Tab: { code: 9, final: 'u' },
  Backspace: { code: 127, final: 'u' },
  Insert: { code: 2, final: '~' },
  Delete: { code: 3, final: '~' },
  ArrowLeft: { code: 1, final: 'D' },
  ArrowRight: { code: 1, final: 'C' },
  ArrowUp: { code: 1, final: 'A' },
  ArrowDown: { code: 1, final: 'B' },
  PageUp: { code: 5, final: '~' },
  PageDown: { code: 6, final: '~' },
  Home: { code: 1, final: 'H' },
  End: { code: 1, final: 'F' },
  CapsLock: { code: 57358, final: 'u', modifier: true },
  ScrollLock: { code: 57359, final: 'u' },
  NumLock: { code: 57360, final: 'u', modifier: true },
  PrintScreen: { code: 57361, final: 'u' },
  Pause: { code: 57362, final: 'u' },
  F1: { code: 1, final: 'P' },
  F2: { code: 1, final: 'Q' },
  F3: { code: 13, final: '~' },
  F4: { code: 1, final: 'S' },
  F5: { code: 15, final: '~' },
  F6: { code: 17, final: '~' },
  F7: { code: 18, final: '~' },
  F8: { code: 19, final: '~' },
  F9: { code: 20, final: '~' },
  F10: { code: 21, final: '~' },
  F11: { code: 23, final: '~' },
  F12: { code: 24, final: '~' },
  F13: { code: 57376, final: 'u' },
  F14: { code: 57377, final: 'u' },
  F15: { code: 57378, final: 'u' },
  F16: { code: 57379, final: 'u' },
  F17: { code: 57380, final: 'u' },
  F18: { code: 57381, final: 'u' },
  F19: { code: 57382, final: 'u' },
  F20: { code: 57383, final: 'u' },
  F21: { code: 57384, final: 'u' },
  F22: { code: 57385, final: 'u' },
  F23: { code: 57386, final: 'u' },
  F24: { code: 57387, final: 'u' },
  F25: { code: 57388, final: 'u' },
};

// Left/right modifier keys are distinguished by KeyboardEvent.code so we can
// report the correct dedicated codepoint. Only sent when report_all is set.
const MODIFIER_BY_CODE: Record<string, KittyEntry> = {
  ShiftLeft: { code: 57441, final: 'u', modifier: true },
  ShiftRight: { code: 57447, final: 'u', modifier: true },
  ControlLeft: { code: 57442, final: 'u', modifier: true },
  ControlRight: { code: 57448, final: 'u', modifier: true },
  AltLeft: { code: 57443, final: 'u', modifier: true },
  AltRight: { code: 57449, final: 'u', modifier: true },
  MetaLeft: { code: 57444, final: 'u', modifier: true },
  MetaRight: { code: 57450, final: 'u', modifier: true },
};

// Numpad keys keyed by KeyboardEvent.code (layout/numlock independent).
const NUMPAD_BY_CODE: Record<string, number> = {
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
};

// US-layout base character for the punctuation/digit physical keys, used to
// derive the unshifted codepoint and the base-layout alternate. Letters are
// handled directly from the `KeyX` code.
const BASE_BY_CODE: Record<string, string> = {
  Digit0: '0',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: ' ',
};

function isControlCodepoint(cp: number): boolean {
  return cp < 0x20 || cp === 0x7f;
}

// True when the resolved key value is a single printable character (one
// codepoint, not a control char and not a named key like "Enter"/"ArrowUp").
function isSinglePrintable(key: string): boolean {
  if (key.length === 0) return false;
  const codepoints = Array.from(key);
  if (codepoints.length !== 1) return false;
  return !isControlCodepoint(codepoints[0].codePointAt(0) ?? 0);
}

// The PC-101 base-layout codepoint for the physical key, independent of the
// active keyboard layout. Derived from KeyboardEvent.code (always US-physical).
function baseLayoutCodepoint(event: KittyKeyInput): number | null {
  const code = event.code;
  if (code) {
    if (code.length === 4 && code.startsWith('Key')) {
      return code.charCodeAt(3) + 32; // 'KeyA' -> 'a'
    }
    const base = BASE_BY_CODE[code];
    if (base) return base.codePointAt(0) ?? null;
  }
  if (isSinglePrintable(event.key)) {
    return event.key.toLowerCase().codePointAt(0) ?? null;
  }
  return null;
}

// The unshifted codepoint used as the CSI-u key number for a text key, e.g.
// Shift+A and Ctrl+A both key off 'a' (97). Prefers the physical-key base so
// shifted punctuation (Shift+1 -> '!') still keys off its base ('1').
function unshiftedCodepoint(event: KittyKeyInput): number | null {
  const base = baseLayoutCodepoint(event);
  if (base != null) return base;
  if (isSinglePrintable(event.key)) {
    return event.key.toLowerCase().codePointAt(0) ?? null;
  }
  return null;
}

function lookupEntry(event: KittyKeyInput): KittyEntry | null {
  const code = event.code;
  if (code) {
    const modifier = MODIFIER_BY_CODE[code];
    if (modifier) return modifier;
    const numpad = NUMPAD_BY_CODE[code];
    if (numpad != null) return { code: numpad, final: 'u' };
  }
  const functional = FUNCTIONAL_BY_KEY[event.key];
  if (functional) return functional;
  const cp = unshiftedCodepoint(event);
  if (cp != null && cp > 0) return { code: cp, final: 'u' };
  return null;
}

// The kitty modifier value: bitfield + 1, per the spec.
function kittyModifierValue(mods: {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
  capsLock: boolean;
  numLock: boolean;
}): number {
  let bits = 0;
  if (mods.shift) bits |= 0b1;
  if (mods.alt) bits |= 0b10;
  if (mods.ctrl) bits |= 0b100;
  if (mods.super) bits |= 0b1000;
  if (mods.capsLock) bits |= 0b1000000;
  if (mods.numLock) bits |= 0b10000000;
  return bits + 1;
}

function modifierState(event: KittyKeyInput, name: 'CapsLock' | 'NumLock'): boolean {
  return event.getModifierState ? event.getModifierState(name) : false;
}

const EVENT_TYPE = { none: 0, press: 1, repeat: 2, release: 3 } as const;

interface KittySequence {
  entry: KittyEntry;
  modifierValue: number;
  eventType: number;
  shiftedAlternate: number | null;
  baseAlternate: number | null;
  text: string;
}

function encodeSequence(seq: KittySequence): string {
  const { entry, modifierValue, eventType } = seq;
  const emitEvent = eventType === EVENT_TYPE.repeat || eventType === EVENT_TYPE.release;

  // Legacy CSI form (arrows, Home/End, F1-F4): only modifiers and event type.
  if (entry.final !== 'u' && entry.final !== '~') {
    if (emitEvent) return `\x1b[1;${modifierValue}:${eventType}${entry.final}`;
    if (modifierValue > 1) return `\x1b[1;${modifierValue}${entry.final}`;
    return `\x1b[${entry.final}`;
  }

  // Full form: CSI key[:shifted[:base]] [;mods[:event]] [;;text] final.
  let out = `\x1b[${entry.code}`;
  if (seq.shiftedAlternate != null) out += `:${seq.shiftedAlternate}`;
  if (seq.baseAlternate != null) {
    out += seq.shiftedAlternate == null ? `::${seq.baseAlternate}` : `:${seq.baseAlternate}`;
  }

  let emittedModifiers = false;
  if (emitEvent) {
    out += `;${modifierValue}:${eventType}`;
    emittedModifiers = true;
  } else if (modifierValue > 1) {
    out += `;${modifierValue}`;
    emittedModifiers = true;
  }

  if (seq.text.length > 0) {
    let count = 0;
    for (const char of seq.text) {
      const cp = char.codePointAt(0) ?? 0;
      if (isControlCodepoint(cp)) continue;
      if (count === 0) {
        if (!emittedModifiers) out += ';';
        out += ';';
      } else {
        out += ':';
      }
      out += cp;
      count += 1;
    }
  }

  return out + entry.final;
}

/**
 * Encode a key event under the kitty keyboard protocol. `flags` is the active
 * progressive-enhancement bitfield (modes.kittyKeyboardFlags); callers only
 * reach this when it is non-zero. Returns the bytes to send, or null when the
 * event produces nothing (e.g. a release with report-events off).
 */
export function encodeKittyKey(
  event: KittyKeyInput,
  flagsValue: number,
  action: KittyKeyAction,
): string | null {
  const flags = parseKittyFlags(flagsValue);

  const ctrl = event.ctrlKey;
  const alt = event.altKey;
  const shift = Boolean(event.shiftKey);
  const capsLock = modifierState(event, 'CapsLock');
  const numLock = modifierState(event, 'NumLock');
  const composing = Boolean(event.nativeEvent?.isComposing);

  if (action === 'release') {
    if (!flags.reportEvents) return null;
    // Enter/Tab/Backspace never report release unless report_all is set.
    if (
      !flags.reportAll &&
      (event.key === 'Enter' || event.key === 'Tab' || event.key === 'Backspace')
    ) {
      return null;
    }
  }

  const entry = lookupEntry(event);

  if (composing) {
    // While composing (dead-key/IME), only standalone modifier keys are sent,
    // and only when report_all is on. Everything else is preedit text.
    if (!(entry && entry.modifier)) return null;
  }

  // The text a plain keypress would produce. Ctrl and Alt (treated as Meta on
  // our surface) suppress text, matching how the OS keymap would consume them.
  const text = isSinglePrintable(event.key) && !ctrl && !alt ? event.key : '';

  if (!flags.reportAll && !composing) {
    // "Binding" modifiers decide whether this is plain text: shift is dropped
    // when it was consumed to produce the character (so Shift+A -> "A"), but
    // not for keys that produce no text (so Shift+Enter -> CSI u).
    const bindingEmpty = !ctrl && !alt && (!shift || text !== '');
    if (bindingEmpty) {
      if (event.key === 'Enter') return '\r';
      if (event.key === 'Tab') return '\t';
      if (event.key === 'Backspace') return '\x7f';
    }
    if (text !== '' && action !== 'release') {
      return text;
    }
  }

  if (!entry) {
    // No mapping. If there is text (e.g. composed input under report_all), pass
    // it through; otherwise nothing to send.
    return text !== '' ? text : null;
  }

  // Standalone modifier keys require report_all.
  if (entry.modifier && !flags.reportAll) return null;

  const modifierValue = kittyModifierValue({
    shift,
    alt,
    ctrl,
    super: false, // Cmd is reserved for app shortcuts and never reaches here.
    capsLock,
    numLock,
  });

  let eventType: number = EVENT_TYPE.none;
  if (flags.reportEvents) {
    eventType =
      action === 'release'
        ? EVENT_TYPE.release
        : action === 'repeat'
          ? EVENT_TYPE.repeat
          : EVENT_TYPE.press;
  }

  let shiftedAlternate: number | null = null;
  let baseAlternate: number | null = null;
  if (flags.reportAlternates && !isControlCodepoint(entry.code)) {
    const codepoints = Array.from(text);
    const cp1 = codepoints.length > 0 ? (codepoints[0].codePointAt(0) ?? null) : null;
    if (cp1 != null) {
      if (cp1 !== entry.code && shift) shiftedAlternate = cp1;
      const hasSecondCodepoint = codepoints.length > 1;
      const base = baseLayoutCodepoint(event);
      if (base != null && base !== entry.code && cp1 !== base && !hasSecondCodepoint) {
        baseAlternate = base;
      }
    } else {
      const base = baseLayoutCodepoint(event);
      if (base != null && base !== entry.code) baseAlternate = base;
    }
  }

  let associatedText = '';
  if (flags.reportAssociated && eventType !== EVENT_TYPE.release) {
    // Ctrl/Alt/Super prevent associated text (the keypress is a command, not
    // typed text). Alt counts as a modifier on our surface (Option-as-Meta).
    const preventsText = alt || ctrl;
    if (!preventsText) associatedText = text;
  }

  return encodeSequence({
    entry,
    modifierValue,
    eventType,
    shiftedAlternate,
    baseAlternate,
    text: associatedText,
  });
}
