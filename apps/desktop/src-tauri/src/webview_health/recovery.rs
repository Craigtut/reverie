//! Recovery for a main webview that stopped answering: check, probe, act.
//!
//! A reload alone cannot fix a page whose web content process (or its link to
//! WebKit's GPU process) is wedged; it reloads into the same broken process.
//! So recovery probes first and, when JavaScript, IPC, or frame production is
//! dead, restarts the web content process. WebKit reports that as a content
//! process termination, and `on_content_process_terminated` reloads the page
//! into a fresh process. Terminal sessions live in the native process and keep
//! running throughout.

use std::thread;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

use super::probe::{PageProbe, probe_main_webview};
use super::{WebviewHealth, record};
use crate::state::unix_time_millis;

const CHECK_DELAY: Duration = Duration::from_secs(5);
const RECOVERY_COOLDOWN_MS: i64 = 30_000;

/// What a probe says about a page whose heartbeat went quiet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Diagnosis {
    JavaScriptUnresponsive,
    // Visible to AppKit and focused, yet WebKit tells the page it is hidden. A
    // fresh process would inherit the same visibility, so this is only recorded.
    PageHidden,
    ShellNotMounted,
    IpcRequestLost,
    IpcResponseLost,
    FramesStalled,
    // JavaScript, IPC, and frames all answered; the heartbeat just lagged.
    HeartbeatOnly,
}

impl Diagnosis {
    fn as_str(self) -> &'static str {
        match self {
            Self::JavaScriptUnresponsive => "javascript_unresponsive",
            Self::PageHidden => "page_hidden",
            Self::ShellNotMounted => "shell_not_mounted",
            Self::IpcRequestLost => "ipc_request_lost",
            Self::IpcResponseLost => "ipc_response_lost",
            Self::FramesStalled => "frames_stalled",
            Self::HeartbeatOnly => "heartbeat_only",
        }
    }

    fn needs_fresh_process(self) -> bool {
        !matches!(self, Self::PageHidden | Self::HeartbeatOnly)
    }
}

pub(crate) fn diagnose(probe: &PageProbe) -> Diagnosis {
    if !probe.javascript_alive() {
        Diagnosis::JavaScriptUnresponsive
    } else if probe.page_hidden() {
        Diagnosis::PageHidden
    } else if !probe.shell_mounted() {
        Diagnosis::ShellNotMounted
    } else if !probe.ipc_request_reached_native {
        Diagnosis::IpcRequestLost
    } else if !probe.ipc_response_returned() {
        Diagnosis::IpcResponseLost
    } else if !probe.frame_fired() {
        Diagnosis::FramesStalled
    } else {
        Diagnosis::HeartbeatOnly
    }
}

/// Check the main webview a few seconds after focus/resume, and recover it if
/// its JavaScript did not answer the focus handshake.
pub(crate) fn schedule_recovery_check(app: AppHandle, reason: &'static str) {
    let heartbeat_before = app
        .try_state::<WebviewHealth>()
        .map(|health| health.last_heartbeat_ms())
        .unwrap_or_default();
    record(
        &app,
        "webview.recovery_scheduled",
        json!({ "reason": reason, "heartbeatBeforeMs": heartbeat_before }),
    );
    thread::Builder::new()
        .name("reverie-webview-health".to_owned())
        .spawn(move || run_check(&app, reason, heartbeat_before))
        .ok();
}

fn run_check(app: &AppHandle, reason: &'static str, heartbeat_before: i64) {
    thread::sleep(CHECK_DELAY);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !window.is_focused().unwrap_or(false) {
        record(
            app,
            "webview.recovery_cancelled",
            json!({ "reason": reason, "result": "window_not_focused" }),
        );
        return;
    }
    let Some(health) = app.try_state::<WebviewHealth>() else {
        return;
    };
    // Focus is a handshake, not an age check. The frontend sends an immediate
    // heartbeat on every focus/pageshow even if its interval already exists.
    // Only a page that failed to answer during the whole check window is suspect.
    let last_heartbeat = health.last_heartbeat_ms();
    if last_heartbeat > heartbeat_before {
        record(
            app,
            "webview.recovery_healthy",
            json!({
                "reason": reason,
                "heartbeatBeforeMs": heartbeat_before,
                "lastHeartbeatMs": last_heartbeat,
            }),
        );
        return;
    }
    let now = unix_time_millis();
    let stale_for = now.saturating_sub(last_heartbeat);
    if !health.claim_recovery(now, RECOVERY_COOLDOWN_MS) {
        record(
            app,
            "webview.recovery_deferred",
            json!({ "reason": reason, "staleForMs": stale_for }),
        );
        return;
    }

    let probe = probe_main_webview(&window, &health);
    let diagnosis = diagnose(&probe);
    record(
        app,
        "webview.probe",
        json!({
            "reason": reason,
            "staleForMs": stale_for,
            "diagnosis": diagnosis.as_str(),
            "probe": probe.to_json(),
        }),
    );
    if !diagnosis.needs_fresh_process() {
        return;
    }
    if let Some(pid) = restart_content_process(&window) {
        record(
            app,
            "webview.content_process_restart",
            json!({ "reason": reason, "diagnosis": diagnosis.as_str(), "pid": pid }),
        );
    } else {
        reload_main_webview(&window, reason, diagnosis);
    }
}

/// WebKit reported the web content process gone (crash, jetsam, or our own
/// restart). Reload the page into a fresh process and verify it came back.
pub(crate) fn on_content_process_terminated(webview: &Webview) {
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    if let Some(health) = app.try_state::<WebviewHealth>() {
        let _ = health.claim_recovery(unix_time_millis(), 0);
    }
    record(
        &app,
        "webview.content_terminated",
        json!({ "label": label.clone() }),
    );
    eprintln!("[reverie] web content process terminated for webview {label}; reloading");
    if let Err(error) = webview.reload() {
        eprintln!("[reverie] failed to reload terminated webview {label}: {error}");
        record(
            &app,
            "webview.content_terminate_reload_failed",
            json!({ "label": label, "error": error.to_string() }),
        );
    }
    schedule_recovery_check(app, "web_content_terminated");
}

fn reload_main_webview(window: &WebviewWindow, reason: &'static str, diagnosis: Diagnosis) {
    let app = window.app_handle();
    record(
        app,
        "webview.reload",
        json!({ "reason": reason, "diagnosis": diagnosis.as_str() }),
    );
    eprintln!(
        "[reverie] reloading main webview after {reason} ({})",
        diagnosis.as_str()
    );
    if let Err(error) = window.reload() {
        eprintln!("[reverie] failed to reload main webview after {reason}: {error}");
        record(
            app,
            "webview.reload_failed",
            json!({ "reason": reason, "error": error.to_string() }),
        );
    }
}

/// Kill the main page's web content process so WebKit relaunches it: WebKit
/// treats the death like a crash, the termination delegate fires, and we reload
/// into a fresh process. Returns the killed PID, or `None` when it could not be
/// found, so the caller can fall back to a reload.
///
/// This sends SIGKILL to the PID from WKWebView's `_webProcessIdentifier` SPI.
/// The `_killWebContentProcess` SPI looks like the right tool but only asks the
/// process to exit over its XPC connection; on macOS 27 a wedged page process
/// ignored that and kept running.
#[cfg(target_os = "macos")]
fn restart_content_process(window: &WebviewWindow) -> Option<i32> {
    use std::sync::mpsc;

    use objc::runtime::{BOOL, NO, Object};
    use objc::{msg_send, sel, sel_impl};

    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let web_view = webview.inner() as *mut Object;
            // SAFETY: `inner()` is the live WKWebView, and this closure runs on
            // the main thread. The selector is checked before it is sent.
            let pid = unsafe {
                if web_view.is_null() {
                    0
                } else {
                    let responds: BOOL =
                        msg_send![web_view, respondsToSelector: sel!(_webProcessIdentifier)];
                    if responds == NO {
                        0
                    } else {
                        let pid: libc::pid_t = msg_send![web_view, _webProcessIdentifier];
                        pid
                    }
                }
            };
            let _ = tx.send(pid);
        })
        .ok()?;
    let pid = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    if pid <= 0 || pid as u32 == std::process::id() {
        return None;
    }
    // SAFETY: plain signal send to a WebKit helper process we own.
    (unsafe { libc::kill(pid, libc::SIGKILL) } == 0).then_some(pid)
}

#[cfg(not(target_os = "macos"))]
fn restart_content_process(_window: &WebviewWindow) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn probe(page: serde_json::Value, follow_up: serde_json::Value, reached: bool) -> PageProbe {
        PageProbe {
            page: Some(page),
            follow_up: Some(follow_up),
            ipc_request_reached_native: reached,
        }
    }

    fn healthy_page() -> serde_json::Value {
        json!({ "visibility": "visible", "shellMounted": true })
    }

    fn healthy_follow_up() -> serde_json::Value {
        json!({ "frame": true, "invoke": "resolved" })
    }

    #[test]
    fn silent_javascript_needs_a_fresh_process() {
        let diagnosis = diagnose(&PageProbe::default());
        assert_eq!(diagnosis, Diagnosis::JavaScriptUnresponsive);
        assert!(diagnosis.needs_fresh_process());

        let threw = probe(json!({ "error": "boom" }), healthy_follow_up(), true);
        assert_eq!(diagnose(&threw), Diagnosis::JavaScriptUnresponsive);
    }

    #[test]
    fn a_hidden_page_is_recorded_but_left_alone() {
        let hidden = probe(
            json!({ "visibility": "hidden", "shellMounted": true }),
            healthy_follow_up(),
            false,
        );
        let diagnosis = diagnose(&hidden);
        assert_eq!(diagnosis, Diagnosis::PageHidden);
        assert!(!diagnosis.needs_fresh_process());
    }

    #[test]
    fn each_dead_layer_is_named_in_order() {
        let unmounted = probe(
            json!({ "visibility": "visible" }),
            healthy_follow_up(),
            true,
        );
        assert_eq!(diagnose(&unmounted), Diagnosis::ShellNotMounted);

        let lost_request = probe(healthy_page(), healthy_follow_up(), false);
        assert_eq!(diagnose(&lost_request), Diagnosis::IpcRequestLost);

        let lost_response = probe(
            healthy_page(),
            json!({ "frame": true, "invoke": "pending" }),
            true,
        );
        assert_eq!(diagnose(&lost_response), Diagnosis::IpcResponseLost);

        let stalled = probe(
            healthy_page(),
            json!({ "frame": false, "invoke": "resolved" }),
            true,
        );
        assert_eq!(diagnose(&stalled), Diagnosis::FramesStalled);

        for diagnosis in [
            Diagnosis::ShellNotMounted,
            Diagnosis::IpcRequestLost,
            Diagnosis::IpcResponseLost,
            Diagnosis::FramesStalled,
        ] {
            assert!(diagnosis.needs_fresh_process(), "{diagnosis:?}");
        }
    }

    #[test]
    fn a_page_that_answers_everything_only_lagged() {
        let fine = probe(healthy_page(), healthy_follow_up(), true);
        let diagnosis = diagnose(&fine);
        assert_eq!(diagnosis, Diagnosis::HeartbeatOnly);
        assert!(!diagnosis.needs_fresh_process());
    }

    #[test]
    fn a_page_that_stops_answering_mid_probe_reads_as_lost_ipc() {
        let gone = PageProbe {
            page: Some(healthy_page()),
            follow_up: None,
            ipc_request_reached_native: false,
        };
        assert_eq!(diagnose(&gone), Diagnosis::IpcRequestLost);
    }
}
