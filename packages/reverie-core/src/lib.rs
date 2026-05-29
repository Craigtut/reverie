//! Core domain and runtime boundaries for Reverie.
//!
//! This crate intentionally contains no Tauri UI code. The goal is to keep
//! Reverie's durable product model, agent adapters, and terminal contracts
//! testable and independent from whichever terminal renderer wins the v1 spike.

pub mod activity;
pub mod activity_watcher;
pub mod agents;
pub mod connection;
pub mod domain;
pub mod hook_config;
pub mod hook_server;
pub mod pty;
pub mod terminal;

pub use activity::{
    ActiveTool, ActivityError, ActivityEvent, ActivityEventKind, ActivityState, ActivityStatus,
    ActivityTurn, ErrorCategory, ExitReason, FinalExit, PermissionRequest, PermissionResolution,
    PermissionResolvedPayload, StatusChangedPayload, ToolCallEndedPayload, ToolCallStartedPayload,
    TurnEndedPayload, TurnOutcome, TurnStartedPayload, TurnStatus, TurnTrigger, parse_event,
    parse_events, parse_state,
};
pub use activity_watcher::{CortexActivityStream, CortexActivityUpdate, watch_cortex_activity};
pub use connection::{
    Connection, ConnectionClosedBy, ConnectionId, ConnectionInitiator, ConnectionMessage,
    ConnectionPolicy, ConnectionStatus, ConnectionTransitionError, MessageId, PendingRequest,
    RequestId,
};
pub use hook_config::{WrittenHookConfig, hook_url, write_claude_settings, write_codex_config};
pub use hook_server::{
    HookActivityUpdate, HookServerControl, HookServerHandle, HookSource, start_hook_server,
};
pub use agents::{
    AdapterDetection, AgentAdapter, CommandSpec, CortexAdapter, CortexSessionDiscovery,
    CortexSessionMetadata, LaunchContext,
};
pub use domain::{
    AgentKind, Focus, NativeSessionRef, Project, Session, SessionStatus, WorkspaceSettings,
};
pub use terminal::{
    TerminalBackend, TerminalCell, TerminalCellStyle, TerminalColor, TerminalColors,
    TerminalCursor, TerminalCursorStyle, TerminalDirtyState, TerminalEvent, TerminalFrame,
    TerminalFramePatch, TerminalId, TerminalPosition, TerminalRow, TerminalSnapshot,
    TerminalSpawnSpec, TerminalUnderline,
};
