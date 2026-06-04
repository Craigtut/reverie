import type { StoreApi, UseBoundStore } from 'zustand';

// Key under which a store stashes its data on `import.meta.hot.data`. The `data`
// object is the one thing Vite persists across a module's HMR re-instantiation.
const HMR_DATA_KEY = 'zustandPreservedState';

// Dev-only: keep a zustand store's *data* alive across Vite HMR.
//
// Each store is created once at module scope with `create(...)`. When Vite hot-
// reloads a store module (because it, or anything in its import graph such as the
// `domain` barrel, was edited), it re-executes the module, so `create(...)` runs
// again and the store snaps back to its empty initial state. React Fast Refresh
// keeps the mounted component tree, so a mount-once load effect (the
// `workspace_shell` fetch in useWorkspaceModel) never re-fires. The result is a
// blank UI that only a full app restart recovers, even though the backend data is
// untouched. This is exactly the "all my data disappeared on hot reload" symptom.
//
// We mirror the chosen data slice onto `import.meta.hot.data` and restore it onto
// the freshly created store, so the workspace stays on screen across HMR. Actions
// are deliberately not preserved: the new module recreates them bound to the new
// store, and restoring stale actions would mutate the discarded one. A full page
// reload or process restart wipes `import.meta.hot.data`, so the normal bootstrap
// load still runs from a clean slate in those cases. No-op in production builds,
// where `import.meta.hot` is undefined.
//
// We keep `hot.data` current on every state change rather than only writing it in
// a `dispose` callback. That distinction is load-bearing: Vite preserves `hot.data`
// across a module's re-evaluation, but it only fires `dispose` for the module that
// is the accepted HMR boundary, not for a module that is merely re-run because one
// of its *dependencies* was edited. Editing the `domain` barrel (or anything else
// the stores import) is exactly that second case: each store module re-runs
// `create()` and resets to the empty fallback, yet its `dispose` never fires, so a
// dispose-only save left `hot.data` empty and the new store had nothing to restore
// (the workspace blanked to the empty state on every edit). Mirroring eagerly means
// `hot.data` is always up to date, so the new instance can restore no matter why it
// was re-evaluated.
export function preserveStoreAcrossHmr<T extends object>(
  store: UseBoundStore<StoreApi<T>>,
  hot: ImportMeta['hot'],
  pickData: (state: T) => Partial<T>,
): void {
  if (!hot) return;
  const saved = hot.data[HMR_DATA_KEY] as Partial<T> | undefined;
  if (saved) store.setState(saved);
  hot.data[HMR_DATA_KEY] = pickData(store.getState());
  store.subscribe(state => {
    hot.data[HMR_DATA_KEY] = pickData(state);
  });
}
