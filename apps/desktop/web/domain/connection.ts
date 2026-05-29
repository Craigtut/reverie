// Shared TypeScript types for the inter-agent connections feature. These
// mirror the Rust types in `packages/reverie-core/src/connection.rs` and
// `connection_service.rs`, kept hand-typed so the frontend has no codegen
// step. Add a test (or update format/test.ts) whenever the wire shape
// changes so a backend rename surfaces in CI.

import type { AgentKind } from './types';

export type ConnectionStatus = 'requested' | 'open' | 'closed' | 'denied';
export type ConnectionPolicy =
  | 'always_ask'
  | 'auto_allow_focus'
  | 'auto_allow_project'
  | 'auto_allow_workspace';

export type ConnectionInitiator = { kind: 'agent'; sessionId: string } | { kind: 'user' };

export type ConnectionClosedBy =
  | { kind: 'agent'; sessionId: string }
  | { kind: 'user' }
  | { kind: 'session_ended'; sessionId: string }
  | { kind: 'policy'; reason: string };

export interface PendingRequest {
  requestId: string;
  requestedAt: string;
  expiresAt: string;
}

export interface Connection {
  id: string;
  participantA: string;
  participantB: string;
  initiator: ConnectionInitiator;
  status: ConnectionStatus;
  reasonOpened: string;
  policyAtOpen: ConnectionPolicy;
  topic: string | null;
  createdAt: string;
  acceptedAt: string | null;
  closedAt: string | null;
  closedBy: ConnectionClosedBy | null;
  reasonClosed: string | null;
  pendingRequest: PendingRequest | null;
  sequence: number;
}

export interface ConnectionMessage {
  id: string;
  connectionId: string;
  fromSession: string;
  toSession: string;
  body: string;
  sentAt: string;
  deliveredAt: string | null;
  sequence: number;
}

export interface ConnectionRequestView {
  connection: Connection;
}

export interface BridgeInstallationStatus {
  mcpInstalled: boolean;
  hookInstalled: boolean;
  mismatchedPaths: boolean;
}

export interface BridgeStatusReport {
  cortex: BridgeInstallationStatus;
  codex: BridgeInstallationStatus;
  claude: BridgeInstallationStatus;
  reverieBridgePath: string;
  preturnHookPath: string;
}

export type BridgeCliKind = 'cortex' | 'codex' | 'claude';

export interface SessionAddress {
  agentKind: AgentKind;
  projectId: string | null;
  projectName: string | null;
  focusId: string;
  focusTitle: string;
  sessionTitle: string;
}

export const POLICY_LABELS: Record<ConnectionPolicy, { title: string; help: string }> = {
  always_ask: {
    title: 'Always ask before allowing',
    help: 'Every agent-initiated connection requests user accept first.',
  },
  auto_allow_focus: {
    title: 'Auto-allow within the same focus',
    help: 'Connections inside one focus open silently; cross-focus still asks.',
  },
  auto_allow_project: {
    title: 'Auto-allow within the same project',
    help: 'Connections inside one project open silently; cross-project still asks.',
  },
  auto_allow_workspace: {
    title: 'Auto-allow anywhere in the workspace',
    help: 'All connections open silently. Cross-project still requires explicit user action.',
  },
};

export const CLI_LABELS: Record<BridgeCliKind, { title: string; configPath: string }> = {
  cortex: { title: 'Cortex Code', configPath: '~/.cortex/mcp.json + ~/.cortex/hooks.json' },
  codex: { title: 'Codex CLI', configPath: '~/.codex/config.toml' },
  claude: { title: 'Claude Code', configPath: '~/.claude.json' },
};

/** AgentKind (workspace domain) ↔ BridgeCliKind (installer domain). */
export const AGENT_KIND_TO_BRIDGE_CLI: Record<AgentKind, BridgeCliKind> = {
  cortex_code: 'cortex',
  codex_cli: 'codex',
  claude_code: 'claude',
};
