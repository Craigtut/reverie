import React from 'react';
import { createRoot } from 'react-dom/client';

import './styled-system/styles.css';
import './main.css';
import { App } from './App';

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Reverie root element is missing');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
