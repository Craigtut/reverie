//! Core domain and runtime boundaries for Reverie.
//!
//! This crate intentionally contains no Tauri UI code. The goal is to keep
//! Reverie's durable product model, agent adapters, and terminal contracts
//! testable and independent from whichever terminal renderer wins the v1 spike.

pub mod activity;
pub mod activity_watcher;
pub mod agents;
pub mod bridge_protocol;
pub mod bridge_server;
pub mod connection;
pub mod connection_repository;
pub mod connection_service;
pub mod domain;
pub mod hook_config;
pub mod hook_server;
pub mod pty;
pub mod repository;
pub mod terminal;
pub mod transcript;
pub mod workspace_service;

pub use activity::{
    ActiveTool, ActivityError, ActivityEvent, ActivityEventKind, ActivityState, ActivityStatus,
    ActivityTurn, ErrorCategory, ExitReason, FinalExit, PermissionRequest, PermissionResolution,
    PermissionResolvedPayload, StatusChangedPayload, ToolCallEndedPayload, ToolCallStartedPayload,
    TurnEndedPayload, TurnOutcome, TurnStartedPayload, TurnStatus, TurnTrigger, parse_event,
    parse_events, parse_state,
};
pub use activity_watcher::{CortexActivityStream, CortexActivityUpdate, watch_cortex_activity};
pub use agents::{
    AdapterDetection, AgentAdapter, CommandSpec, CortexAdapter, CortexSessionDiscovery,
    CortexSessionMetadata, DiscoveryContext, LaunchContext,
};
pub use bridge_server::{
    BridgeSession, Clock, FixedClock, HandshakeOutcome, PROTOCOL_VERSION, SystemClock,
    dispatch_request, handle_handshake, serve_connection,
};
pub use connection::{
    Connection, ConnectionClosedBy, ConnectionId, ConnectionInitiator, ConnectionMessage,
    ConnectionPolicy, ConnectionStatus, ConnectionTransitionError, MessageId, PendingRequest,
    RequestId,
};
pub use connection_repository::{ConnectionRepository, InMemoryConnectionRepository};
pub use connection_service::{
    ConnectionCaller, ConnectionService, DecisionBy, PeerScope, PeerView, PolicyDecision,
    RegisteredSession, RequestOutcome, SessionAddress, WaitOutcome,
};
pub use domain::{
    AgentKind, Focus, NativeSessionRef, Project, Session, SessionStatus, Workspace,
    WorkspaceSnapshot,
};
pub use hook_config::{WrittenHookConfig, hook_url, write_claude_settings, write_codex_config};
pub use hook_server::{
    HookActivityUpdate, HookServerControl, HookServerHandle, HookSource, start_hook_server,
};
pub use repository::{
    InMemoryWorkspaceRepository, PersistenceError, RepoResult, WorkspaceRepository,
};
pub use terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalEvent, TerminalFrame, TerminalFramePatch,
    TerminalId, TerminalPosition, TerminalRow, TerminalSnapshot, TerminalSpawnSpec,
    TerminalUnderline,
};
pub use transcript::TranscriptStore;
pub use workspace_service::WorkspaceService;
