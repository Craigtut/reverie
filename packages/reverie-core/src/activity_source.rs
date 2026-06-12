//! The cross-transport ingestion spine: one [`ActivityUpdate`] contract that
//! every agent-activity source emits, plus the binding key and fidelity the
//! shell-side correlator uses to persist and route it.
//!
//! Reverie's durable job is to take lifecycle signal from an open-ended set of
//! agent CLIs (which expose it in wildly different ways) and normalize it into
//! one [`ActivityState`]. The *transports* differ (Claude pushes over HTTP,
//! Cortex/Codex write files); the *spine* downstream of a transport must not.
//! This module is that seam. A source's only obligation is to produce
//! `ActivityUpdate`s and have a thin drain hand them to the correlator; the
//! binding, native-id capture, fidelity merge, and frontend emit happen once,
//! there, for every CLI.
//!
//! A new CLI is classified on four orthogonal axes, and most combinations reuse
//! existing machinery:
//! 1. **Transport** (how bytes arrive): push | file-watch | poll | in-band.
//! 2. **Derivation**: snapshot (one small read is the state) | fold (accumulate
//!    from a stream of deltas).
//! 3. **Binding**: token -> [`SessionKey::Reverie`] | native-id ->
//!    [`SessionKey::Native`].
//! 4. **Fidelity**: how complete/real-time, which drives multi-source merge
//!    precedence.

use serde::Serialize;

use crate::activity::ActivityState;
use crate::domain::SessionId;

/// Which CLI produced an update. Carried through to the dashboard so
/// adapter-specific copy/routing stays possible. This serializes into the
/// frontend activity event's `source` field, so the `snake_case` names
/// (`cortex_code` / `claude_code` / `codex_cli`) are part of that wire contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivitySourceKind {
    CortexCode,
    ClaudeCode,
    CodexCli,
}

/// How an update binds to a Reverie session. This is the real fork in the
/// ingestion design, not an implementation detail:
/// - [`SessionKey::Reverie`]: the source already knows the Reverie session that
///   owns it (a push hook authenticated with a per-session token). The native
///   CLI id rides along in the state and is captured into the record on first
///   sight.
/// - [`SessionKey::Native`]: the source only knows the CLI's own session id (a
///   watched file). The launch-time capture poll attaches the native ref so the
///   update can bind to the right Reverie session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionKey {
    Reverie(SessionId),
    Native(String),
}

/// How complete and real-time a source's signal is. Drives multi-source merge
/// precedence: a definitive hook outranks an inferred log-tail for the same
/// session. `Ord` is derived from declaration order, so higher variants win.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fidelity {
    /// Best-effort, derived from a coarse signal (e.g. parsing terminal output).
    Coarse,
    /// Inferred by folding a transcript whose records are not first-class state
    /// transitions (e.g. the Codex rollout log).
    Inferred,
    /// A first-class lifecycle signal from the CLI itself: a hook, or an
    /// authoritative snapshot the CLI rewrites on every transition.
    Definitive,
}

/// One normalized update from any source. The shell's correlator is the single
/// consumer: it binds by `key`, persists the `state`, captures native ids, and
/// emits the frontend event.
#[derive(Clone, Debug)]
pub enum ActivityUpdate {
    State {
        source: ActivitySourceKind,
        key: SessionKey,
        fidelity: Fidelity,
        state: ActivityState,
        /// Whether this update is a session (re)start boundary: the edge a CLI
        /// emits when it (re)opens a conversation (Claude / Codex `SessionStart`).
        /// It is the one moment a [`SessionKey::Reverie`] (token-bound) source can
        /// legitimately carry a *different* native id than the one Reverie already
        /// captured, because the user switched conversations inside the live
        /// process (`/resume`, `/clear`). The correlator re-points the session's
        /// native ref to follow it. Every non-boundary update, and every
        /// file-watch ([`SessionKey::Native`]) source, leaves this `false`: those
        /// can never re-point identity, only confirm or advance it. Keeping the
        /// signal here (not on [`ActivityState`]) means it is a property of the
        /// transport event, not durable state, and stays CLI-agnostic: a new CLI
        /// only has to set it on its own start edge.
        session_boundary: bool,
    },
    Removed {
        source: ActivitySourceKind,
        key: SessionKey,
        /// The CLI's native session id, for the frontend event payload. For a
        /// [`SessionKey::Native`] key this equals the key's id; a
        /// [`SessionKey::Reverie`] source supplies it so the dashboard can still
        /// route the removal to the right row.
        native_session_id: String,
    },
}
