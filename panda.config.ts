import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  jsxFramework: 'react',
  include: ['./apps/desktop/web/**/*.{ts,tsx}'],
  exclude: [],
  outdir: 'apps/desktop/web/styled-system',
  theme: {
    extend: {
      tokens: {
        colors: {
          bg: { value: '#070b16' },
          bgElevated: { value: '#0b1020' },
          panel: { value: 'rgba(15, 23, 42, 0.72)' },
          panelStrong: { value: 'rgba(7, 11, 22, 0.78)' },
          border: { value: 'rgba(236, 239, 244, 0.12)' },
          text: { value: '#e5e9f0' },
          textMuted: { value: '#a7b0c0' },
          cyan: { value: '#88c0d0' },
          green: { value: '#a3be8c' },
          amber: { value: '#ebcb8b' },
        },
        radii: {
          panel: { value: '18px' },
          pill: { value: '999px' },
        },
        shadows: {
          panel: { value: '0 24px 90px rgba(0, 0, 0, 0.42)' },
        },
      },
    },
  },
  globalCss: {
    'html, body, #root': {
      minHeight: '100%',
    },
    body: {
      margin: '0',
      colorScheme: 'dark',
      background: '#070b16',
      color: '#e5e9f0',
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
    '*': {
      boxSizing: 'border-box',
    },
    button: {
      font: 'inherit',
    },
  },
});
