// Lets Zustand actions accept the same value-or-updater form as React's
// useState setter, so migrating `const [x, setX] = useState()` to a store is a
// drop-in: `setX(next)` and `setX(prev => ...)` both keep working.

export type SetStateAction<T> = T | ((prev: T) => T);

export function resolveSetStateAction<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === 'function' ? (action as (prev: T) => T)(prev) : action;
}
