# Remote access: security and zero-knowledge model

> Session content is end-to-end encrypted between the user's own devices. The backend authenticates accounts and brokers the connection, but it cannot read terminal output or input, and it cannot silently man-in-the-middle a connection. This document is the threat model and the mechanisms that back the claim. It is public on purpose: an end-to-end-encryption claim is only credible if the client that performs it is open and auditable.

## What we promise, precisely

1. **The data plane is end-to-end encrypted.** Terminal frames and input flow over a WebRTC data channel secured by DTLS between the two devices. Our servers never see plaintext session content, including on the TURN fallback path, where the relay forwards only encrypted DTLS it cannot decrypt.
2. **The backend cannot silently impersonate or man-in-the-middle a device.** A malicious or compromised signaling server cannot substitute its own key into a connection without detection, because each device signs the WebRTC DTLS fingerprint in its offer/answer with a key the server never holds, and peers pin keys after first contact.
3. **Private keys never leave the device.** Each device generates its own keypair in the OS secure store; the backend only ever stores public keys.

What we do **not** promise, stated plainly so the trade-offs are honest:

- **Push notification content is not end-to-end encrypted** (see "The push-notification trade-off"). This is a deliberate UX choice.
- **Key distribution is trust-on-first-use.** The backend introduces device keys; a server that is actively malicious at the very first pairing of a device could in principle attempt a substitution. We pin on first use and alert on change to bound this to a single detectable moment, which is the same posture as SSH host keys and consumer end-to-end messengers.

## Background: how WebRTC encryption works, and the gap

WebRTC media and data channels are encrypted with DTLS. Each peer presents a self-signed certificate during the DTLS handshake, and the certificate is bound to the session by a fingerprint, a hash of the certificate, carried in the SDP as the `a=fingerprint` attribute (RFC 8122 §5; RFC 8827 §4.1 calls this the attribute "binding the communication to a key pair"). The DTLS handshake authenticates the presented certificate against that fingerprint, and an endpoint MUST tear down the session if they do not match (RFC 8842 §5.1). The data channel shares the same DTLS connection as everything else (RFC 8831 §6.1), so this protection covers our terminal stream directly.

The gap is the SDP itself. The fingerprint travels through the signaling server, which we operate. A signaling server that rewrites the SDP can substitute its own fingerprint and man-in-the-middle the "encrypted" channel. This is not a hypothetical; it is called out by name in the WebRTC security RFCs:

> "Even if HTTPS is used, the signaling server can potentially mount a man-in-the-middle attack unless implementations have some mechanism for independently verifying keys." (RFC 8827 §9.1)

> "Protecting against this form of attack requires positive authentication of the remote endpoint such as explicit out-of-band key verification (e.g., by a fingerprint) or a third-party identity service." (RFC 8826 §4.3.2)

So WebRTC gives us an encrypted channel for free, but closing the man-in-the-middle gap is our job, and the RFCs tell us exactly how: authenticate the fingerprint with a key the signaling server does not control.

## The mechanism: device keypairs, signed fingerprints, pinning

### Device keypairs

On first launch, each device (desktop and phone) generates a long-lived signing keypair. The private key lives in the OS secure store and never leaves the device:

- Desktop (macOS): the Keychain.
- iOS: the Keychain, via `expo-secure-store`.
- Android: the Keystore, via `expo-secure-store`.

The public key is registered under the account through the backend during sign-in. The backend stores public keys only; it has no access to any private key.

### Per-connection DTLS certificates are fine

The durable identity is the device signing key, not the WebRTC DTLS certificate. A WebRTC implementation may generate a fresh self-signed DTLS certificate per connection. That is acceptable because the connection's SDP carries the certificate fingerprint, and the device signs that fingerprint before the peer accepts the SDP.

Persisting a DTLS certificate is optional. It is not the security boundary. The boundary is: the device private signing key never leaves the OS secure store, and every connection's DTLS fingerprint is signed by that key and verified against the peer's pinned public key.

### Signing the fingerprint (the identity assertion)

During signaling, each offer and answer carries an identity assertion next to the SDP. The assertion contains:

- protocol version,
- account id,
- connection id / nonce,
- sender device id,
- intended peer device id,
- SDP role (`offer` or `answer`),
- DTLS fingerprint algorithm and bytes from the SDP, and
- a signature over those fields made with the sender's device private key.

The receiver verifies the assertion before accepting the remote description:

1. parse the fingerprint from the received SDP,
2. look up the sender's pinned public key for this account,
3. verify the assertion signature and connection binding,
4. confirm the signed fingerprint exactly matches the fingerprint in the SDP, and
5. reject replayed, expired, wrong-role, wrong-peer, or wrong-connection assertions.

If any step fails, the connection is refused before `setRemoteDescription` / `set_remote_description` advances. The WebRTC stack then verifies during DTLS that the peer presents the certificate matching the SDP fingerprint. Because the signing key is held only on the sending device and the backend never has it, the backend cannot rewrite the SDP to its own fingerprint and produce a valid assertion. It can relay the real assertion or drop the connection, but it cannot substitute one undetectably.

After the data channels open, both peers send a small `hello` on `ctrl` with the protocol version, device id, connection id, and the key id used for the assertion. This is not where fingerprint trust is first established; it is the point where the data channel leaves quarantine. No snapshot, command, input, terminal frame, or history row flows until both `hello`s match the already-verified signaling assertion.

This is, in the language of RFC 8827 §4.1 and §7, a **custom identity assertion**: the device key plays the role of the identity authority, the signature is the assertion binding key to fingerprint, and the verify step mirrors the mandatory check of RFC 8827 §7.9 ("verify that the in-use certificate for a DTLS connection is in the set of fingerprints returned from the IdP"). It is not an off-the-shelf named protocol, and it deliberately does not use the browser WebRTC Identity / IdP mechanism, which RFC 8827 §7 itself notes "has not been widely adopted or implemented." A first-party signed assertion between our own apps is the realistic, auditable way to get the same guarantee.

### Trust on first use, then pin

How does a device get the peer's public key in the first place? Through the account: both devices register their public keys with the backend, and a device fetches its peer's key when it first connects. This is trust-on-first-use (TOFU). After first contact, each device **pins** the peer's public key and alerts if it ever changes, exactly as SSH pins a host key:

> "It is possible for the browser to note a given user's public key and generate an alarm whenever that user's key changes. The Secure Shell (SSH) protocol uses a similar technique." (RFC 8826 §4.3.2.1)

> Equivalent to SSH, "which is vulnerable to man-in-the-middle attacks when two parties first communicate but can detect ones that occur subsequently." (RFC 8122 §7)

So the residual exposure is a backend that is malicious at the exact moment a device is first paired. Pinning collapses the attack surface to that single, detectable event; every subsequent connection is protected by the pinned key. This is the same trust model WhatsApp, Signal, and iMessage ship to billions of users.

One nuance works in our favor: RFC 8827's general objection to key continuity is about a browser trusting a peer name asserted by an untrusted website. Here both endpoints are our own first-party apps binding keys to an authenticated account, which is a stronger starting point than the general web case.

### Optional verification, for those who want it

For users who want to close even the first-contact gap, the apps offer a verification screen showing a short safety number (a hash of both device public keys) that the user can confirm matches on both devices, the Signal model and the out-of-band check RFC 8827 §6.5 describes. Most users never use it; its existence is what lets a security-conscious user, or an auditor reading the open client, confirm the guarantee end to end. A per-account setting can additionally require explicit approval of a new device from an already-trusted device before it can connect; default off for the smooth "sign in anywhere and connect" flow, available for those who want it on.

## Pairing flow (the UX, and why it is safe without a QR scan)

The product goal is: have the desktop running and signed in, download the mobile app anywhere, sign in, and connect. No QR scan, no being physically next to the machine. The account is the introduction mechanism:

1. The desktop is signed in and has registered its public key.
2. The user installs the mobile app, signs into the same account, and the app registers the phone's public key.
3. The phone sees the account's online desktops (presence) and connects. On first connection both devices pin each other's keys via the signed-fingerprint handshake above.
4. The already-trusted desktop surfaces a visible "new device added" signal, so a covert pairing cannot pass unnoticed.

This is account-mediated TOFU. It trades the QR scan's physical out-of-band channel for the standard consumer-messenger posture (pin and alert, optional verification). The data plane stays end-to-end encrypted either way; only the first-contact key-trust step differs, and it is bounded and detectable.

An account can have several desktops paired at once. Each desktop is an independently keyed device, pinned independently on the phone's first connection to it, and listed in the phone's desktop switcher via presence. Connecting to a desktop the phone has not reached before is a first-contact pin for that desktop; switching back to one it already pinned reuses the pinned key and alerts on change, exactly as for a single desktop. Revoking one desktop does not affect the others.

## Device revocation

Losing a phone must not mean losing session privacy. Devices are first-class records under the account:

- A user can list their devices and revoke any one from any other signed-in device.
- Revocation removes the device's public key from the account and tears down its sessions. A revoked device can no longer authenticate to the backend, cannot be reached via presence, and its pinned identity is dropped by the other devices.
- Revocation is active, not only next-connect cleanup. The backend tells the account's live desktop doorbells that the device roster changed. The desktop closes any active WebRTC connection to the revoked device and refuses further commands from it. If a peer is offline during revocation, the next connect still fails because the key is no longer active.
- Revoking the account password / re-authenticating does not by itself rotate device keys; revocation is the explicit, auditable way to cut a device off.

The backend account/device model and the revocation endpoints are in the private backend docs; the client behavior (pin, alert on change, drop a revoked peer) is the public half.

## The push-notification trade-off

Push notifications are intentionally **not** end-to-end encrypted, and we think that is the right call.

The hard end-to-end boundary is the session data plane: terminal output and input. Push notifications, by contrast, must pass through Apple (APNs) and Google (FCM) to wake a backgrounded phone, and they are far more useful with real content ("`refactor-auth` needs your input" beats "a session needs attention"). So push payloads carry context: the session name, its state, and a short summary. The cost is that our backend, Apple, and Google can see that notification content.

The line we hold: push payloads carry **context and short summaries, not raw terminal content**. A notification says a session named `refactor-auth` is awaiting input; it does not contain the code or the command output. Anything truly sensitive stays on the end-to-end data plane and is fetched only after the app opens the encrypted connection. (A future hardening is `mutable-content` plus a notification-service extension that decrypts an enriched payload on-device, but v1 keeps notifications plainly readable for reliability and simplicity.) The detail of payload shape lives in the private backend docs; the guarantee that matters publicly is that opting into rich notifications never moves session content off the end-to-end channel.

## The dangerous-mode guardrail, extended

Reverie's rule that dangerous / YOLO mode is explicit, opt-in, and never hidden behind defaults extends to remote access with one addition: **a remote device can never flip a session into dangerous mode.** Enabling dangerous mode is a local-only action on the desktop. A remote device may interact with a session that is already in dangerous mode (subject to product choice and possibly an additional confirmation), but the act of granting that elevated capability requires physical presence at the trusted machine. This keeps the most dangerous capability tied to the device that owns the agent, even as control surfaces multiply.

## What the backend can and cannot see

| The backend sees | The backend cannot see |
| --- | --- |
| Account identity (email, auth) | Terminal output or input (end-to-end encrypted) |
| Device public keys | Any device private key |
| Presence (which desktop is online) | Session content on the TURN fallback (encrypted DTLS) |
| Signed signaling blobs it cannot forge | Workspace contents beyond what a push summary states |
| Push triggers and notification summaries | The ability to MITM undetectably (signed fingerprints + pinning) |
| Subscription status | |

## Sources

WebRTC security architecture and the man-in-the-middle analysis: RFC 8827 (§4.1, §6.5, §7, §7.9, §9.1). Threats and defenses, including key continuity and the SSH analogy: RFC 8826 (§4.3.2, §4.3.2.1, §4.3.2.2). Certificate fingerprints and the TOFU caveat: RFC 8122 (§5, §7). Fingerprint-match-or-tear-down: RFC 8842 (§5.1). Data channel over the shared DTLS transport: RFC 8831 (§6.1). All at rfc-editor.org. The client-side `str0m` fingerprint APIs that implement the signing and verification are in [`desktop-peer.md`](desktop-peer.md).
