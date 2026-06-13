import { useEffect, useMemo } from 'react';

import {
  useAgentClis,
  useAppFocus,
  useAppQuit,
  useAutoUpdate,
  useCommandPalette,
  useCreationForm,
  useGitStatus,
  useNavPersistence,
  useSessionActivity,
  useSessionViewed,
  useSessionTitle,
  useShellNavigation,
  useTerminalSession,
  useWorkspaceModel,
  useWorkspaceMutations,
} from './hooks';
import { useUiStore } from './store';
import { AppLayout } from './components/layout';
import { WorkspaceLoadError } from './components/onboarding';
import { maybeRunHarnessSmokeTest } from './harnessSmoke';

// The workspace shell: the running application. It composes the read model
// (useWorkspaceModel), the imperative terminal island (useTerminalSession), and
// the command layers (navigation, creation, mutations), wires the ambient
// effect hooks, and hands the five resulting objects to AppLayout to render.
// It holds no business logic and no markup of its own: read model + command
// hooks here, layout there. App mounts this; nothing above it holds app logic.
export function WorkspaceShell() {
  const writeLog = useUiStore(s => s.appendLog);
  const setBusy = useUiStore(s => s.setBusy);
  const workspaceLoadFailed = useUiStore(s => s.workspaceLoadFailed);
  const isTauriRuntime = useMemo(
    () =>
      Boolean(
        window.__TAURI_INTERNALS__ || (window.__TAURI__ && !window.__REVERIE_BROWSER_FIXTURE__),
      ),
    [],
  );

  // Hydrate (and then persist) navigation from the saved view before the read
  // model runs, so it never seeds a default selection over a restored one.
  useNavPersistence();
  const model = useWorkspaceModel();
  const terminal = useTerminalSession({
    selectedSession: model.selectedSession,
    writeLog,
    loadWorkspaceShell: model.loadWorkspaceShell,
    setBusy,
    isTauriRuntime,
  });
  const nav = useShellNavigation({ model, terminal });
  const creation = useCreationForm({ model, terminal });
  const mutations = useWorkspaceMutations({
    model,
    terminal,
    selectSessionTab: nav.selectSessionTab,
    openFocus: nav.openFocus,
  });

  useCommandPalette();
  useAppQuit(writeLog);
  useAutoUpdate();
  useSessionActivity(writeLog, model.loadWorkspaceShell);
  useGitStatus();
  useSessionViewed();
  useSessionTitle(writeLog);
  useAgentClis(
    creation.newSessionAgentKind,
    creation.setNewSessionAgentKind,
    model.shell.workspace.defaultAgentKind,
    mutations.setWorkspaceDefaultAgentKind,
    writeLog,
  );
  useAppFocus();
  useEffect(() => {
    maybeRunHarnessSmokeTest();
  }, []);

  return (
    <>
      <AppLayout
        model={model}
        nav={nav}
        creation={creation}
        mutations={mutations}
        terminal={terminal}
      />
      {workspaceLoadFailed ? <WorkspaceLoadError onRetry={model.retryWorkspaceLoad} /> : null}
    </>
  );
}
