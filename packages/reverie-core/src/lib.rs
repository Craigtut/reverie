//! Core domain and runtime boundaries for Reverie.
//!
//! This crate intentionally contains no Tauri UI code. The goal is to keep
//! Reverie's durable product model, agent adapters, and terminal contracts
//! testable and independent from whichever terminal renderer wins the v1 spike.

pub mod activity;
pub mod activity_reconciler;
pub mod activity_source;
pub mod agents;
pub mod bookmark;
pub mod bridge_protocol;
pub mod bridge_server;
pub mod codex_hooks;
pub mod codex_rollout;
pub mod completion;
pub mod connection;
pub mod connection_repository;
pub mod connection_service;
pub mod cortex_state;
pub mod domain;
pub mod git_status;
pub mod hook_config;
pub mod hook_server;
pub mod pty;
pub mod repository;
pub mod session_log;
pub mod terminal;
mod time;
pub mod workspace_service;

pub use activity::{
    ActiveTool, ActivityError, ActivityEvent, ActivityEventKind, ActivityState, ActivityStatus,
    ActivityTurn, ErrorCategory, ExitReason, FinalExit, PermissionRequest, PermissionResolution,
    PermissionResolvedPayload, StatusChangedPayload, ToolCallEndedPayload, ToolCallStartedPayload,
    TurnEndedPayload, TurnOutcome, TurnStartedPayload, TurnStatus, TurnTrigger, parse_event,
    parse_events, parse_state,
};
pub use activity_source::{ActivitySourceKind, ActivityUpdate, Fidelity, SessionKey};
pub use bookmark::{BookmarkProvider, NoopBookmarkProvider};
pub use agents::{
    AdapterDetection, AgentAdapter, CommandSpec, CortexAdapter, CortexSessionDiscovery,
    CortexSessionMetadata, DiscoveryContext, LaunchContext,
};
pub use bridge_server::{
    BridgeSession, Clock, FixedClock, HandshakeOutcome, PROTOCOL_VERSION, SystemClock,
    dispatch_request, handle_handshake, serve_connection,
};
pub use codex_rollout::CodexLogSource;
pub use completion::{CompletionRequest, complete_structured, string_object_schema};
pub use connection::{
    Connection, ConnectionClosedBy, ConnectionId, ConnectionInitiator, ConnectionMessage,
    ConnectionPolicy, ConnectionStatus, ConnectionTransitionError, MessageId, PendingRequest,
    RequestId,
};
pub use connection_repository::{ConnectionRepository, InMemoryConnectionRepository};
pub use connection_service::{
    ConnectionCaller, ConnectionEvent, ConnectionObserver, ConnectionService, DecisionBy,
    PeerScope, PeerView, PolicyDecision, RegisteredSession, RequestOutcome, SessionAddress,
    WaitOutcome,
};
pub use cortex_state::CortexStateSource;
pub use domain::{
    AgentKind, Focus, NativeSessionRef, Project, Session, SessionStateTimeline, SessionStatus,
    Workspace, WorkspaceSnapshot,
};
pub use git_status::{CommitSummary, DirtyStat, RepoStatus, compute_repo_status};
pub use hook_config::{WrittenHookConfig, hook_url, write_claude_settings};
pub use hook_server::{HookServerControl, HookServerHandle, HookSource, start_hook_server};
pub use repository::{
    InMemoryWorkspaceRepository, PersistenceError, RepoResult, WorkspaceRepository,
};
pub use session_log::{
    CompositeLogSource, LogReadMode, SessionLogControl, SessionLogFold, SessionLogSource,
    SessionLogWatcher, start_session_log_watcher,
};
pub use terminal::{
    TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors, TerminalCursor,
    TerminalCursorStyle, TerminalDirtyState, TerminalFrame, TerminalId, TerminalPosition,
    TerminalRow, TerminalSpawnSpec, TerminalUnderline,
};
pub use workspace_service::WorkspaceService;
