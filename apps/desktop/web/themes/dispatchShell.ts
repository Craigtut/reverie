import { css } from '../styled-system/css';

// Token + layout frame for the dispatch popup (the global-shortcut capture
// window). It mounts the SAME warm-neutral palette as appShell.ts as CSS custom
// properties, switched by [data-theme], but unlike the main shell it keeps its
// own background TRANSPARENT: the dispatch window is a transparent native
// window, so only the rim-lit panel should show, floating over whatever is
// behind it.
//
// The palette is duplicated here (not shared) because Panda's build-time
// extractor cannot resolve a cross-file spread of the custom-property
// declarations; appShell.ts and this file must each inline them. Keep the two in
// sync. See [[panda-cross-file-spread]].

export const dispatchRootClass = css({
  // --- palette (dark default); mirror of appShell.ts ---
  '--bg': '#0B0A09',
  '--bg-deep': '#060605',
  '--surface-1': '#131210',
  '--surface-2': '#1A1816',
  '--surface-3': '#221F1C',
  '--surface-hi': '#2A2622',
  '--line-faint': 'rgba(245, 235, 220, 0.05)',
  '--line': 'rgba(245, 235, 220, 0.09)',
  '--line-strong': 'rgba(245, 235, 220, 0.16)',
  '--text': '#EFE9DF',
  '--text-2': '#B7AEA1',
  '--text-3': '#7B7268',
  '--text-4': '#4F4842',
  '--dot-bg': 'rgba(239, 233, 223, 0.08)',
  '--dot-ambient': 'rgba(239, 233, 223, 0.55)',
  '--dot-bright': 'rgba(239, 233, 223, 0.95)',
  '--rim-1': 'rgba(255, 250, 240, 0.55)',
  '--rim-2': 'rgba(255, 250, 240, 0.04)',
  '--good': '#6FB87A',
  '--warn': '#E5A24E',
  '--bad': '#D96B5C',
  '--selection': 'rgba(231, 222, 206, 0.22)',
  '--shadow': '0 30px 60px -20px rgba(0,0,0,0.55), 0 12px 32px -12px rgba(0,0,0,0.6)',

  // --- popup layout ---
  position: 'fixed',
  inset: 0,
  display: 'grid',
  // Anchor the panel to the top-center. The window grows downward while a
  // dropdown is open, so menus render into the (transparent) space below the
  // panel instead of being clipped.
  justifyItems: 'center',
  alignItems: 'start',
  // Room for the panel's drop shadow against the (transparent) window edges.
  padding: '24px',
  background: 'transparent',
  color: 'var(--text)',
  fontSize: '13px',
  lineHeight: '1.45',
  letterSpacing: '-0.005em',
  userSelect: 'none',
  WebkitUserSelect: 'none',

  '&[data-theme="light"]': {
    '--bg': '#F4F1EB',
    '--bg-deep': '#ECE7DD',
    '--surface-1': '#FAF7F0',
    '--surface-2': '#F1ECE2',
    '--surface-3': '#E8E2D5',
    '--surface-hi': '#DDD6C7',
    '--line-faint': 'rgba(40, 28, 14, 0.05)',
    '--line': 'rgba(40, 28, 14, 0.09)',
    '--line-strong': 'rgba(40, 28, 14, 0.18)',
    '--text': '#1B1814',
    '--text-2': '#524A40',
    '--text-3': '#877E72',
    '--text-4': '#ADA395',
    '--dot-bg': 'rgba(40, 28, 14, 0.08)',
    '--dot-ambient': 'rgba(40, 28, 14, 0.50)',
    '--dot-bright': 'rgba(20, 14, 6, 0.90)',
    '--rim-1': 'rgba(255, 255, 255, 0.95)',
    '--rim-2': 'rgba(255, 255, 255, 0.15)',
    '--good': '#4A8F58',
    '--warn': '#B07A1E',
    '--bad': '#B14738',
    '--selection': 'rgba(40, 28, 14, 0.14)',
    '--shadow':
      '0 30px 60px -22px rgba(60, 40, 20, 0.18), 0 12px 28px -14px rgba(60, 40, 20, 0.18)',
  },
});
