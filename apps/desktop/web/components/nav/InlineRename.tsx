import { useEffect, useRef, useState } from 'react';

import { css } from '../../styled-system/css';

// The in-place editor a nav row swaps in for its label while renaming. Mounts
// focused with the text selected (Figma/Finder style), commits on Enter or blur,
// cancels on Escape. It sits in the same slot as the label so the row geometry
// does not jump. The row owns "am I being renamed"; this component owns only the
// editing buffer and the commit/cancel gestures.
export function InlineRename({
  initialValue,
  onCommit,
  onCancel,
  ariaLabel,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel: string;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter commits and the row immediately unmounts this input, which fires a
  // blur; this guard keeps that blur from committing/cancelling a second time.
  const settled = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function commit() {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  }

  function cancel() {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }

  return (
    <input
      ref={inputRef}
      className={inputClass}
      value={value}
      aria-label={ariaLabel}
      data-testid="nav-rename-input"
      spellCheck={false}
      autoComplete="off"
      onChange={event => setValue(event.target.value)}
      onKeyDown={event => {
        // Keep row/list keyboard handlers (arrow nav, shortcuts) out of the edit.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      // Pointer events inside the field must not bubble to the row (which would
      // navigate or re-trigger the double-click that opened the editor).
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
    />
  );
}

// Fills the label slot. Matches the smallBody scale the row label uses (14px),
// transparent so it reads as in-place editing, with a soft focus ring so it is
// clearly an active field. Font is set here because a native input cannot render
// through the Typography primitive.
const inputClass = css({
  flex: 1,
  minWidth: 0,
  margin: 0,
  padding: '1px 5px',
  border: '1px solid var(--line-strong)',
  borderRadius: '6px',
  background: 'var(--surface-1)',
  color: 'var(--text)',
  fontSize: '14px',
  lineHeight: '18px',
  outline: 'none',
  boxShadow: '0 0 0 2px color-mix(in srgb, var(--text) 12%, transparent)',
});
