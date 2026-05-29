import { defineConfig } from 'vitest/config';

// Isolated config for the pure domain-layer unit tests. Intentionally does not
// import or extend vite.config.ts: the domain modules have no DOM or Tauri
// coupling, so they run under a plain Node environment with no plugins.
export default defineConfig({
  test: {
    include: ['apps/desktop/web/domain/**/*.test.ts'],
    environment: 'node',
  },
});
