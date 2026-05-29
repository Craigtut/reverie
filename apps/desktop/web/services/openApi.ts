import { invoke } from './runtime';

// Open an external URL via the desktop opener (real Tauri) or the browser
// fixture (new tab). The Rust `open_url` command allowlists http/https.
export function openExternalUrl(url: string): Promise<void> {
  return invoke('open_url', { url });
}
