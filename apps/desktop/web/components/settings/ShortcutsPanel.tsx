import { css } from '../../styled-system/css';
import { SHORTCUT_GROUPS } from '../../domain';
import { ShortcutKeys } from '../primitives/Kbd';
import { Typography } from '../primitives/Typography';

// The Settings → Shortcuts tab: a read-only reference of every keyboard shortcut
// the app handles, grouped by area. Not configurable; it mirrors the catalog in
// domain/shortcuts.ts. Reuses the settings list visual language (uppercase group
// label + hairline-bordered rows) so it sits flush with the other tabs.
export function ShortcutsPanel() {
  return (
    <div className={panelClass} data-testid="settings-shortcuts">
      {SHORTCUT_GROUPS.map(group => (
        <section key={group.id} className={groupClass} aria-labelledby={`shortcuts-${group.id}`}>
          <Typography
            as="h2"
            id={`shortcuts-${group.id}`}
            variant="tiny"
            tone="faint"
            uppercase
            style={{ letterSpacing: '0.12em' }}
          >
            {group.title}
          </Typography>
          <ul className={listClass}>
            {group.shortcuts.map(shortcut => (
              <li key={shortcut.id} className={rowClass}>
                <Typography
                  as="span"
                  variant="smallBody"
                  tone="default"
                  style={{ letterSpacing: '-0.005em' }}
                >
                  {shortcut.label}
                </Typography>
                <ShortcutKeys chords={shortcut.chords} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const panelClass = css({
  display: 'grid',
  gap: '36px',
});

const groupClass = css({
  display: 'grid',
  gap: '12px',
});

const listClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  borderTop: '1px solid var(--line-faint)',
  borderBottom: '1px solid var(--line-faint)',
});

const rowClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '24px',
  padding: '14px 4px',
  borderTop: '1px solid var(--line-faint)',
  _first: { borderTop: 'none' },
});
