# Remote access: architecture overview

> The desktop runs the agents and stays the source of truth. The phone is a remote control surface that reaches the desktop over a direct, end-to-end-encrypted WebRTC connection. A small backend authenticates the two devices and brokers the connection handshake, then gets out of the way. Session content never transits our servers.

This is the contract-level view. The backend implementation is private; everything here is about the open client and the guarantees it relies on.

## Why this shape

Three forces pick the architecture:

1. **The agents already run on the desktop, and resume is the CLI's job.** Reverie's whole model is local-first: folders are projects, sessions are CLI processes the desktop owns, and history lives in `libghostty`'s in-memory buffer. A phone cannot own a PTY across the network. So the phone is a remote controller: it asks the desktop to take over a session, the desktop resizes the one real PTY to the phone's grid, and all output and input still flow through the desktop runtime.

2. **We want it to feel instant, and we want it cheap.** A direct peer-to-peer link gives the lowest latency and keeps session bytes off our servers, which keeps cost low and keeps the privacy story honest. WebRTC is the proven tool for direct, NAT-traversing, encrypted peer connections.

3. **The privacy claim has to be real.** Reverie is local-first and the desktop client is open source. A remote-access feature that routed your terminals through a server we operate would undercut that. WebRTC's DTLS gives end-to-end encryption by construction, even when a relay is involved, so we can offer remote access without becoming a place that can read your work.

## The pieces

- **Desktop peer** (open source, in the Tauri app): a WebRTC peer built on the Rust `str0m` library, wired directly into the existing terminal runtime. It holds one always-on outbound connection to the backend (the "doorbell," below) and, once a phone takes control of a session, resizes that session and streams frames over a direct data channel. See [`desktop-peer.md`](desktop-peer.md).
- **Mobile client** (open source, React Native + Expo): renders the workspace dashboard, opens one session at a time, takes control of that session's terminal geometry, sends input, and starts sessions. Reuses the desktop's TypeScript wire-decode logic as a shared package and renders the terminal with `react-native-skia`. See [`mobile-client.md`](mobile-client.md).
- **Backend** (proprietary, documented privately): authenticates accounts and devices for the optional mobile feature, tracks presence, brokers the WebRTC signaling handshake, sends push notifications, issues short-lived TURN credentials, and gates access on subscription. It is a thin control plane, and it never sees session content.

## The doorbell: why the desktop holds a connection

The single non-obvious piece of the design is that the desktop holds a persistent, mostly-idle connection to the backend. It is worth being precise about why, because it is easy to assume polling would do.

The connection exists for exactly one job: **letting the backend reach the desktop instantly when a phone wants to connect.** To start a WebRTC link, the phone produces an offer and ICE candidates, and the desktop must receive them, answer, and trade candidates back, all before any session data flows. The desktop is sitting idle in the background; it has no way to know a phone wants in unless something tells it. The options:

- **Held connection:** the backend pushes "a phone wants to connect, here is the offer" the instant it arrives. Connect feels immediate.
- **Poll every 60s:** up to a 60-second wait before the desktop even starts answering. Unusable.
- **Poll every 1-2s:** sluggish, and every online desktop now hammers the backend forever, which costs more and drains the machine more than one idle socket would.
- **Push to the desktop (APNs-to-Mac):** awkward and throttled for a direct-download app, not reliable for instant connect.

So the held connection is a doorbell, not a data pipe. It is idle almost always, then carries a handful of tiny signaling messages during a connect, then goes quiet. The terminal data never touches it; that is the direct peer-to-peer channel. Presence ("is this desktop online?") falls out for free: the socket being open is the signal.

The counterintuitive payoff: the backend holds these idle connections cheaply, so the doorbell is both the thing that makes connect instant and the cheap option (the mechanism and cost analysis live in the private backend docs). The client only needs to know it holds one outbound connection and re-establishes it on drop.

## The connect flow

A phone opening a session, end to end:

1. **Both devices are signed in for remote access.** The desktop core does not require an account, but a desktop that wants to be reachable from mobile authenticates to the backend on launch and holds its doorbell connection. The phone authenticated when the user signed in. Both registered a device public key under the account (see [`security-model.md`](security-model.md)).
2. **The phone connects to a desktop.** It asks the backend for the account's desktops and their presence and connects to the active one, chosen automatically (the desktop a tapped notification targets, else the last-used, else the only online one). The app never opens to a chooser; the full list is only for switching. An account can have several desktops signed in at once (see "Multiple desktops" below).
3. **Signaling handshake.** The phone creates a WebRTC offer and sends it to the backend; the backend pushes it down the chosen desktop's doorbell connection; the desktop answers; ICE candidates trickle both ways through the backend. Each side signs its DTLS fingerprint with its device key so the backend cannot substitute its own and man-in-the-middle the link (see [`security-model.md`](security-model.md)).
4. **Direct connection forms.** ICE finds a direct path most of the time. When it cannot (often on cellular carrier-grade NAT), it falls back to a TURN relay, which forwards only encrypted DTLS it cannot read. Either way the data channels open and the backend is no longer in the path.
5. **Session control.** Over the data channels the phone receives the workspace snapshot and live activity. The user opens a session, then takes control. The phone sends its desired terminal grid, the desktop saves the previous local geometry, resizes the session's PTY and `libghostty` state, swaps the desktop UI into a controlled-by-mobile state, and starts streaming a fresh `Full` frame at the mobile geometry. Input and commands flow back over the same channels.

When the phone is backgrounded or the network changes, the connection drops (this is normal mobile behavior, especially on iOS). The phone re-runs the handshake on foreground and resyncs. Push notifications, sent by the backend when a session needs attention, are what bring the user back. See [`mobile-client.md`](mobile-client.md) for the lifecycle and [`security-model.md`](security-model.md) for what a push may contain.

## Multiple desktops

A user can have several desktop apps signed into one account at once (a studio Mac, a laptop). The model is Slack workspaces: the app lands directly in one desktop and the others are a swipe away in a slide-out drawer, never a chooser on open. The mechanics keep this cheap:

- **Listing is a backend query, not many connections.** The backend already knows every online desktop from the doorbell each one holds, so the phone gets the full list of the account's desktops, with online/offline state, from a single lightweight request. It does not open a WebRTC connection to each desktop to populate the list.
- **One active connection at a time.** The phone holds a direct WebRTC connection to the one desktop it is currently viewing (the active desktop). That desktop's workspace snapshot, session dashboard, and controlled terminal all belong to it.
- **Switching is a quick reconnect.** Picking another desktop tears down the connection to the current one (releasing any control lease through the normal grace path) and runs the signaling handshake against the chosen desktop, which loads its snapshot. There is no cross-desktop session merge inside one connection; the phone always looks at exactly one desktop.

Holding simultaneous connections to every desktop was considered and rejected for v1: it multiplies battery and peer-connection overhead on the phone, drops on iOS background anyway, and buys little, since a person controls one machine at a time. The switcher UX is in [`mobile-client.md`](mobile-client.md).

## Scope

Built properly from the ground up, not staged as a thin beta:

- A dashboard of all sessions across the workspace with live state (the same activity model the desktop home uses).
- Control one live session at a time. This is not a cut: `libghostty-vt` and the PTY have one active geometry, and a phone shows one terminal at a time anyway. "Take control of session X" maps onto the existing resize path and active-versus-background frame emission.
- Send input and messages into a session.
- Start brand-new sessions remotely (forwarding the existing `create_session` / `start_session` service calls).
- Push notifications when a session needs input, finishes, or asks for permission (driven by the existing activity/hook signals).
- Device management and revocation.

Deliberately not in scope: multiple concurrent controllers for the same terminal, multiple simultaneous frame sizes for the same PTY, and any cloud storage of session content (local-first holds).

The default mobile session UX is not a scaled desktop terminal. A session opens into a control-ready view, and taking control resizes the single PTY to a mobile grid. The desktop does not continue rendering an old desktop-sized terminal while mobile controls it; it shows a controlled-by-mobile state with a reclaim action.

## How it maps onto what already exists

The reason this is tractable: almost every seam already exists, the feature mostly re-targets transports.

| Need | Already in the codebase | What remote access adds |
| --- | --- | --- |
| Stream a terminal | Binary `TerminalFrame` diffs over a Tauri Channel (`terminal/wire-protocol.md`) | The same bytes over a WebRTC live data channel |
| Fetch scrollback | `read_terminal_rows` request/reply, binary row bands | The same request/reply as messages, with row bands on a separate history data channel |
| Send input | `write_terminal_input` command | The same payload as a data-channel message |
| Know session state | Correlator + activity model, JSON events | Forwarded over the data channel; also drives push |
| One active terminal | Active-vs-background emission and resize in the runtime | "Take control" picks the active stream and applies the phone geometry |
| Start / resume sessions | `WorkspaceService` command surface | Forwarded over the data channel |
| Workspace structure | SQLite `WorkspaceRepository` (desktop-only writer) | Snapshot sent to the phone; desktop stays sole writer |

The two genuinely new pieces of engineering are the `str0m` WebRTC peer inside the Tauri app (see [`desktop-peer.md`](desktop-peer.md)) and a transport abstraction so frame and event emission are not hardcoded to Tauri's Channel and `AppHandle.emit`. The rest is the existing message set flowing over a new pipe.

## Source of truth and conflict avoidance

The desktop remains the **sole writer** of workspace state and terminal geometry. The phone never writes to a database; it sends commands and renders snapshots and events. While the phone holds the control lease for a session, the desktop deliberately gives that session's terminal geometry to the phone. There is no peer-to-peer state merge, no offline workspace editing on the phone, no second source of truth to reconcile.

This keeps "local-first" honest while allowing the optional mobile companion. A user can use the desktop app without signing in. Signing in is required only to broker remote access, because the backend must introduce devices, route signaling, send push notifications, issue TURN credentials, and enforce subscription state. The cloud holds control-plane facts (accounts, device keys, push tokens, subscription), never session content or workspace data.
