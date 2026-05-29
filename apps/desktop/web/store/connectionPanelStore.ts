import { create } from 'zustand';

// Which session's connection panel is currently open. `null` means closed.
// Lifted to a global store so the chip on a dashboard card (or session pane)
// can open the panel without prop-drilling through the layout tree.

interface ConnectionPanelState {
  activeSessionId: string | null;
  openForSession: (sessionId: string) => void;
  closePanel: () => void;
}

export const useConnectionPanelStore = create<ConnectionPanelState>(set => ({
  activeSessionId: null,
  openForSession: sessionId => set({ activeSessionId: sessionId }),
  closePanel: () => set({ activeSessionId: null }),
}));
