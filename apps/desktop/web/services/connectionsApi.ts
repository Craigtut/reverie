// Typed wrappers over the inter-agent connection Tauri commands. Mirrors
// the surface defined in `apps/desktop/src-tauri/src/connection_commands.rs`.

import { invoke, listen } from './runtime';
import type {
  BridgeStatusReport,
  Connection,
  ConnectionMessage,
  ConnectionPolicy,
  ConnectionRequestView,
} from '../domain';

// -- Bridge installation --------------------------------------------------

export function fetchBridgeInstallationStatus() {
  return invoke<BridgeStatusReport>('bridge_installation_status');
}

export function installCortexBridge() {
  return invoke<BridgeStatusReport>('install_cortex_bridge_command');
}

export function uninstallCortexBridge() {
  return invoke<BridgeStatusReport>('uninstall_cortex_bridge_command');
}

export function installCodexBridge() {
  return invoke<BridgeStatusReport>('install_codex_bridge_command');
}

export function uninstallCodexBridge() {
  return invoke<BridgeStatusReport>('uninstall_codex_bridge_command');
}

export function installClaudeBridge() {
  return invoke<BridgeStatusReport>('install_claude_bridge_command');
}

export function uninstallClaudeBridge() {
  return invoke<BridgeStatusReport>('uninstall_claude_bridge_command');
}

// -- Connection request flow ---------------------------------------------

export function listPendingConnectionRequests() {
  return invoke<ConnectionRequestView[]>('list_pending_connection_requests');
}

export function acceptConnectionRequest(requestId: string) {
  return invoke<Connection>('accept_connection_request', { requestId });
}

export function denyConnectionRequest(requestId: string, reason: string | null = null) {
  return invoke<void>('deny_connection_request', { requestId, reason });
}

// -- Connection lifecycle ------------------------------------------------

export function listSessionConnections(sessionId: string) {
  return invoke<Connection[]>('list_session_connections', { sessionId });
}

export function closeConnection(connectionId: string, reason: string | null = null) {
  return invoke<void>('close_connection_command', { connectionId, reason });
}

export function userOpenConnection(sessionA: string, sessionB: string, reason: string) {
  return invoke<Connection>('user_open_connection', {
    sessionA,
    sessionB,
    reason,
  });
}

export function fetchConnectionTranscript(connectionId: string) {
  return invoke<ConnectionMessage[]>('connection_transcript', { connectionId });
}

// -- Policy --------------------------------------------------------------

export function fetchConnectionPolicy() {
  return invoke<ConnectionPolicy>('connection_policy');
}

export function setConnectionPolicy(policy: ConnectionPolicy) {
  return invoke<ConnectionPolicy>('set_connection_policy', { policy });
}

export function fetchFocusPolicyOverride(focusId: string) {
  return invoke<ConnectionPolicy | null>('focus_policy_override', { focusId });
}

export function setFocusPolicyOverride(focusId: string, policy: ConnectionPolicy | null) {
  return invoke<ConnectionPolicy | null>('set_focus_policy_override', {
    focusId,
    policy,
  });
}

export function pairRecentlyDenied(sourceSessionId: string, targetSessionId: string) {
  return invoke<boolean>('pair_recently_denied', {
    sourceSessionId,
    targetSessionId,
  });
}

export function blockSessionPair(
  sourceSessionId: string,
  targetSessionId: string,
  durationSecs: number,
) {
  return invoke<void>('block_session_pair', {
    sourceSessionId,
    targetSessionId,
    durationSecs,
  });
}

export function clearSessionPairBlock(sourceSessionId: string, targetSessionId: string) {
  return invoke<void>('clear_session_pair_block', {
    sourceSessionId,
    targetSessionId,
  });
}

// -- Event subscriptions -------------------------------------------------

export function onConnectionRequestChange(handler: () => void) {
  return listen<unknown>('connection_request_changed', () => handler());
}

export function onConnectionStateChange(handler: (event: { connectionId: string }) => void) {
  return listen<{ connectionId: string }>('connection_state_changed', event =>
    handler(event.payload),
  );
}
