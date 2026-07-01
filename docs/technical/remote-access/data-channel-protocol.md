# Remote access: the data-channel protocol (the boundary)

> What flows between the desktop peer and the mobile client once the WebRTC connection is up. It is the same message set the desktop WebView already consumes, retargeted from Tauri transports onto WebRTC data channels. The binary terminal-frame encoding is reused byte-for-byte; only the transport changes.

This is the network analogue of [`../terminal/wire-protocol.md`](../terminal/wire-protocol.md). Read that first: the per-cell record, the frame encoding, the row-band encoding, and the generation rules are defined there and are unchanged here. This doc adds the channel layout, the control messages, and session multiplexing.

## Three channels

Once the peer connection is established, the desktop and phone open three WebRTC data channels. All three are reliable and ordered (`{ ordered: true }`, no `maxRetransmits`) because a dropped frame diff, command, or row band corrupts state. WebRTC data channels are SCTP over the shared DTLS transport, so all channels inherit the end-to-end encryption (see [`security-model.md`](security-model.md)).

- **`ctrl`**: reliable, ordered, bidirectional, JSON. The control plane: the data-channel hello, the workspace snapshot, activity/state events, session commands, input, session selection, control leases, resize requests, and history-range requests. Small messages, low rate.
- **`term_live`**: reliable, ordered, desktop-to-phone, binary. The live terminal stream for the controlled session. It carries only existing `TerminalFrame` messages (`kind = 1`), each prefixed with the session id.
- **`term_history`**: reliable, ordered, desktop-to-phone, binary. History-range row-band replies for explicit `history_request`s. It carries only existing row-band messages (`kind = 2`), each prefixed with the session id and request id.

Splitting binary from JSON keeps the hot frame path free of any JSON parsing and lets the renderer decode terminal messages straight into typed arrays, exactly as the desktop does today. Splitting live frames from history replies avoids a large row-band response blocking keystroke feedback or live output behind ordered delivery on one SCTP stream. The `ctrl` channel carries everything else.

## One connection, one desktop

A WebRTC connection is to exactly one desktop. The desktop is chosen during signaling, before any data channel exists: the phone reads the account's desktop list from the backend and addresses its offer to a specific desktop's device id. Everything on the resulting connection, the `snapshot`, the activity, the controlled session, belongs to that one desktop.

An account can have several desktops online at once. The phone holds a connection to the one it is actively viewing and switches desktops by tearing this connection down and opening a new one to another. There is no cross-desktop multiplexing inside a single connection; listing or switching desktops is a backend query and a fresh handshake, not a data-channel message. See [`overview.md`](overview.md) for the model and [`mobile-client.md`](mobile-client.md) for the switching UX.

## Why reuse the existing encoding verbatim

The desktop already produces `TerminalFrame` bytes for its own WebView and serves binary row bands for `read_terminal_rows`. The mobile client already needs to decode that format. So the shared TypeScript `wireDecode` module (see [`mobile-client.md`](mobile-client.md)) is the single decoder for both the desktop WebView's Tauri Channel and the phone's terminal data channels. One encoder on the desktop, one decoder shared across both clients, one format. The wire-protocol doc's note that "the decoder is shared between the Tauri Channel path and the harness bridge's transport" extends to the WebRTC data channels, with no format change.

## `term_live` channel: framing

Each `term_live` message is one existing wire-protocol frame message (`kind = 1`) prefixed with the session it belongs to, so the client can discard bytes for a session it has already switched away from:

```
session_id_len  u8
session_id      u8[session_id_len]   // ascii session id
payload         ...                  // exactly the wire-protocol.md frame bytes (kind 1)
```

The `generation` rules are unchanged and still live inside the payload: the client tracks the latest generation per session, a `Full` frame rebuilds the mirror, an older generation is dropped, and a resize bumps the generation and is followed by a `Full`. Because only one session is controlled at a time (see multiplexing), the prefix is mostly a guard against a stale release or switch racing an in-flight frame.

## `term_history` channel: framing

Each `term_history` message is one existing row-band reply (`kind = 2`) prefixed with the session and the request id that produced it:

```
session_id_len  u8
session_id      u8[session_id_len]   // ascii session id
request_id      u32                  // matches ctrl.history_request.id
payload         ...                  // exactly the wire-protocol.md row-band bytes (kind 2)
```

The phone drops a history reply when the request id is no longer active, the selected session changed, or the row-band generation no longer matches the latest `Full` frame for that session. History is a background top-up, never part of the live-output latency path.

## `ctrl` channel: messages

JSON, one object per message, every message has a `t` (type) field. Sizes are tiny and the rate is low, so JSON is fine here (the same reasoning the desktop uses for its low-rate lifecycle/title/bell events).

### Handshake (on connect, before anything else)

- `hello` (both directions): protocol version, device id, connection id, and the peer key id that already passed the signed SDP-fingerprint assertion during signaling. Defined in [`security-model.md`](security-model.md). No session data, commands, input, snapshots, or terminal bytes flow until both `hello`s verify and the connection leaves quarantine.

### Desktop-to-phone

- `snapshot`: the full workspace snapshot the phone renders as the dashboard. Projects, focuses (topics), sessions, and each session's latest activity state. This is the same `WorkspaceSnapshot` the desktop frontend loads at boot, serialized to JSON.
- `activity`: an incremental activity/state change for one session (`fresh`, `working`, `finished`, `idle`, `awaiting_response`, `awaiting_permission`, `error`, with the state timeline). The same `session_activity_changed` event the desktop emits, forwarded. Drives both the dashboard dot and, on the backend side, push triggers.
- `session_event`: lifecycle for the selected or controlled session (`stream_started`, `exit`, `failed`, title change, bell), mirroring the desktop's low-rate JSON terminal events.
- `control_state`: current control lease state for a session. Sent when the phone takes control, releases control, disconnects during a lease, or the desktop user reclaims control. `{ session_id, state: "idle" | "controlled" | "reconnecting" | "reclaimed", controller_device_id?, controller_name?, cols?, rows?, generation?, reclaimable }`.
- `command_result`: the ack/result of a phone-issued command, correlated by the `id` the phone sent.

### Phone-to-desktop

- `select_session`: "open session X on the phone." This selects the session for metadata, events, and control UI. It does not resize the PTY and does not start terminal streaming by itself.
- `take_control`: `{ id, session_id, cols, rows, cell_width_px, cell_height_px }`. The phone asks to become the controller for the session. The desktop grants it only if no other remote device or local reclaim owns the lease, saves the previous desktop geometry, calls the existing resize path for the PTY and `libghostty`, emits `control_state: controlled`, and starts `term_live` with a fresh `Full` frame at the new generation.
- `release_control`: `{ id, session_id }`. The phone releases the lease. If the desktop has a visible terminal for that session, it resizes back to the saved desktop geometry and emits a generation-bumped `Full` locally. If there is no visible local terminal, it may keep the last geometry until the session is focused again.
- `control_heartbeat`: `{ session_id }`. Sent while the phone is foregrounded and controlling. If the WebRTC link drops, the desktop marks the lease `reconnecting` for a short grace period instead of immediately resizing back, so a transient mobile reconnect does not cause repeated reflow. When the grace period expires, the desktop releases the lease.
- `input`: `{ session_id, data }` where `data` is the UTF-8 encoded keys/paste, identical to the `write_terminal_input` payload. Reliable and ordered, so keystrokes are never dropped or reordered.
- `history_request`: `{ id, session_id, start_id, count, generation }`, the `read_terminal_rows` request as a message. `id` is a per-connection `u32` chosen by the phone. The desktop replies with a binary row band on `term_history` and may also send a `command_result` ack with the request `id`.
- `session_command`: start, stop, resume, archive, and create operations, forwarding an allowlisted subset of the existing `WorkspaceService` command surface. `{ id, op, args }`, acked by `command_result`. Subject to the dangerous-mode guardrail in [`security-model.md`](security-model.md).

## Session multiplexing: one controlled stream

The phone controls one session at a time, which matches the single-geometry reality of the PTY and `libghostty`. The model:

- The `snapshot` and `activity` messages keep the **whole dashboard** live at all times, cheaply: they are small JSON and they are how the phone shows every session's state without streaming any terminal.
- Exactly one session is the **controlled stream** at a time. `select_session` opens it; `take_control` starts streaming it. Only the controlled session sends `term_live` frames. Taking control sends a fresh `Full` frame after the resize, so the phone always starts from a coherent screen at its own geometry.

This is why the design needs no per-session frame channel and no multi-session fan-out: the expensive thing (frame streaming) is singular and follows the user's controller lease, while the cheap thing (dashboard state) is always-on. It is the network expression of how the desktop already throttles background terminals to near-nothing.

## Who controls size

The terminal grid is owned by the active controller. In local desktop use, the desktop window owns it. In mobile use, taking control from the phone owns it. The phone chooses a readable mobile grid from its available terminal area and sends that grid in `take_control`; the desktop applies it to the single PTY and `libghostty` state.

This does not render a scaled desktop-sized terminal. `libghostty-vt` models one terminal state at one cell geometry; its public resize operation changes that state and reflows primary-screen content. The current Rust wrapper and C ABI expose `Terminal` dimensions (`cols`, `rows`) and `RenderState` snapshots derived from that one terminal state, not multiple simultaneous frame sizes for one PTY. A second `libghostty` instance at phone size would have to be fed the same output bytes, but that is not equivalent for interactive TUIs because the process itself only sees one PTY size and can redraw based on that size.

So mobile control is an explicit resize of the real terminal. It must be user-visible, must bump the generation exactly like a desktop resize, and must hand geometry back to the desktop when the lease ends or the desktop user reclaims it. While mobile holds the lease, the desktop frontend shows a controlled-by-mobile state instead of rendering the terminal at a competing size.

## Rules that keep it fast (carried over)

The wire-protocol rules apply unchanged, and matter more across a cellular link than across the local Channel:

- **Binary frames, JSON only for control.** Cell data is bytes.
- **Diffs on the steady path, a `Full` only on take-control/resize/resync.**
- **Coalesce harder for a remote controller.** The desktop already collapses a burst to one frame per ~16ms for the focused session; for a remote controller on a metered, higher-latency link it throttles further (a lower frame cap), since a phone does not need 60fps and the bandwidth is not free. Exact remote cadence is a desktop-peer tuning parameter, not a protocol change.
- **Prefetch history, never poll.** `history_request` is a background top-up when the phone's mirror runs low, not a per-scroll round trip.
- **Keep history off the live stream.** Row bands ride `term_history` so a deep scrollback fetch cannot head-of-line block live frames on `term_live`.
- **Bound the work.** If the data channel backs up (a slow link), replace queued diffs with a newer combined diff or a fresh `Full`, never grow an unbounded queue. This is the existing fall-behind rule, and the WebRTC `bufferedAmount` on the data channel is the signal to apply it.

## Resync after a reconnect

Mobile connections drop (backgrounding, network change). After the handshake re-completes, the phone:

1. requests a fresh `snapshot` (the dashboard may have changed while it was away),
2. re-opens its previously active session,
3. if the previous control lease is still in the reconnecting grace period, resumes it and receives a `Full` frame at the current generation; otherwise asks the user to take control again,
4. re-issues any history range it still needs against the new generation.

There is no attempt to replay missed diffs across a disconnect. A `Full` snapshot of current screen state is cheaper and always correct, which is the same discipline the wire protocol uses for falling behind. This is the screen-state-sync model (sync the current screen, fetch history on demand), not a byte-log replay.
