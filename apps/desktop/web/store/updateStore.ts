import { create } from 'zustand';

// Auto-update state for the shell. The live `Update` handle (with its
// download/install methods) is non-serializable and lives in
// services/updateApi.ts; this store holds only the serializable status the UI
// renders: where we are in the check -> download -> ready flow, the running and
// available versions, and the two user preferences (auto-check, auto-download).
//
// Preferences persist to localStorage rather than the workspace database: they
// are a per-install UI choice, not workspace content, so they stay out of the
// synced/seeded shell snapshot and need no Rust schema change.

export type UpdatePhase =
  | 'idle' // not yet checked, or updates disabled (dev channel / browser)
  | 'checking'
  | 'uptodate'
  | 'available' // a newer version exists but is not downloaded yet
  | 'downloading'
  | 'ready' // downloaded and staged; a relaunch applies it
  | 'error';

const AUTO_CHECK_KEY = 'reverie.update.autoCheck';
const AUTO_DOWNLOAD_KEY = 'reverie.update.autoDownload';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // Private mode or a denied store: the preference just won't persist.
  }
}

interface UpdateState {
  // Whether this build can update at all (production desktop channel only).
  enabled: boolean;
  currentVersion: string | null;
  phase: UpdatePhase;
  availableVersion: string | null;
  notes: string | null;
  error: string | null;
  lastCheckedAt: number | null;
  // 0..1 while downloading, else null.
  downloadProgress: number | null;
  autoCheck: boolean;
  autoDownload: boolean;

  setEnvironment: (input: { enabled: boolean; currentVersion: string }) => void;
  setPhase: (phase: UpdatePhase) => void;
  setChecking: () => void;
  setUpToDate: () => void;
  setFound: (input: { version: string; notes: string | null }) => void;
  setDownloading: () => void;
  setDownloadProgress: (fraction: number) => void;
  setReady: () => void;
  setError: (message: string) => void;
  setAutoCheck: (value: boolean) => void;
  setAutoDownload: (value: boolean) => void;
}

export const useUpdateStore = create<UpdateState>(set => ({
  enabled: false,
  currentVersion: null,
  phase: 'idle',
  availableVersion: null,
  notes: null,
  error: null,
  lastCheckedAt: null,
  downloadProgress: null,
  autoCheck: readBool(AUTO_CHECK_KEY, true),
  autoDownload: readBool(AUTO_DOWNLOAD_KEY, true),

  setEnvironment: ({ enabled, currentVersion }) => set({ enabled, currentVersion }),
  setPhase: phase => set({ phase }),
  setChecking: () => set({ phase: 'checking', error: null }),
  setUpToDate: () =>
    set({
      phase: 'uptodate',
      availableVersion: null,
      notes: null,
      error: null,
      downloadProgress: null,
      lastCheckedAt: Date.now(),
    }),
  setFound: ({ version, notes }) =>
    set({
      phase: 'available',
      availableVersion: version,
      notes,
      error: null,
      downloadProgress: null,
      lastCheckedAt: Date.now(),
    }),
  setDownloading: () => set({ phase: 'downloading', downloadProgress: 0, error: null }),
  setDownloadProgress: fraction =>
    set({ phase: 'downloading', downloadProgress: Math.max(0, Math.min(1, fraction)) }),
  setReady: () => set({ phase: 'ready', downloadProgress: 1 }),
  setError: message => set({ phase: 'error', error: message }),
  setAutoCheck: value => {
    writeBool(AUTO_CHECK_KEY, value);
    set({ autoCheck: value });
  },
  setAutoDownload: value => {
    writeBool(AUTO_DOWNLOAD_KEY, value);
    set({ autoDownload: value });
  },
}));
