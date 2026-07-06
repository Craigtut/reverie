//! Reaper for archived and idle background agent sessions.
//!
//! Reverie keeps sessions alive aggressively: a resumed conversation takes a few
//! seconds to replay, so a recent idle *live* session is far snappier to return
//! to than a parked one. We keep that recent window, but park old background
//! process trees on a wall-clock budget, with a shorter budget on battery. We
//! also stop archived sessions regardless of age; archived work should not keep a
//! process tree alive. Under memory pressure we shed sooner, using macOS's own
//! pressure signal.
//!
//! Every reap path only touches sessions that are genuinely safe to drop:
//!
//!   - never the session on screen,
//!   - never one that is `working` or `awaiting_permission`,
//!   - never one that produced output in the last few seconds, and
//!   - never one idle for less than the grace window.
//!
//! Reaping is invisible: a reaped session becomes an ordinary resumable session
//! and replays its conversation when reopened.

use std::collections::{HashMap, HashSet};
use std::thread;
use std::time::{Duration, Instant};

use reverie_core::WorkspaceService;
use reverie_core::WorkspaceSnapshot;
use reverie_core::activity::ActivityStatus;
use reverie_core::domain::{FocusId, ProjectId, SessionId};
use reverie_core::terminal::TerminalId;

use crate::terminal::runtime::{
    TerminalRuntimeStatus, TerminalSessionRecord, TerminalSessionRuntime,
};

/// How often we sample memory pressure while the machine is healthy. Cheap: a
/// single sysctl read, no session work.
const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// While shedding under pressure, how long to let the OS reclaim memory before
/// re-measuring and possibly reaping again.
const SHED_SETTLE: Duration = Duration::from_secs(2);
/// A session must be idle at least this long before it is reap-eligible, so we
/// never reap something the user was just working with under memory pressure.
const MEMORY_PRESSURE_IDLE_GRACE: Duration = Duration::from_secs(10 * 60);
/// Time-bound parking for idle background sessions on wall power. This is long
/// enough to keep recent sessions warm, but prevents day-old live process trees.
const AC_IDLE_GRACE: Duration = Duration::from_secs(60 * 60);
/// Time-bound parking for idle background sessions on battery. Keep this shorter
/// than AC because the PTY/process tree still consumes energy even when the
/// terminal surface is not painting it.
const BATTERY_IDLE_GRACE: Duration = Duration::from_secs(30 * 60);
/// Defensive guard: never reap a session that emitted output this recently, even
/// if its activity feed looks idle (covers CLIs we have no activity hook for).
const RECENT_OUTPUT_GUARD: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum MemoryPressure {
    Normal,
    Warn,
    Critical,
}

/// Spawn the background reaper thread. Best-effort: if it fails to spawn we
/// simply never reap (sessions stay alive), which is the safe default.
pub fn spawn_reaper(runtime: TerminalSessionRuntime, service: WorkspaceService) {
    thread::Builder::new()
        .name("reverie-session-reaper".to_owned())
        .spawn(move || reaper_loop(runtime, service))
        .ok();
}

fn reaper_loop(runtime: TerminalSessionRuntime, service: WorkspaceService) {
    loop {
        thread::sleep(POLL_INTERVAL);
        reap_archived_live_sessions(&runtime, &service);
        reap_idle_over_time_budget(&runtime, &service);
        if current_memory_pressure() == MemoryPressure::Normal {
            continue;
        }
        // Under pressure: shed the coldest eligible idle session, let the OS
        // settle, then re-measure. Stop as soon as pressure clears or nothing is
        // eligible (we ride out pressure silently rather than touch a protected
        // session).
        while current_memory_pressure() != MemoryPressure::Normal {
            if !reap_coldest_eligible(&runtime, &service, MEMORY_PRESSURE_IDLE_GRACE) {
                break;
            }
            thread::sleep(SHED_SETTLE);
        }
    }
}

fn reap_archived_live_sessions(runtime: &TerminalSessionRuntime, service: &WorkspaceService) {
    let Ok(records) = runtime.list_sessions() else {
        return;
    };
    let Ok(snapshot) = service.snapshot() else {
        return;
    };
    let archive_index = ArchiveIndex::new(&snapshot);

    for record in records {
        if record.status != TerminalRuntimeStatus::Running {
            continue;
        }
        let Some(session_id) = record.session_id else {
            continue;
        };
        if !archive_index.session_effectively_archived(session_id) {
            continue;
        }
        if let Err(err) = runtime.terminate_session(record.terminal_id) {
            eprintln!(
                "[reverie] reaper could not stop archived terminal {}: {err:#}",
                record.terminal_id
            );
        } else {
            eprintln!(
                "[reverie] reaped archived session terminal {}",
                record.terminal_id
            );
        }
    }
}

fn reap_idle_over_time_budget(runtime: &TerminalSessionRuntime, service: &WorkspaceService) {
    let threshold = idle_grace_for_current_power();
    let Ok(records) = runtime.list_sessions() else {
        return;
    };
    let Ok(snapshot) = service.snapshot() else {
        return;
    };
    let archive_index = ArchiveIndex::new(&snapshot);
    let foreground = runtime.foreground_terminal();
    let now = Instant::now();

    for record in records {
        if !eligible_for_idle_reap(
            &record,
            Some(&snapshot),
            Some(&archive_index),
            foreground,
            threshold,
            now,
        ) {
            continue;
        }
        if let Err(err) = runtime.terminate_session(record.terminal_id) {
            eprintln!(
                "[reverie] reaper could not stop idle terminal {}: {err:#}",
                record.terminal_id
            );
        } else {
            eprintln!(
                "[reverie] reaped idle session terminal {} after {}s idle",
                record.terminal_id,
                threshold.as_secs()
            );
        }
    }
}

/// Reap the single coldest reap-eligible session. Returns whether one was
/// reaped.
fn reap_coldest_eligible(
    runtime: &TerminalSessionRuntime,
    service: &WorkspaceService,
    idle_grace: Duration,
) -> bool {
    let foreground = runtime.foreground_terminal();
    let Ok(records) = runtime.list_sessions() else {
        return false;
    };
    // Activity status comes from the persisted snapshot; failing to load it just
    // means we fall back to the output/idle timers (and never reap a busy CLI
    // thanks to RECENT_OUTPUT_GUARD).
    let snapshot = service.snapshot().ok();
    let archive_index = snapshot.as_ref().map(ArchiveIndex::new);
    let now = Instant::now();

    let mut coldest: Option<(TerminalId, Duration)> = None;
    for record in &records {
        if !eligible_for_idle_reap(
            record,
            snapshot.as_ref(),
            archive_index.as_ref(),
            foreground,
            idle_grace,
            now,
        ) {
            continue;
        }
        // Idle since the most recent of last output / last user input.
        let idle_since = record.last_output_at.max(record.last_active_at);
        let idle = now.saturating_duration_since(idle_since);
        if idle < idle_grace {
            continue;
        }
        // Track the coldest (longest-idle) candidate.
        if coldest.is_none_or(|(_, best)| idle > best) {
            coldest = Some((record.terminal_id, idle));
        }
    }

    let Some((terminal_id, idle)) = coldest else {
        return false;
    };
    // Graceful tree-kill. The worker's exit path then marks the session
    // restorable and notifies the frontend; reopening it replays the
    // conversation, so this is invisible beyond a brief resume.
    if let Err(err) = runtime.terminate_session(terminal_id) {
        eprintln!("[reverie] reaper could not stop terminal {terminal_id}: {err:#}");
        return false;
    }
    eprintln!(
        "[reverie] reaped idle session terminal {terminal_id} under memory pressure (idle {}s)",
        idle.as_secs()
    );
    true
}

fn eligible_for_idle_reap(
    record: &TerminalSessionRecord,
    snapshot: Option<&WorkspaceSnapshot>,
    archive_index: Option<&ArchiveIndex>,
    foreground: Option<TerminalId>,
    idle_grace: Duration,
    now: Instant,
) -> bool {
    if record.status != TerminalRuntimeStatus::Running {
        return false;
    }
    let Some(session_id) = record.session_id else {
        return false;
    };
    if archive_index.is_some_and(|index| index.session_effectively_archived(session_id)) {
        return false;
    }
    if Some(record.terminal_id) == foreground {
        return false;
    }
    if now.saturating_duration_since(record.last_output_at) < RECENT_OUTPUT_GUARD {
        return false;
    }
    if protected_activity(snapshot, session_id) {
        return false;
    }
    let idle_since = record.last_output_at.max(record.last_active_at);
    now.saturating_duration_since(idle_since) >= idle_grace
}

fn protected_activity(snapshot: Option<&WorkspaceSnapshot>, session_id: SessionId) -> bool {
    matches!(
        activity_status(snapshot, session_id),
        Some(
            ActivityStatus::Working
                | ActivityStatus::AwaitingPermission
                | ActivityStatus::AwaitingResponse
        )
    )
}

fn idle_grace_for_current_power() -> Duration {
    if crate::power::current_power_status().on_battery {
        BATTERY_IDLE_GRACE
    } else {
        AC_IDLE_GRACE
    }
}

struct ArchiveIndex {
    sessions: HashMap<SessionId, (bool, FocusId)>,
    archived_focuses: HashSet<FocusId>,
    archived_projects: HashSet<ProjectId>,
    focus_projects: HashMap<FocusId, ProjectId>,
}

impl ArchiveIndex {
    fn new(snapshot: &WorkspaceSnapshot) -> Self {
        Self {
            sessions: snapshot
                .sessions
                .iter()
                .map(|session| (session.id, (session.archived, session.focus_id)))
                .collect(),
            archived_focuses: snapshot
                .focuses
                .iter()
                .filter(|focus| focus.archived)
                .map(|focus| focus.id)
                .collect(),
            archived_projects: snapshot
                .projects
                .iter()
                .filter(|project| project.archived)
                .map(|project| project.id)
                .collect(),
            focus_projects: snapshot
                .focuses
                .iter()
                .filter_map(|focus| focus.project_id.map(|project_id| (focus.id, project_id)))
                .collect(),
        }
    }

    fn session_effectively_archived(&self, session_id: SessionId) -> bool {
        let Some((session_archived, focus_id)) = self.sessions.get(&session_id) else {
            return false;
        };
        *session_archived
            || self.archived_focuses.contains(focus_id)
            || self
                .focus_projects
                .get(focus_id)
                .is_some_and(|project_id| self.archived_projects.contains(project_id))
    }
}

fn activity_status(
    snapshot: Option<&WorkspaceSnapshot>,
    session_id: SessionId,
) -> Option<ActivityStatus> {
    snapshot?
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.latest_activity.as_ref())
        .map(|activity| activity.status)
}

/// Read macOS's own memory-pressure verdict via
/// `kern.memorystatus_vm_pressure_level` (1 = normal, 2 = warn, 4 = critical).
/// We react to this rather than to a raw free-memory figure, which macOS keeps
/// near zero by design (compression + swap); the OS verdict already accounts for
/// all of that.
#[cfg(target_os = "macos")]
fn current_memory_pressure() -> MemoryPressure {
    let name = c"kern.memorystatus_vm_pressure_level";
    let mut level: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut level as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        // Cannot read the level: assume healthy so we never reap blindly.
        return MemoryPressure::Normal;
    }
    match level {
        2 => MemoryPressure::Warn,
        4 => MemoryPressure::Critical,
        _ => MemoryPressure::Normal,
    }
}

#[cfg(not(target_os = "macos"))]
fn current_memory_pressure() -> MemoryPressure {
    MemoryPressure::Normal
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use reverie_core::activity::ActivityState;
    use reverie_core::domain::{AgentKind, Focus, Project, Session, Workspace};

    use super::*;

    fn snapshot_for(project: Project, focus: Focus, session: Session) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            workspace: Workspace::new("Test", "General"),
            projects: vec![project],
            focuses: vec![focus],
            sessions: vec![session],
        }
    }

    fn activity(status: ActivityStatus) -> ActivityState {
        ActivityState {
            version: 1,
            session_id: "native-session".to_owned(),
            status,
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            sequence: 1,
            cwd: "/tmp/reverie".to_owned(),
            turn: None,
            active_tools: Vec::new(),
            awaiting_permission: None,
            last_error: None,
            final_exit: None,
        }
    }

    fn session_record(
        session_id: SessionId,
        terminal_id: TerminalId,
        now: Instant,
    ) -> TerminalSessionRecord {
        TerminalSessionRecord {
            session_id: Some(session_id),
            terminal_id,
            title: None,
            cols: 120,
            rows: 40,
            status: TerminalRuntimeStatus::Running,
            frames_emitted: 0,
            bytes_read: 0,
            last_exit_success: None,
            last_output_at: now - Duration::from_secs(2 * 60 * 60),
            last_active_at: now - Duration::from_secs(2 * 60 * 60),
        }
    }

    #[test]
    fn archive_index_treats_session_focus_and_project_archive_as_effective() {
        let project = Project::new("Project", PathBuf::from("/tmp/reverie"));
        let focus = Focus::for_project(project.id, "Topic", 0);
        let session = Session::new(
            focus.id,
            "Session",
            AgentKind::ClaudeCode,
            PathBuf::from("/tmp/reverie"),
        );
        let session_id = session.id;

        let snapshot = snapshot_for(project.clone(), focus.clone(), session.clone());
        assert!(!ArchiveIndex::new(&snapshot).session_effectively_archived(session_id));

        let mut archived_session = session.clone();
        archived_session.archived = true;
        let snapshot = snapshot_for(project.clone(), focus.clone(), archived_session);
        assert!(ArchiveIndex::new(&snapshot).session_effectively_archived(session_id));

        let mut archived_focus = focus.clone();
        archived_focus.archived = true;
        let snapshot = snapshot_for(project.clone(), archived_focus, session.clone());
        assert!(ArchiveIndex::new(&snapshot).session_effectively_archived(session_id));

        let mut archived_project = project;
        archived_project.archived = true;
        let snapshot = snapshot_for(archived_project, focus, session);
        assert!(ArchiveIndex::new(&snapshot).session_effectively_archived(session_id));
    }

    #[test]
    fn idle_reap_keeps_recent_foreground_and_active_sessions_live() {
        let project = Project::new("Project", PathBuf::from("/tmp/reverie"));
        let focus = Focus::for_project(project.id, "Topic", 0);
        let session = Session::new(
            focus.id,
            "Session",
            AgentKind::ClaudeCode,
            PathBuf::from("/tmp/reverie"),
        );
        let session_id = session.id;
        let terminal_id = TerminalId::new_v4();
        let snapshot = snapshot_for(project.clone(), focus.clone(), session.clone());
        let archive_index = ArchiveIndex::new(&snapshot);
        let now = Instant::now();
        let record = session_record(session_id, terminal_id, now);

        assert!(eligible_for_idle_reap(
            &record,
            Some(&snapshot),
            Some(&archive_index),
            None,
            AC_IDLE_GRACE,
            now
        ));
        assert!(!eligible_for_idle_reap(
            &record,
            Some(&snapshot),
            Some(&archive_index),
            Some(terminal_id),
            AC_IDLE_GRACE,
            now
        ));

        let mut recent = record.clone();
        recent.last_output_at = now - Duration::from_secs(1);
        assert!(!eligible_for_idle_reap(
            &recent,
            Some(&snapshot),
            Some(&archive_index),
            None,
            AC_IDLE_GRACE,
            now
        ));

        for status in [
            ActivityStatus::Working,
            ActivityStatus::AwaitingPermission,
            ActivityStatus::AwaitingResponse,
        ] {
            let mut protected_session = session.clone();
            protected_session.latest_activity = Some(activity(status));
            let protected_snapshot =
                snapshot_for(project.clone(), focus.clone(), protected_session);
            let protected_index = ArchiveIndex::new(&protected_snapshot);
            assert!(!eligible_for_idle_reap(
                &record,
                Some(&protected_snapshot),
                Some(&protected_index),
                None,
                AC_IDLE_GRACE,
                now
            ));
        }

        let mut resting_session = session;
        resting_session.latest_activity = Some(activity(ActivityStatus::AwaitingInput));
        let resting_snapshot = snapshot_for(project, focus, resting_session);
        let resting_index = ArchiveIndex::new(&resting_snapshot);
        assert!(eligible_for_idle_reap(
            &record,
            Some(&resting_snapshot),
            Some(&resting_index),
            None,
            AC_IDLE_GRACE,
            now
        ));
    }

    #[test]
    fn idle_reap_uses_the_newer_of_output_and_user_activity() {
        let project = Project::new("Project", PathBuf::from("/tmp/reverie"));
        let focus = Focus::for_project(project.id, "Topic", 0);
        let session = Session::new(
            focus.id,
            "Session",
            AgentKind::ClaudeCode,
            PathBuf::from("/tmp/reverie"),
        );
        let now = Instant::now();
        let snapshot = snapshot_for(project, focus, session.clone());
        let archive_index = ArchiveIndex::new(&snapshot);
        let mut record = session_record(session.id, TerminalId::new_v4(), now);

        record.last_output_at = now - Duration::from_secs(2 * 60 * 60);
        record.last_active_at = now - Duration::from_secs(5 * 60);
        assert!(!eligible_for_idle_reap(
            &record,
            Some(&snapshot),
            Some(&archive_index),
            None,
            AC_IDLE_GRACE,
            now
        ));

        record.last_active_at = now - Duration::from_secs(2 * 60 * 60);
        assert!(eligible_for_idle_reap(
            &record,
            Some(&snapshot),
            Some(&archive_index),
            None,
            AC_IDLE_GRACE,
            now
        ));
    }
}
