// The keyboard-shortcut catalog: a single, display-only source of truth for the
// shortcuts the app actually handles. It drives the Settings → Shortcuts tab and
// the command-palette hints. It does NOT register anything; each behavior is
// owned by its hook/component:
//   ⌘K / Esc ............ useCommandPalette
//   ⌘1–9, ⌃Tab .......... useSessionTabShortcuts
//   ⌘F, ⌘C / ⌃⇧C ........ useTerminalSession
//   ⏎ / ⇧⏎ / Esc ........ TerminalFindBar
//   ↑ ↓ ⏎ Esc ........... CommandPalette
// Keep this in sync when a shortcut is added or changed.

export interface ShortcutDef {
  id: string;
  // What the shortcut does, in plain language.
  label: string;
  // One or more alternative key combos; each combo is a list of cap glyphs.
  chords: string[][];
}

export interface ShortcutGroup {
  id: string;
  title: string;
  shortcuts: ShortcutDef[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'general',
    title: 'General',
    shortcuts: [
      { id: 'command-palette', label: 'Open the command palette', chords: [['⌘', 'K']] },
      { id: 'dismiss', label: 'Dismiss the palette, find bar, or menu', chords: [['Esc']] },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions & tabs',
    shortcuts: [
      { id: 'jump-tab', label: 'Jump to a tab', chords: [['⌘', '1–8']] },
      { id: 'jump-last', label: 'Jump to the last tab', chords: [['⌘', '9']] },
      { id: 'next-tab', label: 'Next tab', chords: [['⌃', '⇥']] },
      { id: 'prev-tab', label: 'Previous tab', chords: [['⌃', '⇧', '⇥']] },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    shortcuts: [
      { id: 'find', label: 'Find in the terminal', chords: [['⌘', 'F']] },
      {
        id: 'copy',
        label: 'Copy the selection',
        chords: [
          ['⌘', 'C'],
          ['⌃', '⇧', 'C'],
        ],
      },
      { id: 'clear-selection', label: 'Clear the selection', chords: [['Esc']] },
    ],
  },
  {
    id: 'find',
    title: 'Find bar',
    shortcuts: [
      { id: 'find-next', label: 'Next match', chords: [['⏎']] },
      { id: 'find-prev', label: 'Previous match', chords: [['⇧', '⏎']] },
      { id: 'find-close', label: 'Close find', chords: [['Esc']] },
    ],
  },
  {
    id: 'palette',
    title: 'Command palette',
    shortcuts: [
      { id: 'palette-move', label: 'Move through results', chords: [['↑'], ['↓']] },
      { id: 'palette-open', label: 'Open the highlighted result', chords: [['⏎']] },
      { id: 'palette-close', label: 'Close the palette', chords: [['Esc']] },
    ],
  },
];
