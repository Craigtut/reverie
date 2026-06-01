import { WorkspaceShell } from './WorkspaceShell';
import { StateCellDemo } from './components/glyphs';
import { TauriTerminalStressProof } from './TauriTerminalStressProof';
import { TerminalBridgeDebug } from './TerminalBridgeDebug';

// App is the application entry point. It stays deliberately thin: it mounts the
// workspace shell and is the single place top-level concerns (providers, error
// boundaries, future theming context) would wrap the tree. Application logic
// lives in WorkspaceShell and the hooks it composes, never here.
export function App() {
  // Dev-only: `?statecell=1` renders the state-cell tuning surface in isolation.
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('statecell') === '1'
  ) {
    return <StateCellDemo />;
  }
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('tauriTerminalStress') === '1'
  ) {
    return <TauriTerminalStressProof />;
  }
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('terminalBridgeDebug') === '1'
  ) {
    return <TerminalBridgeDebug />;
  }
  return <WorkspaceShell />;
}
