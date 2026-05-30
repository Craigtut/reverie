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
// We save the chosen data slice on the old instance's `dispose` and restore it
// onto the freshly created store, so the workspace stays on screen across HMR.
// Actions are deliberately not preserved: the new module recreates them bound to
// the new store, and restoring stale actions would mutate the discarded one. A
// full page reload or process restart wipes `import.meta.hot.data`, so the normal
// bootstrap load still runs from a clean slate in those cases. No-op in
// production builds, where `import.meta.hot` is undefined.
export function preserveStoreAcrossHmr<T extends object>(
  store: UseBoundStore<StoreApi<T>>,
  hot: ImportMeta['hot'],
  pickData: (state: T) => Partial<T>,
): void {
  if (!hot) return;
  const saved = hot.data[HMR_DATA_KEY] as Partial<T> | undefined;
  if (saved) store.setState(saved);
  hot.dispose(data => {
    data[HMR_DATA_KEY] = pickData(store.getState());
  });
}
