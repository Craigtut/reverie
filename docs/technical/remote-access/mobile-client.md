# Remote access: the mobile client (React Native + Expo)

> The phone app is a React Native (Expo) client that renders the workspace dashboard, opens one session at a time, takes control of that session, sends input, and starts sessions. It reuses the desktop's TypeScript wire-decode logic as a shared package and renders the terminal into a `react-native-skia` canvas, not React DOM. It is open source, because the end-to-end-encryption claim is only credible if the client that does the encryption is auditable.

## Stack

- **Expo with a development build**, not Expo Go. The app needs native modules (WebRTC, Skia, secure storage), so it uses Continuous Native Generation: config plugins plus `expo prebuild`, built with EAS, run via `expo-dev-client`. "Eject" is not a thing anymore; this is the supported way to use arbitrary native code while keeping Expo tooling and over-the-air updates. Expo Go cannot run it because of the custom native modules.
- **TypeScript** throughout.
- **expo-router** for navigation.
- **zustand** for state, matching the desktop frontend.
- **react-native-webrtc** (124.x) for the peer connection and data channels, via the community config plugin `@config-plugins/react-native-webrtc`.
- **@shopify/react-native-skia** (2.6.x) for the terminal renderer, with `react-native-reanimated` and `react-native-gesture-handler` for UI-thread drawing and scroll gestures.
- **expo-secure-store** for the device private key and the session token.
- **expo-notifications** for push registration and handlers (using the native APNs/FCM token, not Expo's push service).

### react-native-webrtc notes

- It does not run in Expo Go; it needs the config plugin + a development build. The plugin writes the iOS usage strings and Android permissions and raises `minSdkVersion`. It requests camera/mic permissions unconditionally (it is a generic WebRTC plugin); for our data-only use iOS will not actually prompt unless we call `getUserMedia`, but a leaner Android permission set would need a custom plugin.
- Data channels are fully supported: `createDataChannel(label, { ordered: true })`, with `ordered`, `maxPacketLifeTime`, `maxRetransmits`, `negotiated`, `protocol`, `id` on the channel. We use reliable, ordered channels only (see [`data-channel-protocol.md`](data-channel-protocol.md)).
- New Architecture caveat: react-native-webrtc has no shipped TurboModule/Fabric build yet and works under the New Architecture only via the interop compatibility layer. It runs fine today; the risk is future RN versions dropping interop. Track the library's `new-arch` work when pinning RN.

## The shared protocol package

The desktop WebView already decodes the binary `TerminalFrame` and row-band format and maintains a viewport row mirror. That logic (`wireDecode`, the buffer model, the history-range fetch logic) is extracted into a shared TypeScript package consumed by both the desktop `web/` frontend and this app. One decoder, one buffer model, one format, three transports (Tauri Channel, harness bridge, WebRTC data channel). This shared package is the concrete payoff of choosing React Native over a separate-language mobile stack: the correctness-sensitive protocol code is written and tested once.

What is **not** shared is the renderer. The desktop uses a WebGL2 glyph-atlas renderer; the phone uses Skia. Both consume the same decoded `TerminalFrame` model. The guardrail holds on both: terminal cells are never React DOM, always an imperative canvas island.

## The Skia terminal renderer

A terminal is a grid of fixed-advance monospace cells with per-cell foreground glyph and background color, plus a cursor and selection. The phone does not scale a desktop-sized grid. When the user takes control, the app computes a readable terminal grid from the actual mobile terminal area (safe area, header, composer, keyboard state, and chosen mobile cell metrics), sends that grid in `take_control`, and renders the reflowed frames the desktop emits after resizing the single PTY and `libghostty` state.

The approach, grounded in how `react-native-skia` performs:

- **Draw imperatively on the UI thread, bypass the React reconciler.** Do not render 2,000 declarative `<Rect>`/`<Glyphs>` JSX elements and reconcile on every diff; that is the main performance trap. Build the scene with the imperative node API and mutate it inside Reanimated worklets on the UI thread. This is the technique `react-native-skia-list` demonstrates sustaining 120fps on 1,000 text rows (vs multi-thousand-millisecond FlatList renders); treat that library as proof of technique, not a dependency.
- **Batch a whole row's glyphs into one node.** Load the monospace font once at the cell size with `useFont`, take one advance width via `getGlyphWidths(getGlyphIDs("M"))`, and place each cell's glyph at `x = col * advance`, `y = row * lineHeight + baseline` (baseline from `getMetrics`). Use the `Glyphs` component or a `TextBlob` per row, so the grid is ~40 text nodes, not thousands of draws. Merge runs of same-background cells into wide rects; draw the cursor and selection as cheap overlay rects.
- **No glyph atlas yet.** For the mobile viewport, Skia's internal GPU glyph cache should be enough. An atlas is premature; add one only if device profiling shows text rasterization dominating frame time. (The desktop needs its WebGL atlas because it paints far larger grids at 60fps; the phone does not.)
- **Virtualization is inherent.** Skia is immediate-mode: you draw what you choose to draw. Paint the controlled terminal grid and the scrollback rows needed for the current scroll position plus a little overscan. The data side already matches this: live diffs cover the controlled viewport, `history_request` tops up older rows on demand. There is no list component and no DOM virtualization; the "which rows do I paint" decision lives in the draw code. Do not reach for a `FlatList`/`ScrollView` of cells, the mobile version of the never-render-cells-as-DOM rule.

Pitfalls to design around: keep the `SkFont` loaded once and reused (per-cell `useFont` is pathologically slow); the diff-apply and scroll logic must be worklet-safe because they run on the UI thread; scale any offscreen text snapshots by the device pixel ratio or they blur.

Mobile control model:

- **Open session.** The user picks a session from the dashboard and sees session state plus the primary action to take control. This does not start a scaled desktop terminal view.
- **Take control.** The app sends `{ cols, rows, cell_width_px, cell_height_px }` based on the mobile terminal area. The desktop grants a control lease, resizes the real PTY, sends a generation-bumped `Full`, and shows a controlled-by-mobile state locally.
- **Control session.** The phone renders the terminal at its own grid and sends input. Scroll pulls history on demand against the active generation.
- **Release or reclaim.** Leaving the session, pressing release, desktop reclaim, or lease expiry ends control. The desktop can restore its saved geometry when the local terminal is visible.

## The connection and the iOS lifecycle

This is where the mobile reality bites, and the design has to respect it rather than fight it.

### Foreground: stream freely

While the app is open and on screen, the WebRTC connection is live and control works normally. There is no constraint here; a live remote terminal in the foreground is exactly what WebRTC is good at.

### Background: the connection drops, by design

When the user leaves the app (locks the phone, switches apps), iOS gives a short grace window and then suspends the app: the process runs no code, the JS thread stops, and open sockets including the WebRTC peer connection drop. This is not specific to us; it is how iOS treats every app without a sanctioned background mode, and a data-channels-only app does not qualify for the VoIP/audio/location exceptions (and should not pretend to). The react-native-webrtc maintainers are explicit: staying alive in the background needs the VoIP/CallKit path, which our use does not warrant, so the correct pattern is to tear down on background and reconnect on foreground.

So the client treats a backgrounded connection as gone. It does not try to hold it open. If it currently controls a terminal, it sends `release_control` before backgrounding when possible. If the OS suspends it before the clean release lands, the desktop lease moves to `reconnecting` for a short grace period and then expires. (Android is more lenient via a foreground service, but the design targets the iOS constraint and lets Android benefit.)

### Push to wake, reconnect on foreground

Because the app cannot hold a connection in the background, push notifications are what bring the user back:

- The backend sends a **user-visible alert push** (not a silent one) when a session needs attention. Alert pushes display even when the app is suspended or force-quit; the user taps it, the app foregrounds, and the reconnect runs.
- Do **not** architect reconnection on silent (`content-available`) pushes. Apple does not guarantee their delivery, throttles them to roughly one or two an hour, suppresses them in Low Power Mode, and never delivers them to a force-quit app. They are unreliable as a wake mechanism by Apple's own description. The reliable path is the visible alert the user acts on.
- On foreground (whether from a tap or the user just reopening the app), the client re-runs the WebRTC handshake and resyncs per [`data-channel-protocol.md`](data-channel-protocol.md): fresh snapshot, re-open the active session, resume the control lease if it is still in the reconnecting grace period or ask the user to take control again, then re-request any needed history. No missed-diff replay; current screen state is cheaper and always correct.

### Push registration with expo-notifications

Use `expo-notifications` for the permission prompt, the native-token acquisition, and the foreground/tap handlers, but send through our own backend with the **native** token, not Expo's push service:

- `getDevicePushTokenAsync()` returns the native APNs/FCM token. Ship it to the backend, which stores it against the device and sends directly via APNs/FCM (see the private backend docs). Do not use `getExpoPushTokenAsync()`.
- Handlers: `setNotificationHandler` (foreground presentation), `addNotificationResponseReceivedListener` (the tap that triggers reconnect), and the background task registration for any silent-push use. The WebRTC reconnect logic lives in the response handler and the normal foreground lifecycle, not in a background task trying to hold a connection.
- iOS config: the `expo-notifications` plugin injects the push entitlement and capability; `aps-environment` is "development" in dev builds and flips to "production" on a release archive.

## What the app shows

- **Desktops:** the app opens straight into a desktop, never a chooser. Switching is a slide-out drawer (a hamburger from the edge) listing every desktop by name with online/offline state and an optional attention badge, the way you swap Slack workspaces. You live in one desktop; the rest are one swipe away. See below for the selection and switching rules.
- **Dashboard:** every session on the **active desktop** with its live activity dot, from that desktop's always-on `snapshot` + `activity` messages. Cheap, no terminal streaming.
- **Session view:** one selected session's control surface. The user takes control, the terminal reflows to the phone grid, and the Skia terminal plus input box / message composer send `input`. Scroll pulls history on demand.
- **Start a session:** forwards `create_session` / `start_session` to the desktop via `session_command`.
- **Devices and account:** list and revoke devices (see [`security-model.md`](security-model.md)), and the account/subscription surface (subscription is purchased on the desktop or web, never in this app; see the private backend docs for why).

## Multiple desktops and switching

The model is Slack workspaces: you default into one desktop and swap between them, never a landing screen that makes you choose.

- **Always open into the active desktop.** On launch the app connects directly to one desktop and shows its dashboard; it never opens to a picker. With a single desktop this is invisible, the app just connects to it.
- **Smart default selection.** The active desktop on open is, in priority: the desktop a tapped notification targets (below), then the last-used desktop, then the only online one, then the most recently online. The user picks only when they want to switch.
- **A push deep-links and auto-switches.** A notification is tied to a specific desktop and session (the payload carries both; see the private backend docs). Tapping it opens the app, makes that desktop the active one (reconnecting if a different desktop was active), and opens the session the push was about. So "Studio: refactor-auth needs input" lands you in Studio's session even if you were last in MacBook.
- **Switching is a slide-out drawer.** A hamburger drawer from the edge lists every desktop by name with its online/offline state and an optional attention badge. Picking another tears down the current connection (releasing any control lease via the reconnecting grace path on the old desktop) and reconnects to the chosen one, swapping the dashboard. It is the one place the whole view swaps, and it takes the same second or two as the first connect.
- **The list is cheap and always-current.** It comes from a single backend roster query, not a connection to each desktop, so the drawer shows them all without draining the battery. Offline desktops appear but are not connectable, since the agents live on the machine and it must be awake. Tapping one surfaces that state rather than spinning.
- **Each desktop has a name.** Defaulted from the machine name, editable, so the drawer reads "Studio," "MacBook," not opaque ids.

## Platform scope: native iOS and Android, web deferred

The client targets native iOS and Android via Expo. A React Native Web target was considered, mainly because it would let agents develop and debug the UI in a browser (the mobile analogue of the desktop's `dev:harness`), and possibly serve a public web app. It is a v1 non-goal, deferred deliberately. The research conclusion, kept here so it is not re-litigated:

- It is feasible. The two heavy subsystems have real web implementations: `react-native-skia` runs on web via CanvasKit (Skia compiled to WASM), and WebRTC data channels are a browser-native API (`react-native-webrtc` has no web support, so web would use the browser stack directly through a thin platform alias). The signed-fingerprint pinning defense works in the browser too.
- But it carries real unknowns and degradations: a multi-megabyte CanvasKit WASM cold start and main-thread-only rendering (web has no UI thread, so the per-frame draw budget for the cell grid is unproven), no Keychain (the device key would fall back to a non-extractable Web Crypto key in IndexedDB, which W3C describes as obfuscation, not hardware-grade protection), no `expo-notifications` on web (push becomes a separate Push API + service-worker path, on iOS only as an installed PWA), and the maintenance cost of a third target.

If revisited, the cheapest first step is the dev/debug surface (agents iterating in a browser) behind a native verification gate, since a web-green build does not prove native layout, gestures, or motion. Shipping a public web product is a larger, separate decision, gated on a performance spike and accepting the degraded push and key-storage story.
