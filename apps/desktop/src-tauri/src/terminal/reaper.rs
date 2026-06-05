//! Memory-pressure-driven reaper for idle background agent sessions.
//!
//! Reverie keeps sessions alive aggressively: a resumed conversation takes a few
//! seconds to replay, so an idle *live* session is far snappier to return to than
//! a parked one. We therefore never reap on a timer. The only moment we stop an
//! idle session is when macOS itself reports real memory pressure (the same
//! signal that drives Safari's background-tab discarding), and even then we only
//! ever touch sessions that are genuinely safe to drop:
//!
//!   - never the session on screen,
//!   - never one that is `working` or `awaiting_permission`,
//!   - never one that produced output in the last few seconds, and
//!   - never one idle for less than the grace window.
//!
//! Reaping is invisible: a reaped session becomes an ordinary resumable session
//! and replays its conversation when reopened. On a machine with headroom macOS
//! never signals pressure, so this code never reaps anything.

use std::thread;
use std::time::{Duration, Instant};

use reverie_core::WorkspaceService;
use reverie_core::WorkspaceSnapshot;
use reverie_core::activity::ActivityStatus;
use reverie_core::domain::SessionId;
use reverie_core::terminal::TerminalId;

use crate::terminal::runtime::{TerminalRuntimeStatus, TerminalSessionRuntime};

/// How often we sample memory pressure while the machine is healthy. Cheap: a
/// single sysctl read, no session work.
const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// While shedding under pressure, how long to let the OS reclaim memory before
/// re-measuring and possibly reaping again.
const SHED_SETTLE: Duration = Duration::from_secs(2);
/// A session must be idle at least this long before it is reap-eligible, so we
/// never reap something the user was just working with.
const IDLE_GRACE: Duration = Duration::from_secs(10 * 60);
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
        if current_memory_pressure() == MemoryPressure::Normal {
            continue;
        }
        // Under pressure: shed the coldest eligible idle session, let the OS
        // settle, then re-measure. Stop as soon as pressure clears or nothing is
        // eligible (we ride out pressure silently rather than touch a protected
        // session).
        while current_memory_pressure() != MemoryPressure::Normal {
            if !reap_coldest_eligible(&runtime, &service) {
                break;
            }
            thread::sleep(SHED_SETTLE);
        }
    }
}

/// Reap the single coldest reap-eligible session. Returns whether one was
/// reaped.
fn reap_coldest_eligible(runtime: &TerminalSessionRuntime, service: &WorkspaceService) -> bool {
    let foreground = runtime.foreground_terminal();
    let Ok(records) = runtime.list_sessions() else {
        return false;
    };
    // Activity status comes from the persisted snapshot; failing to load it just
    // means we fall back to the output/idle timers (and never reap a busy CLI
    // thanks to RECENT_OUTPUT_GUARD).
    let snapshot = service.snapshot().ok();
    let now = Instant::now();

    let mut coldest: Option<(TerminalId, Duration)> = None;
    for record in &records {
        // Only live product sessions are reapable.
        if record.status != TerminalRuntimeStatus::Running {
            continue;
        }
        let Some(session_id) = record.session_id else {
            continue;
        };
        // Never the session the user is currently viewing.
        if Some(record.terminal_id) == foreground {
            continue;
        }
        // Defensive: never reap something actively producing output.
        if now.duration_since(record.last_output_at) < RECENT_OUTPUT_GUARD {
            continue;
        }
        // Never reap a working agent or one blocked on the user: that is the
        // whole point of the product, and a permission prompt or a raised
        // question needs the live process to receive the user's answer.
        if let Some(status) = activity_status(snapshot.as_ref(), session_id)
            && matches!(
                status,
                ActivityStatus::Working
                    | ActivityStatus::AwaitingPermission
                    | ActivityStatus::AwaitingResponse
            )
        {
            continue;
        }
        // Idle since the most recent of last output / last user input.
        let idle_since = record.last_output_at.max(record.last_active_at);
        let idle = now.saturating_duration_since(idle_since);
        if idle < IDLE_GRACE {
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
