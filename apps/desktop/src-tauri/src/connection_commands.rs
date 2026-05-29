//! Tauri commands for the inter-agent connection feature.
//!
//! The React shell uses these to:
//!
//! - Inspect and toggle bridge installation per CLI.
//! - Drive the accept/deny flow on outstanding connection requests.
//! - List, send, receive, and close connections from a session's POV.
//! - Read/write the global connection policy.
//!
//! Every command returns plain `serde`-friendly DTOs; nothing here owns
//! long-running work. The bridge listener thread (`bridge::start_bridge`)
//! handles the heavy lifting.

#![cfg(unix)]

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use reverie_core::connection::{Connection, ConnectionMessage, ConnectionPolicy, RequestId};
use reverie_core::connection_service::DecisionBy;
use reverie_core::domain::{AgentKind, SessionId};
use reverie_core::{ConnectionCaller, ConnectionId, ConnectionService, WorkspaceService};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::bridge::SystemClockIso;
use crate::bridge_installer::{
    BridgeBinaries, BridgeInstallationStatus, inspect_claude_status, inspect_codex_status,
    inspect_cortex_status, install_claude_bridge, install_codex_bridge, install_cortex_bridge,
    uninstall_claude_bridge, uninstall_codex_bridge, uninstall_cortex_bridge,
};

const CONNECTION_REQUEST_EVENT: &str = "connection_request_changed";
const CONNECTION_STATE_EVENT: &str = "connection_state_changed";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStatusReport {
    pub(crate) cortex: BridgeInstallationStatus,
    pub(crate) codex: BridgeInstallationStatus,
    pub(crate) claude: BridgeInstallationStatus,
    pub(crate) reverie_bridge_path: String,
    pub(crate) preturn_hook_path: String,
}

/// Inspect bridge installation status across every supported CLI.
#[tauri::command]
pub(crate) fn bridge_installation_status(app: AppHandle) -> Result<BridgeStatusReport, String> {
    let binaries = resolve_bridge_binaries(&app).map_err(|err| err.to_string())?;
    let cortex = inspect_cortex_status(&binaries).map_err(|err| err.to_string())?;
    let codex = inspect_codex_status(&binaries).map_err(|err| err.to_string())?;
    let claude = inspect_claude_status(&binaries).map_err(|err| err.to_string())?;
    Ok(BridgeStatusReport {
        cortex,
        codex,
        claude,
        reverie_bridge_path: binaries.reverie_bridge.to_string_lossy().into_owned(),
        preturn_hook_path: binaries.preturn_hook.to_string_lossy().into_owned(),
    })
}

/// Guard a bridge install on the CLI being enabled. A disabled CLI must never
/// have Reverie-managed entries written into its config, so the install is
/// refused rather than silently skipped.
fn ensure_cli_enabled(service: &WorkspaceService, kind: AgentKind) -> Result<(), String> {
    match service.is_agent_cli_enabled(kind) {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!(
            "{} is switched off; enable it in Settings before installing its bridge.",
            kind.as_str()
        )),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub(crate) fn install_cortex_bridge_command(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
) -> Result<BridgeStatusReport, String> {
    ensure_cli_enabled(&service, AgentKind::CortexCode)?;
    let binaries = resolve_bridge_binaries(&app).map_err(|err| err.to_string())?;
    install_cortex_bridge(&binaries).map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[tauri::command]
pub(crate) fn uninstall_cortex_bridge_command(
    app: AppHandle,
) -> Result<BridgeStatusReport, String> {
    uninstall_cortex_bridge().map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[tauri::command]
pub(crate) fn install_codex_bridge_command(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
) -> Result<BridgeStatusReport, String> {
    ensure_cli_enabled(&service, AgentKind::CodexCli)?;
    let binaries = resolve_bridge_binaries(&app).map_err(|err| err.to_string())?;
    install_codex_bridge(&binaries).map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[tauri::command]
pub(crate) fn uninstall_codex_bridge_command(app: AppHandle) -> Result<BridgeStatusReport, String> {
    uninstall_codex_bridge().map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[tauri::command]
pub(crate) fn install_claude_bridge_command(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
) -> Result<BridgeStatusReport, String> {
    ensure_cli_enabled(&service, AgentKind::ClaudeCode)?;
    let binaries = resolve_bridge_binaries(&app).map_err(|err| err.to_string())?;
    install_claude_bridge(&binaries).map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[tauri::command]
pub(crate) fn uninstall_claude_bridge_command(
    app: AppHandle,
) -> Result<BridgeStatusReport, String> {
    uninstall_claude_bridge().map_err(|err| err.to_string())?;
    bridge_installation_status(app)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionRequestView {
    pub(crate) connection: Connection,
}

#[tauri::command]
pub(crate) fn list_pending_connection_requests(
    service: State<'_, Arc<ConnectionService>>,
) -> Result<Vec<ConnectionRequestView>, String> {
    let requests = service
        .list_pending_requests()
        .map_err(|err| err.to_string())?;
    Ok(requests
        .into_iter()
        .map(|connection| ConnectionRequestView { connection })
        .collect())
}

#[tauri::command]
pub(crate) fn accept_connection_request(
    app: AppHandle,
    service: State<'_, Arc<ConnectionService>>,
    request_id: RequestId,
) -> Result<Connection, String> {
    let now = SystemClockIso::now();
    let id = service
        .accept_request(request_id, DecisionBy::User, now.clone())
        .map_err(|err| err.to_string())?;
    emit_state_change(&app, id);
    emit_request_change(&app);
    let connection = service
        .get_connection(id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "connection disappeared after accept".to_owned())?;
    Ok(connection)
}

#[tauri::command]
pub(crate) fn deny_connection_request(
    app: AppHandle,
    service: State<'_, Arc<ConnectionService>>,
    request_id: RequestId,
    reason: Option<String>,
) -> Result<(), String> {
    let now = SystemClockIso::now();
    service
        .deny_request(request_id, DecisionBy::User, now, reason)
        .map_err(|err| err.to_string())?;
    emit_request_change(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn list_session_connections(
    service: State<'_, Arc<ConnectionService>>,
    session_id: SessionId,
) -> Result<Vec<Connection>, String> {
    service
        .list_connections_for(session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn close_connection_command(
    app: AppHandle,
    service: State<'_, Arc<ConnectionService>>,
    connection_id: ConnectionId,
    reason: Option<String>,
) -> Result<(), String> {
    let now = SystemClockIso::now();
    service
        .close(ConnectionCaller::User, connection_id, now, reason)
        .map_err(|err| err.to_string())?;
    emit_state_change(&app, connection_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn user_open_connection(
    app: AppHandle,
    service: State<'_, Arc<ConnectionService>>,
    session_a: SessionId,
    session_b: SessionId,
    reason: String,
) -> Result<Connection, String> {
    let now = SystemClockIso::now();
    let id = service
        .user_open(session_a, session_b, reason, now)
        .map_err(|err| err.to_string())?;
    emit_state_change(&app, id);
    let connection = service
        .get_connection(id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "connection disappeared after open".to_owned())?;
    Ok(connection)
}

#[tauri::command]
pub(crate) fn connection_transcript(
    service: State<'_, Arc<ConnectionService>>,
    connection_id: ConnectionId,
) -> Result<Vec<ConnectionMessage>, String> {
    // Use the read-only list_messages path. Reading the panel must not
    // consume the delivery signal for the agent on `participant_a`'s side;
    // `pending_messages` would have stamped delivered_at.
    let connection = service
        .get_connection(connection_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("unknown connection {connection_id}"))?;
    let caller = connection.participant_a;
    service
        .list_messages(caller, connection_id, 0)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn connection_policy(
    service: State<'_, Arc<ConnectionService>>,
) -> Result<ConnectionPolicy, String> {
    Ok(service.current_policy())
}

#[tauri::command]
pub(crate) fn set_connection_policy(
    service: State<'_, Arc<ConnectionService>>,
    policy: ConnectionPolicy,
) -> Result<ConnectionPolicy, String> {
    service.set_policy(policy);
    Ok(service.current_policy())
}

#[tauri::command]
pub(crate) fn set_focus_policy_override(
    service: State<'_, Arc<ConnectionService>>,
    focus_id: reverie_core::domain::FocusId,
    policy: Option<ConnectionPolicy>,
) -> Result<Option<ConnectionPolicy>, String> {
    service.set_focus_policy_override(focus_id, policy);
    Ok(service.focus_policy_override(focus_id))
}

#[tauri::command]
pub(crate) fn focus_policy_override(
    service: State<'_, Arc<ConnectionService>>,
    focus_id: reverie_core::domain::FocusId,
) -> Result<Option<ConnectionPolicy>, String> {
    Ok(service.focus_policy_override(focus_id))
}

#[tauri::command]
pub(crate) fn pair_recently_denied(
    service: State<'_, Arc<ConnectionService>>,
    source_session_id: SessionId,
    target_session_id: SessionId,
) -> Result<bool, String> {
    Ok(service.pair_recently_denied(source_session_id, target_session_id))
}

#[tauri::command]
pub(crate) fn block_session_pair(
    service: State<'_, Arc<ConnectionService>>,
    source_session_id: SessionId,
    target_session_id: SessionId,
    duration_secs: u64,
) -> Result<(), String> {
    service.block_pair_for(
        source_session_id,
        target_session_id,
        std::time::Duration::from_secs(duration_secs),
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_session_pair_block(
    service: State<'_, Arc<ConnectionService>>,
    source_session_id: SessionId,
    target_session_id: SessionId,
) -> Result<(), String> {
    service.clear_pair_block(source_session_id, target_session_id);
    Ok(())
}

fn emit_state_change(app: &AppHandle, connection_id: ConnectionId) {
    let _ = app.emit(
        CONNECTION_STATE_EVENT,
        serde_json::json!({ "connectionId": connection_id.to_string() }),
    );
}

fn emit_request_change(app: &AppHandle) {
    let _ = app.emit(CONNECTION_REQUEST_EVENT, serde_json::json!({}));
}

use tauri::Emitter;

fn resolve_bridge_binaries(app: &AppHandle) -> Result<BridgeBinaries> {
    // Resource path lookup for production builds. In dev (tauri:dev), the
    // sidecar layout colocates the binaries next to the desktop exe.
    let exe = std::env::current_exe().map_err(|err| anyhow!("locating current exe: {err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("current exe has no parent dir"))?;
    let reverie_bridge =
        pick_first_existing(&[dir.join("reverie-bridge"), dir.join("reverie-bridge.exe")])
            .unwrap_or_else(|| dir.join("reverie-bridge"));
    let preturn_hook = pick_first_existing(&[
        dir.join("reverie-bridge-preturn-hook"),
        dir.join("reverie-bridge-preturn-hook.exe"),
    ])
    .unwrap_or_else(|| dir.join("reverie-bridge-preturn-hook"));
    let _ = app;
    Ok(BridgeBinaries {
        reverie_bridge,
        preturn_hook,
    })
}

fn pick_first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}
