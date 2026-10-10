import { defineConfig } from 'vitest/config';

// Isolated config for the pure-logic unit tests (domain, stores, and terminal/frameModel).
// Intentionally does not import or extend vite.config.ts: these modules have no
// DOM or Tauri coupling, so they run under a plain Node environment, no plugins.
export default defineConfig({
  test: {
    include: ['apps/desktop/web/{domain,store,terminal}/**/*.test.ts'],
    environment: 'node',
  },
});
