import { useEffect } from 'react';

import { usePaletteStore } from '../store';

// Global command-palette hotkeys: Cmd/Ctrl+K toggles the palette, Escape closes
// it. The query is cleared whenever the palette closes so it always opens fresh.
export function useCommandPalette() {
  const paletteOpen = usePaletteStore(s => s.paletteOpen);
  const setPaletteOpen = usePaletteStore(s => s.setPaletteOpen);
  const setPaletteQuery = usePaletteStore(s => s.setPaletteQuery);

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      const isPaletteShortcut =
        event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
      if (isPaletteShortcut) {
        event.preventDefault();
        setPaletteOpen(open => !open);
        return;
      }
      if (event.key === 'Escape' && paletteOpen) {
        event.preventDefault();
        setPaletteOpen(false);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) setPaletteQuery('');
  }, [paletteOpen, setPaletteQuery]);
}
