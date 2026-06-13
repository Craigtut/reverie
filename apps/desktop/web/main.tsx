import React from 'react';
import { createRoot } from 'react-dom/client';

import './styled-system/styles.css';
import './main.css';
import { App } from './App';

// Suppress the WebView's native right-click menu in production. WKWebView's
// built-in context menu exposes "Reload" (and friends), which has no place in a
// shipped app. We only gate on PROD: the dev channel always runs the Vite dev
// server, where that menu's reload is occasionally useful. Editable fields keep
// their native Cut/Copy/Paste menu; everywhere else (including the terminal,
// which renders its own React menu) the native menu is suppressed. This only
// touches the menu, not the reload keyboard shortcut.
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', event => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
  });
}

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Reverie root element is missing');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
