//! Ask a webview that stopped sending heartbeats which layer stopped working.
//!
//! The probe runs in two stages through WebKit's script evaluation, which does
//! not go through Tauri IPC, so it still answers when IPC is the broken layer:
//!
//! 1. Is JavaScript alive, and what does the page see (visibility, focus, boot
//!    progress, heartbeat counters)? This stage also starts an IPC round trip
//!    and asks for an animation frame.
//! 2. A moment later: did the round trip reach native (the probe's invoke marks
//!    the heartbeat), did its response come back, and did a frame fire?

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tauri::WebviewWindow;

use super::WebviewHealth;

const EVAL_TIMEOUT: Duration = Duration::from_secs(2);
// Long enough for one IPC round trip and a frame on a busy machine.
const FOLLOW_UP_DELAY: Duration = Duration::from_millis(1500);

const STAGE_ONE: &str = r#"(() => {
  try {
    const probe = (window.__reverieProbe = { startedAt: performance.now(), frame: false, invoke: 'pending' });
    try {
      requestAnimationFrame(() => { probe.frame = true; });
    } catch (_) {
      probe.frame = 'threw';
    }
    try {
      const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (typeof invoke === 'function') {
        invoke('webview_heartbeat').then(
          () => { probe.invoke = 'resolved'; },
          () => { probe.invoke = 'rejected'; },
        );
      } else {
        probe.invoke = 'unavailable';
      }
    } catch (_) {
      probe.invoke = 'threw';
    }
    const heartbeat = window.__reverieHeartbeat;
    const root = document.getElementById('root');
    return {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      readyState: document.readyState,
      rootChildren: root ? root.childElementCount : null,
      shellMounted: Boolean(heartbeat),
      heartbeat: heartbeat ? heartbeat.snapshot() : null,
      uptimeMs: Math.round(performance.now()),
    };
  } catch (error) {
    return { error: String(error) };
  }
})()"#;

const STAGE_TWO: &str = r#"(() => {
  const probe = window.__reverieProbe;
  return probe
    ? { frame: probe.frame, invoke: probe.invoke, elapsedMs: Math.round(performance.now() - probe.startedAt) }
    : { missing: true };
})()"#;

/// What the page reported. `page` is `None` when JavaScript never answered.
#[derive(Debug, Default)]
pub(crate) struct PageProbe {
    pub(crate) page: Option<Value>,
    pub(crate) follow_up: Option<Value>,
    pub(crate) ipc_request_reached_native: bool,
}

impl PageProbe {
    pub(crate) fn javascript_alive(&self) -> bool {
        self.page
            .as_ref()
            .is_some_and(|page| page.get("error").is_none())
    }

    pub(crate) fn page_hidden(&self) -> bool {
        self.page_field("visibility") == Some(&Value::from("hidden"))
    }

    pub(crate) fn shell_mounted(&self) -> bool {
        self.page_field("shellMounted") == Some(&Value::Bool(true))
    }

    pub(crate) fn ipc_response_returned(&self) -> bool {
        self.follow_up_field("invoke") == Some(&Value::from("resolved"))
    }

    pub(crate) fn frame_fired(&self) -> bool {
        self.follow_up_field("frame") == Some(&Value::Bool(true))
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({
            "page": self.page,
            "followUp": self.follow_up,
            "ipcRequestReachedNative": self.ipc_request_reached_native,
        })
    }

    fn page_field(&self, key: &str) -> Option<&Value> {
        self.page.as_ref()?.get(key)
    }

    fn follow_up_field(&self, key: &str) -> Option<&Value> {
        self.follow_up.as_ref()?.get(key)
    }
}

/// Probe the main webview. Blocks for up to a few seconds, so it must run off
/// the main thread (script evaluation itself is dispatched to it).
pub(crate) fn probe_main_webview(window: &WebviewWindow, health: &WebviewHealth) -> PageProbe {
    let heartbeat_before = health.last_heartbeat_ms();
    let page = eval_json(window, STAGE_ONE);
    if page.is_none() {
        return PageProbe::default();
    }
    thread::sleep(FOLLOW_UP_DELAY);
    PageProbe {
        page,
        follow_up: eval_json(window, STAGE_TWO),
        ipc_request_reached_native: health.last_heartbeat_ms() > heartbeat_before,
    }
}

fn eval_json(window: &WebviewWindow, script: &str) -> Option<Value> {
    let (tx, rx) = mpsc::channel();
    window
        .eval_with_callback(script, move |raw| {
            let _ = tx.send(raw);
        })
        .ok()?;
    let raw = rx.recv_timeout(EVAL_TIMEOUT).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()
        .filter(|value| !value.is_null())
}
