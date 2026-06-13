import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app version, read from the root package.json at build time so the About
// footer always reflects the bundled build (package.json is the version source
// of truth that set-version.mjs keeps in sync across every manifest).
const appVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version as string;

export default defineConfig({
  root: 'apps/desktop/web',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
