# Remote access: the desktop peer (Rust)

> The desktop side of a remote connection is a WebRTC peer embedded in the existing Tauri app, built on the `str0m` crate, wired directly into the terminal runtime. It holds the always-on doorbell connection to the backend, answers connection requests, and once a phone takes control of a session, resizes that session and streams frames over a direct, end-to-end-encrypted data channel. This is not a new service; it runs inside the app that already owns the PTYs.

## Why the peer lives in the Rust app, not the WebView

The WebView can be closed or minimized while the app keeps running and owning the sessions. The remote peer must be reachable whenever the desktop is running, independent of any window. So the WebRTC peer lives in the Tauri Rust process, alongside the terminal runtime, not in the browser context. This also means the desktop peer plugs straight into the existing frame and input plumbing without crossing into JavaScript.

The "we would rather not write the backend in Rust" decision does not apply here. The backend is a separate service. The desktop peer is Rust because it is part of the existing Rust app and must wire into Rust-side terminal state.

## Library choice: `str0m`

We use [`str0m`](https://crates.io/crates/str0m) (latest 0.20.0, actively maintained through 2026) rather than the `webrtc` crate (webrtc-rs). The reasons:

1. **Sans-IO fits an existing tokio app.** `str0m` does no I/O of its own: "no internal threads or async tasks. All operations are happening from the calls of the public API." You own the UDP socket and drive `handle_input` / `poll_output` from your own task. This avoids grafting a second async runtime and the lock-heavy callback model webrtc-rs uses. This is the same conclusion rust-libp2p reached migrating its data-channel-only transport off webrtc-rs (rust-libp2p#3659).
2. **DTLS fingerprints are first-class on both sides**, which is exactly what the security model needs (see [`security-model.md`](security-model.md)). webrtc-rs hands back the remote certificate as raw DER you must hash yourself; `str0m` exposes structured fingerprints directly.
3. **DTLS fingerprints are accessible before trust is granted.** The security model signs each connection's SDP fingerprint with the device signing key. A stable DTLS certificate is optional, not the trust root.
4. **webrtc-rs is mid-migration.** Its own README advises staying on the older Tokio-coupled 0.17.x line until the runtime-independent 0.20+ stabilizes. We would rather not build on a line its maintainers are superseding.

We only need reliable ordered data channels, no audio or video, which is the case `str0m` handles well.

### Verified surface before pinning the dependency

`str0m::channel::ChannelConfig` exposes `ordered: bool` and `reliability: Reliability`, so the protocol can create the reliable, ordered channels defined in [`data-channel-protocol.md`](data-channel-protocol.md). When adding the dependency, still pin the exact 0.20.x version and confirm the DTLS backend feature flags in Cargo so we do not accidentally switch crypto implementations during an upgrade.

## The fingerprint-pinning implementation

The security model requires access to the local SDP/DTLS fingerprint and a way to reject a remote description whose fingerprint is not signed by the claimed device key. The concrete `str0m` surface:

- **Optional persisted certificate.** `RtcConfig::set_dtls_cert(DtlsCert)` can install a stable certificate, but the remote-access security model no longer depends on it. The device signing key is stable; the DTLS certificate may be per-connection.
- **Local fingerprint** (to sign in the signaling assertion): `DirectApi::local_dtls_fingerprint() -> &Fingerprint`, where `Fingerprint { hash_func: String /* "sha-256" */, bytes: Vec<u8> }` implements `Display` (`"sha-256 AA:BB:.."`) and `FromStr`.
- **Remote fingerprint** (to configure from the verified peer assertion): `DirectApi::remote_dtls_fingerprint() -> Option<&Fingerprint>`, plus `set_remote_fingerprint(Fingerprint)`. There is also `RtcConfig::set_fingerprint_verification(bool)`.

The handshake (see [`security-model.md`](security-model.md)) is then: include a signed assertion for the local SDP fingerprint in the offer/answer signaling envelope; on receiving the peer's SDP, verify the assertion against the peer's pinned public key before accepting that remote description; configure `str0m` to expect that verified remote fingerprint. After the data channels open, exchange `ctrl.hello` messages to leave quarantine. Refuse the connection on any mismatch, before any session data flows.

## How it wires into the terminal runtime

The desktop already produces everything the peer needs to send; the work is a transport abstraction so the same producers feed either the Tauri Channel (local WebView) or a WebRTC data channel (remote phone).

- **Frames.** Today `send_terminal_frame()` encodes a `TerminalFrame` and sends it over a Tauri `Channel`. Extract the "where does this frame go" into a small transport trait with two implementations: the existing Tauri Channel, and a `str0m` data-channel sender that writes the same bytes (prefixed with the session id, per [`data-channel-protocol.md`](data-channel-protocol.md)) onto `term_live`. The frame encoding is untouched.
- **Input.** `write_terminal_input` already takes bytes and writes them to the PTY. A phone `input` message calls the same path. No new logic, just a second caller.
- **History ranges.** `read_terminal_rows` already returns a binary row band. A phone `history_request` calls the same function and writes the band onto `term_history`, with the request id prefix from [`data-channel-protocol.md`](data-channel-protocol.md). This keeps a large history top-up from blocking live frames.
- **Activity and lifecycle.** The correlator emits `session_activity_changed` and the runtime emits terminal lifecycle events via `AppHandle.emit`. Extract event emission behind the same kind of trait so these are forwarded as `activity` / `session_event` messages on the `ctrl` channel in addition to reaching the local WebView. This is the other half of the transport abstraction and the larger of the two refactors.
- **Commands.** `select_session`, `take_control`, `release_control`, `control_heartbeat`, and allowlisted `session_command` operations map onto existing `WorkspaceService` / runtime calls. The peer is just another caller of the same service surface the Tauri commands wrap.
- **Resize and control.** Mobile selection does not resize by itself. `take_control` creates a control lease for one session, saves the previous desktop geometry, calls the same PTY + `libghostty` resize path as the desktop, and starts remote frame emission with a generation-bumped `Full`. While the lease is held, the desktop frontend shows a controlled-by-mobile placeholder for that terminal and local terminal input is disabled unless the desktop user reclaims control. `release_control`, lease expiry, or local reclaim returns geometry to the desktop.

The net new Rust is: the `str0m` peer and its UDP I/O loop, the doorbell client, the fingerprint assertion signing/verification, command allowlisting, and the transport trait with its WebRTC implementation. Everything downstream (frame production, PTY writes, history, activity) is reused.

## The doorbell connection

On launch (and on every drop), the desktop opens one outbound connection to the backend and holds it. Its jobs:

- **Presence.** The connection being open is the "this desktop is online" signal the phone reads.
- **Signaling intake.** When a phone wants to connect, the backend pushes the offer down this connection; the desktop runs the `str0m` answer and ICE exchange back through it.
- **Push triggers.** When the activity model crosses a notify-worthy threshold (a session needs input, finishes, or asks permission), the desktop sends a small trigger up this connection so the backend can send a push. (Triggers could also be a plain outbound HTTP POST; holding the connection for signaling means it is available for triggers too.)

The connection carries no session data, only these tiny control messages, and is idle almost always. Its transport and the backend side are in the private backend docs; the client contract is "hold one outbound connection, re-establish on drop, expect to be handed offers and to send triggers."

## TURN

ICE finds a direct path most of the time. When it cannot (commonly cellular carrier-grade NAT), the peer uses a TURN relay. The desktop fetches short-lived TURN credentials from the backend at connect time and adds the relay to its ICE configuration. The relay forwards encrypted DTLS only; it never sees plaintext (see [`security-model.md`](security-model.md)). TURN provisioning is a backend concern (private backend docs); the peer just consumes the ICE server list it is handed.

## Remote frame cadence

For its own WebView the runtime coalesces the focused session to at most one frame per ~16ms. A remote controller on a higher-latency, metered link does not need 60fps, so the desktop peer applies a lower frame cap and watches the `term_live` channel's `bufferedAmount`: if it grows, coalesce harder (replace queued diffs, or send a fresh `Full`) rather than letting a queue build. This is the existing fall-behind discipline from the wire protocol, applied with the channel buffer as the backpressure signal.
