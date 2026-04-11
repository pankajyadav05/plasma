import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import './styles/globals.css';

// Set platform data attribute synchronously BEFORE React mounts so CSS
// can pick it up on first paint (no flash of wrong-padding top bar).
// window.plasma is injected by the preload script — guard defensively
// in case a dev-server HMR reload got out of sync with the preload build.
if (window.plasma?.platform) {
  document.documentElement.dataset.platform = window.plasma.platform;
} else {
  // biome-ignore lint/suspicious/noConsole: startup diagnostics
  console.error(
    '[plasma] window.plasma is not available — preload did not load. ' +
      'Hard-restart the dev server (Ctrl+C, then `pnpm dev`).',
  );
  // Reasonable fallback so React still renders something useful
  document.documentElement.dataset.platform = navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'win32';
}

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
