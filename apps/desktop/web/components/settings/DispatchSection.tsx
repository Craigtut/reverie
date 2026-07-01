import { useEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';
import { Kbd } from '../primitives/Kbd';
import { Switch } from '../primitives/Switch';
import { Typography } from '../primitives/Typography';
import { onDispatchTapStatus, openInputMonitoringSettings } from '../../services/dispatchApi';

// The "Dispatch" settings block: whether the quick-launch popup opens in voice
// mode, and the global shortcut that opens it. The shortcut is a click-to-record
// control (no reliance on instructions): click it, then press the combination.
// Reflects and writes the persisted dispatch settings (drilled from the
// workspace like the other toggles); the popup and its launch path read them
// back.

interface DispatchSettings {
  dispatchShortcut: string;
  dispatchDefaultVoice: boolean;
  dispatchWindowX: number | null;
  dispatchWindowY: number | null;
}

export function DispatchSection({
  dispatchShortcut,
  dispatchDefaultVoice,
  dispatchWindowX,
  dispatchWindowY,
  onSetDispatchSettings,
}: DispatchSettings & {
  onSetDispatchSettings: (next: DispatchSettings) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  // null = unknown; false = Input Monitoring not granted (tap inactive).
  const [tapAvailable, setTapAvailable] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDispatchTapStatus(setTapAvailable).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
  // The position is preserved across shortcut/voice edits (the user moves the
  // popup by dragging it, not from here), so it rides along unchanged.
  const current: DispatchSettings = {
    dispatchShortcut,
    dispatchDefaultVoice,
    dispatchWindowX,
    dispatchWindowY,
  };

  // While recording, capture key events at the window (capture phase) so the
  // combination is read reliably and never leaks to other handlers. Two kinds
  // commit: a regular accelerator (modifier+key, or a lone function key), and a
  // lone modifier TAP (a single modifier pressed and released with no other key,
  // captured on keyup, e.g. right-Control). Escape / click-outside / re-click
  // cancels.
  useEffect(() => {
    if (!capturing) return;
    const tap = { firstMod: null as string | null, sawOther: false, multiMod: false };
    const down = new Set<string>();

    const commit = (spec: string) => {
      setCapturing(false);
      if (spec !== dispatchShortcut) {
        onSetDispatchSettings({ ...current, dispatchShortcut: spec });
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setCapturing(false);
        return;
      }
      if (isModifierKey(event)) {
        down.add(event.code);
        if (tap.firstMod === null) tap.firstMod = event.code;
        else if (event.code !== tap.firstMod) tap.multiMod = true;
        return; // wait for keyup (a tap) or a non-modifier (a combo)
      }
      tap.sawOther = true;
      const accelerator = acceleratorFromEvent(event);
      if (accelerator) commit(accelerator);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isModifierKey(event)) return;
      const spec = tapSpecFromCode(event.code);
      const cleanTap =
        spec !== null && event.code === tap.firstMod && !tap.sawOther && !tap.multiMod;
      down.delete(event.code);
      if (down.size === 0) {
        if (cleanTap && spec) commit(spec);
        tap.firstMod = null;
        tap.sawOther = false;
        tap.multiMod = false;
      }
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setCapturing(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, dispatchShortcut]);

  const display = shortcutDisplay(dispatchShortcut);

  return (
    <section className={groupClass} aria-labelledby="settings-dispatch-label">
      <Typography
        as="h2"
        id="settings-dispatch-label"
        variant="tiny"
        tone="faint"
        uppercase
        style={{ letterSpacing: '0.12em' }}
      >
        Dispatch
      </Typography>

      <ul className={listClass}>
        <li className={rowClass}>
          <div className={rowTextClass}>
            <Typography as="span" variant="smallBody" tone="default">
              Global shortcut
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              Opens the quick-launch popup from anywhere. Click to change, then press a combination
              or tap a single modifier (e.g. right-Control).
            </Typography>
            {display.tap && tapAvailable === false ? (
              <div className={permissionHintClass}>
                <Typography as="span" variant="caption" tone="warn" style={{ lineHeight: 1.5 }}>
                  This needs macOS “Input Monitoring”. Grant Reverie permission, then relaunch.
                </Typography>
                <button
                  type="button"
                  className={linkButtonClass}
                  onClick={() => void openInputMonitoringSettings()}
                >
                  <Typography as="span" variant="caption" tone="default">
                    Open System Settings
                  </Typography>
                </button>
              </div>
            ) : null}
          </div>
          <div ref={rootRef}>
            <button
              type="button"
              className={recorderClass}
              data-capturing={capturing ? 'true' : 'false'}
              aria-label={capturing ? 'Recording shortcut, press a combination' : 'Change shortcut'}
              onClick={() => setCapturing(value => !value)}
              data-testid="settings-dispatch-shortcut"
            >
              {capturing ? (
                <Typography as="span" variant="caption" tone="warn">
                  Press keys or tap a modifier…
                </Typography>
              ) : (
                <>
                  <Kbd keys={display.keys} />
                  {display.note ? (
                    <Typography as="span" variant="tiny" tone="faint">
                      {display.note}
                    </Typography>
                  ) : null}
                  <PencilGlyph />
                </>
              )}
            </button>
          </div>
        </li>

        <li className={rowClass}>
          <div className={rowTextClass}>
            <Typography as="span" variant="smallBody" tone="default">
              Start voice capture on open
            </Typography>
            <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
              Begin recording the moment the popup opens. Off opens it ready for typing, with the
              microphone one click away.
            </Typography>
          </div>
          <Switch
            checked={dispatchDefaultVoice}
            onChange={next => onSetDispatchSettings({ ...current, dispatchDefaultVoice: next })}
            ariaLabel="Start voice capture when dispatch opens"
            testId="settings-dispatch-voice-toggle"
          />
        </li>
      </ul>
    </section>
  );
}

// A small pencil to mark the shortcut control as editable, so the affordance is
// visual, not just described in the caption.
function PencilGlyph() {
  return (
    <svg
      className={pencilClass}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5l2 2-7.5 7.5-2.5.5.5-2.5 7.5-7.5z" />
    </svg>
  );
}

function isModifierKey(event: KeyboardEvent): boolean {
  return (
    event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta'
  );
}

// Map a modifier key's physical code to a `tap:` spec (handed by the actual key
// pressed), or null for a non-modifier. Fn has no reliable keydown in a webview,
// so it cannot be recorded here (the backend still supports `tap:Fn`).
function tapSpecFromCode(code: string): string | null {
  switch (code) {
    case 'ControlLeft':
      return 'tap:ControlLeft';
    case 'ControlRight':
      return 'tap:ControlRight';
    case 'ShiftLeft':
      return 'tap:ShiftLeft';
    case 'ShiftRight':
      return 'tap:ShiftRight';
    case 'AltLeft':
      return 'tap:AltLeft';
    case 'AltRight':
      return 'tap:AltRight';
    case 'MetaLeft':
      return 'tap:CommandLeft';
    case 'MetaRight':
      return 'tap:CommandRight';
    default:
      return null;
  }
}

const MOD_GLYPH: Record<string, string> = {
  Control: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Option: '⌥',
  Command: '⌘',
  Super: '⌘',
  Fn: 'fn',
};

// Resolve a stored shortcut for display: key-cap glyphs plus, for a modifier
// tap, a plain-language note (e.g. "right · tap") so the side reads as a word,
// not a stray "R" key-cap that looks like the letter R.
function shortcutDisplay(spec: string): { keys: string[]; tap: boolean; note: string | null } {
  if (spec.startsWith('tap:')) {
    const rest = spec.slice(4);
    let base = rest;
    let side: string | null = null;
    if (rest.endsWith('Right')) {
      base = rest.slice(0, -5);
      side = 'right';
    } else if (rest.endsWith('Left')) {
      base = rest.slice(0, -4);
      side = 'left';
    }
    const glyph = MOD_GLYPH[base] ?? base;
    return { keys: [glyph], tap: true, note: side ? `${side} · tap` : 'tap' };
  }
  return { keys: acceleratorToKeys(spec), tap: false, note: null };
}

// Build a Tauri accelerator string from a keydown, or null for a modifier-only
// press or an unsupported key. Requires at least one modifier, except function
// keys, which are valid global shortcuts on their own.
function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push('CommandOrControl');
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  const key = keyFromCode(event.code);
  if (!key) return null;
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (modifiers.length === 0 && !isFunctionKey) return null;
  return [...modifiers, key].join('+');
}

function keyFromCode(code: string): string | null {
  if (code === 'Space') return 'Space';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  const fkey = /^F(\d{1,2})$/.exec(code);
  if (fkey?.[1]) return `F${fkey[1]}`;
  switch (code) {
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Enter':
      return 'Enter';
    case 'Comma':
      return ',';
    case 'Period':
      return '.';
    case 'Slash':
      return '/';
    default:
      return null;
  }
}

// Turn a Tauri accelerator into key-cap glyphs for the Kbd primitive.
function acceleratorToKeys(accelerator: string): string[] {
  return accelerator.split('+').map(part => {
    switch (part) {
      case 'CommandOrControl':
      case 'Command':
      case 'Super':
        return '⌘';
      case 'Control':
        return '⌃';
      case 'Alt':
        return '⌥';
      case 'Shift':
        return '⇧';
      case 'Enter':
        return '⏎';
      case 'Up':
        return '↑';
      case 'Down':
        return '↓';
      case 'Left':
        return '←';
      case 'Right':
        return '→';
      default:
        return part;
    }
  });
}

const groupClass = css({ display: 'flex', flexDirection: 'column', gap: '12px' });

const listClass = css({ display: 'flex', flexDirection: 'column', gap: '4px' });

const rowClass = css({
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '16px',
  paddingY: '6px',
});

const rowTextClass = css({ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 });

const permissionHintClass = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '4px',
  marginTop: '2px',
});

const linkButtonClass = css({
  padding: '2px 10px',
  borderRadius: '7px',
  border: '1px solid var(--colors-border-subtle)',
  background: 'transparent',
  cursor: 'pointer',
  _hover: { background: 'var(--colors-surface-raised)' },
});

const recorderClass = css({
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  minHeight: '32px',
  minWidth: '96px',
  justifyContent: 'center',
  padding: '4px 12px',
  borderRadius: '9px',
  border: '1px solid var(--colors-border-subtle)',
  background: 'var(--colors-surface-raised)',
  cursor: 'pointer',
  transition: 'border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease',
  _hover: { borderColor: 'var(--colors-border-strong, var(--line-strong))' },
  // A focus ring + a clear recording state make the control read as editable
  // without relying on the caption text.
  _focusVisible: {
    outline: 'none',
    borderColor: 'var(--colors-text-faint)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--text-3) 30%, transparent)',
  },
  '&[data-capturing="true"]': {
    borderColor: 'var(--warn)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--warn) 28%, transparent)',
  },
});

const pencilClass = css({
  color: 'var(--text-3)',
  flexShrink: 0,
});
