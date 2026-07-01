# Remote access (mobile companion)

Durable design docs for reaching a running Reverie desktop from a phone. The desktop keeps running the agents; the phone is a remote control surface. The connection is peer-to-peer WebRTC, end-to-end encrypted, brokered by a backend that can never read session content.

These docs describe the **public, client-side** half of the feature: what the open-source desktop and mobile apps do, the protocol that flows between them, and the security model. The **backend** (the signaling, auth, push, TURN, and billing service) is proprietary and documented separately in a private repository. The split is deliberate and it follows the Signal posture: the client that does the encryption is open and auditable, the hosted service is the business.

## The one principle

**The desktop is the source of truth; the phone is a remote controller.** Sessions, PTYs, `libghostty` state, scrollback, native session ids, hooks, and the SQLite workspace all live on the desktop exactly as they do today. The phone never runs an agent, never owns a PTY, and never holds authoritative state. When the user takes control of a session from the phone, the desktop resizes that session's single PTY and `libghostty` state to the phone's grid, streams the reflowed terminal to mobile, and shows a local "controlled by another device" state instead of continuing to render the terminal. Every action the phone takes (take control, send a message, start a new session, release control) is forwarded to the desktop and reflected back.

## What crosses, and what does not

- **Crosses (peer-to-peer, encrypted):** terminal frames, terminal input, the workspace snapshot, activity/state events, and session commands. This is the same message set the desktop WebView already consumes, retargeted from Tauri transports onto WebRTC data channels.
- **Never crosses our servers:** any session content. The data plane is direct device-to-device. On the fallback relay (TURN), the bytes are still end-to-end-encrypted DTLS the relay cannot read.
- **The backend only ever sees:** account identity, device public keys, presence (which desktop is online), encrypted/signed signaling blobs it cannot tamper with undetected, push-notification triggers, and subscription status.

## Docs

- [`overview.md`](overview.md): the architecture at the contract level: WebRTC-primary, the doorbell signaling model, the connect flow, the scope, and how it maps onto the existing terminal pipeline. Start here.
- [`data-channel-protocol.md`](data-channel-protocol.md): the boundary: the control, live terminal, and history data channels, the message set, how the existing binary frame encoding is reused unchanged, and how sessions are selected and multiplexed.
- [`security-model.md`](security-model.md): the zero-knowledge threat model: device keypairs, trust-on-first-use with key pinning, the signed-DTLS-fingerprint defense against a malicious signaling server (RFC 8827), device revocation, and the deliberate push-notification trade-off.
- [`desktop-peer.md`](desktop-peer.md): the Rust side: the `str0m` WebRTC peer embedded in the Tauri app, how it wires into the existing terminal runtime, and the fingerprint-pinning implementation.
- [`mobile-client.md`](mobile-client.md): the React Native (Expo) app: the Skia terminal renderer, the shared TypeScript protocol package, and the iOS background-and-reconnect lifecycle.

## Guardrails carried over

- **Never require git, never become an IDE, never render terminal cells as DOM.** The phone renders the same `TerminalFrame` model the desktop does, into a Skia canvas island, not React elements.
- **Dangerous / YOLO mode stays explicit and is never remotely enableable.** A remote device can use a session that is already in dangerous mode (subject to product choice), but it can never flip a session into it. See [`security-model.md`](security-model.md).
- **Local-first holds.** No session content is stored in the cloud. The backend is a thin control plane, not a sync backend. The desktop app remains usable without an account; an account is required only for the optional mobile companion.
