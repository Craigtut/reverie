import { WorkspaceShell } from './WorkspaceShell';

// App is the application entry point. It stays deliberately thin: it mounts the
// workspace shell and is the single place top-level concerns (providers, error
// boundaries, future theming context) would wrap the tree. Application logic
// lives in WorkspaceShell and the hooks it composes, never here.
export function App() {
  return <WorkspaceShell />;
}
