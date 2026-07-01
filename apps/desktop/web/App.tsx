import { WorkspaceShell } from './WorkspaceShell';
import { DispatchOverlay } from './components/dispatch';
import { StateCellDemo } from './components/glyphs';
import { TauriTerminalStressProof } from './TauriTerminalStressProof';
import { TerminalBridgeDebug } from './TerminalBridgeDebug';
import { CrtTuningPanel } from './CrtTuningPanel';
import { CrtLoadingHarness } from './crtLoading';

// App is the application entry point. It stays deliberately thin: it mounts the
// workspace shell and is the single place top-level concerns (providers, error
// boundaries, future theming context) would wrap the tree. Application logic
// lives in WorkspaceShell and the hooks it composes, never here.
export function App() {
  // The dispatch capture popup runs in its own transparent window, loaded as
  // `index.html?dispatch=1`. It shares this bundle (stores, services, theme,
  // Typography) but renders only the overlay, never the workspace shell.
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('dispatch') === '1'
  ) {
    return <DispatchOverlay />;
  }
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
  // Dev-only: `?crtTuning=1` renders the CRT post-process tuning harness.
  if (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('crtTuning') === '1'
  ) {
    return <CrtTuningPanel />;
  }
  // Dev-only: `?crtLoading=boot|resume` previews the CRT loading sequences.
  if (typeof window !== 'undefined') {
    const loading = new URLSearchParams(window.location.search).get('crtLoading');
    if (loading === 'boot' || loading === 'resume') {
      return <CrtLoadingHarness variant={loading} />;
    }
  }
  return <WorkspaceShell />;
}
