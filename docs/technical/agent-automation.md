# Agent automation bridge

Reverie can expose a local automation bridge for development agents that need to inspect and interact with the real macOS Tauri UI.

This bridge is intentionally not a production feature.

## How to run it

```bash
npm run dev:agent
```

This is the dev-channel app built with the `agent-automation` Cargo feature plus `REVERIE_AGENT_AUTOMATION=1`. The backend starts a local HTTP server on `127.0.0.1:17777` by default. Override the port with:

```bash
REVERIE_AGENT_AUTOMATION_PORT=17778 npm run dev:agent
```

On startup the app writes a manifest in the dev-channel app-data directory:

```bash
~/Library/Application Support/com.muselab.reverie.dev/agent-automation.json
```

The manifest contains the port, base URL, auth token, and screenshot directory. Every endpoint except `/health` requires either:

```text
Authorization: Bearer <token>
```

or:

```text
X-Reverie-Agent-Token: <token>
```

## Safety gates

- The Rust module is compiled only when both `debug_assertions` and the `agent-automation` Cargo feature are enabled.
- The server starts only when `REVERIE_AGENT_AUTOMATION=1`.
- The server refuses to start unless the app identifier ends in `.dev`.
- The server binds only to `127.0.0.1`.
- A per-run token is required for all meaningful endpoints.
- The frontend helper is loaded only in Vite dev mode and only when the URL has `agentAutomation=1`.
- `npm run build`, `npm run bundle`, and production app launches do not start the bridge.

## Endpoints

`GET /health`

Unauthenticated liveness check.

`GET /status`

Returns process info, frontend readiness, active element, and runtime terminal records.

`GET /app`

Returns a combined snapshot: location, workspace shell snapshot, navigation state, terminal state, visible terminal rows, and DOM snapshot.

`GET /dom`

Returns visible interactive DOM nodes with stable selectors, labels, text, and viewport bounds.

`GET /terminal`

Returns terminal state and visible terminal rows from the frontend row mirror. This is the right way for an agent to read the terminal. The terminal is a canvas, so DOM inspection cannot see cells.

`POST /eval`

Runs JavaScript in the WebView and returns a JSON-serializable result.

```json
{ "script": "document.title", "timeoutMs": 5000 }
```

`POST /click`

Clicks a DOM target. Targets can be selected by CSS, text, partial text, or viewport coordinates.

```json
{ "selector": "button[aria-label=\"New session\"]" }
```

```json
{ "text": "Settings" }
```

```json
{ "x": 120, "y": 240 }
```

`POST /type`

Types into a DOM input-like target.

```json
{ "selector": "input[name=\"title\"]", "text": "Plan release", "submit": true }
```

`POST /press`

Dispatches a keyboard event pair to the active element.

```json
{ "key": "Escape", "code": "Escape" }
```

`POST /terminal/input`

Writes raw input to the active terminal, or to a provided `terminalId`.

```json
{ "input": "\u0003" }
```

`POST /terminal/paste`

Pastes text through the existing terminal paste path, which lets the terminal backend encode paste safely.

```json
{ "text": "npm run check\n" }
```

`POST /devtools/open`

Opens Web Inspector for human debugging in the dev build.

`GET /screenshot`

Captures the WebView with WebKit snapshotting and returns a PNG path. If that fails, the bridge falls back to macOS `screencapture`, which may depend on local screen-recording permissions. Agents should combine `/screenshot` with `/app`, `/dom`, and `/terminal` for precise state.

## Example

```bash
MANIFEST="$HOME/Library/Application Support/com.muselab.reverie.dev/agent-automation.json"
TOKEN="$(jq -r .token "$MANIFEST")"
BASE="$(jq -r .baseUrl "$MANIFEST")"

curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/app" | jq .
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/terminal" | jq .
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Settings"}' \
  "$BASE/click" | jq .
```
