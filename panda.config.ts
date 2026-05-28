import { defineConfig } from '@pandacss/dev';

// Panda CSS config for Reverie.
//
// Panda is used here only for the css() function (atomic styles in App.tsx),
// preflight reset, and JSX framework wiring. Design tokens are intentionally
// not declared here yet: the warm-neutral palette is defined inline as CSS
// custom properties on the app shell (apps/desktop/web/App.tsx → appClass)
// and switched via data-theme. Promoting that palette into proper Panda
// tokens / data-theme recipes is a follow-up. Until then this config stays
// minimal and theme-neutral so it can't fight the live token set.

export default defineConfig({
  preflight: true,
  jsxFramework: 'react',
  include: ['./apps/desktop/web/**/*.{ts,tsx}'],
  exclude: [],
  outdir: 'apps/desktop/web/styled-system',
  globalCss: {
    'html, body, #root': {
      minHeight: '100%',
    },
    body: {
      margin: '0',
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
