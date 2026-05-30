import { css } from '../styled-system/css';

// The app shell frame: the outer grid that lays the warm-neutral palette down
// as CSS custom properties (dark by default, light under [data-theme="light"])
// and paints the gradient backdrop. Everything below the shell reads color
// through these vars, so this is the single source of truth for the palette and
// the only place it is mounted onto the DOM.
//
// The palette is declared inline here on purpose: Panda's build-time extractor
// does NOT resolve a spread of an imported object (flat or nested) into css(),
// so the custom-property declarations have to live in this css() literal to be
// emitted. See [[panda-cross-file-spread]].

export const appShellClass = css({
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
  // Top-left "glow" over the terminal view: a warm light that replaces the old
  // backdrop gradient. Kept very subtle; tune the alpha here.
  '--glow': 'rgba(255, 243, 224, 0.06)',
  '--good': '#6FB87A',
  '--warn': '#E5A24E',
  '--bad': '#D96B5C',
  // Mirrors TERMINAL_THEME in themes/terminalTheme.ts (the canvas renderer reads
  // the colors from there, not this var); kept in sync as the surface the
  // terminal panel matches.
  '--terminal-bg': '#0B0A09',
  '--shadow': '0 30px 60px -20px rgba(0,0,0,0.55), 0 12px 32px -12px rgba(0,0,0,0.6)',
  position: 'fixed',
  inset: 0,
  display: 'grid',
  gridTemplateColumns: '288px minmax(0, 1fr)',
  gap: '18px',
  padding: '22px',
  overflow: 'hidden',
  borderRadius: '44px',
  color: 'var(--text)',
  background:
    'radial-gradient(circle at 18% 10%, var(--surface-2), transparent 30%), linear-gradient(135deg, var(--bg), var(--bg-deep))',
  // In the terminal view the backdrop is a flat solid (no gradient) so the
  // terminal panel reads seamlessly against it; the top-left lift comes from the
  // glow overlay instead. Other surfaces (dashboard, etc.) keep the gradient.
  '&[data-terminal-view="true"]': {
    background: 'var(--bg)',
  },
  fontSize: '13px',
  lineHeight: '1.45',
  letterSpacing: '-0.005em',
  transition: 'background 0.45s ease, color 0.45s ease',
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
    '--glow': 'rgba(255, 255, 255, 0.30)',
    '--good': '#4A8F58',
    '--warn': '#B07A1E',
    '--bad': '#B14738',
    '--terminal-bg': '#11100e',
    '--shadow':
      '0 30px 60px -22px rgba(60, 40, 20, 0.18), 0 12px 28px -14px rgba(60, 40, 20, 0.18)',
  },
  lgDown: {
    gridTemplateColumns: '260px minmax(0, 1fr)',
    padding: '14px',
    borderRadius: '36px',
  },
  mdDown: {
    position: 'relative',
    minHeight: '100vh',
    gridTemplateColumns: '1fr',
    overflow: 'auto',
    borderRadius: 0,
  },
});
