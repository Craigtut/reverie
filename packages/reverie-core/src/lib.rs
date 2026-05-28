//! Core domain and runtime boundaries for Reverie.
//!
//! This crate intentionally contains no Tauri UI code. The goal is to keep
//! Reverie's durable product model, agent adapters, and terminal contracts
//! testable and independent from whichever terminal renderer wins the v1 spike.

pub mod activity;
pub mod agents;
pub mod domain;
pub mod pty;
pub mod terminal;

pub use activity::{
    ActiveTool, ActivityError, ActivityEvent, ActivityEventKind, ActivityState, ActivityStatus,
    ActivityTurn, ErrorCategory, ExitReason, FinalExit, PermissionRequest, PermissionResolution,
    PermissionResolvedPayload, StatusChangedPayload, ToolCallEndedPayload,
    ToolCallStartedPayload, ToolCallOutcome, TurnEndedPayload, TurnOutcome, TurnStartedPayload,
    TurnStatus, TurnTrigger, parse_event, parse_events, parse_state,
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
