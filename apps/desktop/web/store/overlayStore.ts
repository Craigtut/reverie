import { create } from 'zustand';

// Transient shell overlays that any hook can raise without prop-threading: a
// single confirmation sheet (for deliberate, hard-to-undo actions like removing
// a focus or project) and a queue of toasts (for quiet, reversible actions like
// archiving a session, which carry an Undo). Kept separate from the durable
// stores because these are ephemeral and self-dismissing.

let nextId = 1;
function makeId() {
  return nextId++;
}

export interface ConfirmRequest {
  id: number;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  // Tints the confirm button as a destructive action.
  danger: boolean;
  onConfirm: () => void;
}

export interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs: number;
}

interface OverlayState {
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  requestConfirm: (
    req: Omit<ConfirmRequest, 'id' | 'cancelLabel' | 'danger'> &
      Partial<Pick<ConfirmRequest, 'cancelLabel' | 'danger'>>,
  ) => void;
  dismissConfirm: () => void;
  pushToast: (toast: Omit<Toast, 'id' | 'durationMs'> & Partial<Pick<Toast, 'durationMs'>>) => void;
  dismissToast: (id: number) => void;
}

export const useOverlayStore = create<OverlayState>(set => ({
  confirm: null,
  toasts: [],
  requestConfirm: req =>
    set({
      confirm: {
        id: makeId(),
        cancelLabel: 'Cancel',
        danger: false,
        ...req,
      },
    }),
  dismissConfirm: () => set({ confirm: null }),
  pushToast: toast =>
    set(s => ({
      // Keep the stack short: newest first, cap at three so a burst of closes
      // does not pile up.
      toasts: [{ id: makeId(), durationMs: 6000, ...toast }, ...s.toasts].slice(0, 3),
    })),
  dismissToast: id => set(s => ({ toasts: s.toasts.filter(toast => toast.id !== id) })),
}));
