import { create } from 'zustand';

import { resolveSetStateAction, type SetStateAction } from './setter';

// Command palette open state + query text.

interface PaletteState {
  paletteOpen: boolean;
  paletteQuery: string;
  setPaletteOpen: (action: SetStateAction<boolean>) => void;
  setPaletteQuery: (action: SetStateAction<string>) => void;
}

export const usePaletteStore = create<PaletteState>(set => ({
  paletteOpen: false,
  paletteQuery: '',
  setPaletteOpen: action =>
    set(s => ({ paletteOpen: resolveSetStateAction(action, s.paletteOpen) })),
  setPaletteQuery: action =>
    set(s => ({ paletteQuery: resolveSetStateAction(action, s.paletteQuery) })),
}));
