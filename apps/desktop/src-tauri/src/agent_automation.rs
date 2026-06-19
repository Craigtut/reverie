use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use reverie_core::terminal::TerminalId;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

use crate::terminal::runtime::TerminalSessionRuntime;

const DEFAULT_PORT: u16 = 17_777;
const MANIFEST_FILE: &str = "agent-automation.json";
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_EVAL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct AutomationServer {
    window: WebviewWindow,
    runtime: TerminalSessionRuntime,
    token: String,
    screenshot_dir: PathBuf,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalRequest {
    script: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectorRequest {
    selector: Option<String>,
    text: Option<String>,
    partial_text: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeRequest {
    selector: Option<String>,
    text: String,
    submit: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PressRequest {
    key: String,
    code: Option<String>,
    meta_key: Option<bool>,
    ctrl_key: Option<bool>,
    alt_key: Option<bool>,
    shift_key: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalInputRequest {
    terminal_id: Option<TerminalId>,
    input: Option<String>,
    text: Option<String>,
}

pub(crate) fn maybe_start(app: &AppHandle) -> Result<()> {
    if !env_truthy("REVERIE_AGENT_AUTOMATION") {
        return Ok(());
    }
    if !crate::commands::is_dev_channel(app) {
        eprintln!("[reverie-agent] refused to start: agent automation requires the dev channel");
        return Ok(());
    }

    let window = app
        .get_webview_window("main")
        .context("main webview window is not available")?;
    let runtime = app.state::<TerminalSessionRuntime>().inner().clone();
    let port = std::env::var("REVERIE_AGENT_AUTOMATION_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let token = std::env::var("REVERIE_AGENT_AUTOMATION_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let listener = TcpListener::bind(("127.0.0.1", port))
        .with_context(|| format!("failed to bind agent automation server on 127.0.0.1:{port}"))?;
    let port = listener.local_addr()?.port();
    let app_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_dir)?;
    let screenshot_dir = app_dir.join("agent-automation-screenshots");
    fs::create_dir_all(&screenshot_dir)?;

    let manifest_path = app_dir.join(MANIFEST_FILE);
    let manifest = json!({
        "enabled": true,
        "pid": std::process::id(),
        "port": port,
        "baseUrl": format!("http://127.0.0.1:{port}"),
        "token": token,
        "authHeader": "Authorization",
        "authValue": format!("Bearer {token}"),
        "manifestPath": manifest_path,
        "screenshotDir": screenshot_dir,
        "startedAt": unix_millis(),
    });
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

    enable_frontend_agent_flag(&window);
    window.set_title("Reverie Dev Agent").ok();

    let server = AutomationServer {
        window,
        runtime,
        token,
        screenshot_dir,
    };
    thread::Builder::new()
        .name("reverie-agent-automation".to_owned())
        .spawn(move || serve(listener, server))
        .context("failed to spawn agent automation server")?;

    eprintln!(
        "[reverie-agent] automation bridge listening at http://127.0.0.1:{port}; manifest {}",
        manifest_path.display()
    );
    Ok(())
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn serve(listener: TcpListener, server: AutomationServer) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let server = server.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(stream, &server) {
                        eprintln!("[reverie-agent] request failed: {error:#}");
                    }
                });
            }
            Err(error) => eprintln!("[reverie-agent] connection failed: {error}"),
        }
    }
}

fn handle_connection(mut stream: TcpStream, server: &AutomationServer) -> Result<()> {
    let request = read_http_request(&mut stream)?;
    if request.method == "OPTIONS" {
        write_empty(&mut stream, 204)?;
        return Ok(());
    }
    if request.path == "/health" {
        write_json(
            &mut stream,
            200,
            json!({ "ok": true, "name": "reverie-agent" }),
        )?;
        return Ok(());
    }
    if !authorized(&request, &server.token) {
        write_json(
            &mut stream,
            401,
            json!({ "ok": false, "error": "unauthorized" }),
        )?;
        return Ok(());
    }

    let result = route_request(&request, server);
    match result {
        Ok(value) => write_json(&mut stream, 200, json!({ "ok": true, "data": value }))?,
        Err(error) => write_json(
            &mut stream,
            500,
            json!({ "ok": false, "error": error.to_string() }),
        )?,
    }
    Ok(())
}

fn route_request(request: &HttpRequest, server: &AutomationServer) -> Result<Value> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => status(server),
        ("POST", "/eval") => {
            let payload: EvalRequest = parse_json_body(request)?;
            eval_user_script(&server.window, payload)
        }
        ("GET", "/dom") => eval_json(&server.window, DOM_SNAPSHOT_SCRIPT, DEFAULT_EVAL_TIMEOUT),
        ("GET", "/app") => eval_json(&server.window, APP_SNAPSHOT_SCRIPT, DEFAULT_EVAL_TIMEOUT),
        ("GET", "/terminal") => eval_json(
            &server.window,
            TERMINAL_SNAPSHOT_SCRIPT,
            DEFAULT_EVAL_TIMEOUT,
        ),
        ("POST", "/click") => {
            let payload: SelectorRequest = parse_json_body(request)?;
            eval_json(
                &server.window,
                &click_script(payload)?,
                DEFAULT_EVAL_TIMEOUT,
            )
        }
        ("POST", "/type") => {
            let payload: TypeRequest = parse_json_body(request)?;
            eval_json(&server.window, &type_script(payload)?, DEFAULT_EVAL_TIMEOUT)
        }
        ("POST", "/press") => {
            let payload: PressRequest = parse_json_body(request)?;
            eval_json(
                &server.window,
                &press_script(payload)?,
                DEFAULT_EVAL_TIMEOUT,
            )
        }
        ("POST", "/terminal/input") => {
            let payload: TerminalInputRequest = parse_json_body(request)?;
            let terminal_id = resolve_terminal_id(&server.window, payload.terminal_id)?;
            let input = payload.input.or(payload.text).unwrap_or_default();
            server.runtime.write_input(terminal_id, input.as_bytes())?;
            Ok(json!({ "terminalId": terminal_id }))
        }
        ("POST", "/terminal/paste") => {
            let payload: TerminalInputRequest = parse_json_body(request)?;
            let terminal_id = resolve_terminal_id(&server.window, payload.terminal_id)?;
            let text = payload.text.or(payload.input).unwrap_or_default();
            server.runtime.paste_text(terminal_id, text)?;
            Ok(json!({ "terminalId": terminal_id }))
        }
        ("POST", "/devtools/open") => {
            server.window.open_devtools();
            Ok(json!({ "opened": true }))
        }
        ("GET", "/screenshot") | ("POST", "/screenshot") => capture_screenshot(server),
        _ => bail!("unknown endpoint {} {}", request.method, request.path),
    }
}

fn status(server: &AutomationServer) -> Result<Value> {
    let frontend = eval_json(&server.window, STATUS_SCRIPT, Duration::from_secs(2))
        .unwrap_or_else(|error| json!({ "frontendError": error.to_string() }));
    Ok(json!({
        "pid": std::process::id(),
        "frontend": frontend,
        "terminals": server.runtime.list_sessions()?,
    }))
}

fn authorized(request: &HttpRequest, token: &str) -> bool {
    let bearer = format!("Bearer {token}");
    request
        .headers
        .get("authorization")
        .is_some_and(|value| value == &bearer)
        || request
            .headers
            .get("x-reverie-agent-token")
            .is_some_and(|value| value == token)
        || request
            .query
            .get("token")
            .is_some_and(|value| value == token)
}

fn parse_json_body<T: for<'de> Deserialize<'de>>(request: &HttpRequest) -> Result<T> {
    serde_json::from_slice(&request.body).context("request body is not valid JSON")
}

fn eval_user_script(window: &WebviewWindow, request: EvalRequest) -> Result<Value> {
    let timeout = request
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_EVAL_TIMEOUT)
        .min(MAX_EVAL_TIMEOUT);
    let id = Uuid::new_v4().to_string();
    let id_json = serde_json::to_string(&id)?;
    let source_json = serde_json::to_string(&request.script)?;
    let kickoff = format!(
        r#"
(() => {{
  const id = {id_json};
  const source = {source_json};
  const root = window.__reverieAgentEvalResults || (window.__reverieAgentEvalResults = Object.create(null));
  const clean = (value) => {{
    if (value === undefined) return {{ type: 'undefined' }};
    if (value instanceof Error) return {{
      name: value.name,
      message: value.message,
      stack: value.stack || null
    }};
    try {{
      return JSON.parse(JSON.stringify(value));
    }} catch (_) {{
      return String(value);
    }}
  }};
  (async () => {{
    try {{
      const value = await (0, eval)(source);
      root[id] = {{ ok: true, value: clean(value) }};
    }} catch (error) {{
      root[id] = {{ ok: false, error: clean(error) }};
    }}
  }})();
  return true;
}})()
"#
    );
    eval_json(window, &kickoff, Duration::from_secs(2))?;

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let poll = format!(
            "(() => window.__reverieAgentEvalResults ? (window.__reverieAgentEvalResults[{id_json}] ?? null) : null)()"
        );
        let result = eval_json(window, &poll, Duration::from_secs(2))?;
        if !result.is_null() {
            let cleanup = format!(
                "(() => {{ if (window.__reverieAgentEvalResults) delete window.__reverieAgentEvalResults[{id_json}]; return true; }})()"
            );
            server_eval_fire_and_forget(window, cleanup);
            if result.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(result.get("value").cloned().unwrap_or(Value::Null));
            }
            bail!(
                "script failed: {}",
                result
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| json!("unknown error"))
            );
        }
        thread::sleep(Duration::from_millis(25));
    }
    bail!("script timed out after {}ms", timeout.as_millis())
}

fn server_eval_fire_and_forget(window: &WebviewWindow, script: String) {
    if let Err(error) = window.eval(script) {
        eprintln!("[reverie-agent] eval cleanup failed: {error}");
    }
}

fn eval_json(window: &WebviewWindow, script: &str, timeout: Duration) -> Result<Value> {
    let (tx, rx) = mpsc::channel();
    window.eval_with_callback(script.to_owned(), move |raw| {
        let _ = tx.send(raw);
    })?;
    let raw = rx
        .recv_timeout(timeout)
        .with_context(|| format!("webview eval timed out after {}ms", timeout.as_millis()))?;
    serde_json::from_str(&raw).or_else(|_| Ok(Value::String(raw)))
}

fn resolve_terminal_id(window: &WebviewWindow, provided: Option<TerminalId>) -> Result<TerminalId> {
    if let Some(terminal_id) = provided {
        return Ok(terminal_id);
    }
    let value = eval_json(
        window,
        "(() => window.__reverieAgent?.activeTerminalId?.() ?? window.__REVERIE_TERMINAL_DEBUG__?.summary?.().activeTerminalId ?? null)()",
        Duration::from_secs(2),
    )?;
    let raw = value
        .as_str()
        .ok_or_else(|| anyhow!("no active terminal id is available"))?;
    Uuid::parse_str(raw).context("active terminal id is not a UUID")
}

fn click_script(payload: SelectorRequest) -> Result<String> {
    let payload = serde_json::to_string(&json!({
        "selector": payload.selector,
        "text": payload.text,
        "partialText": payload.partial_text,
        "x": payload.x,
        "y": payload.y,
    }))?;
    Ok(format!(
        r#"
(() => {{
  const payload = {payload};
  const api = window.__reverieAgent;
  if (api?.click) return api.click(payload);
  const target = payload.x !== null && payload.x !== undefined
    ? document.elementFromPoint(payload.x, payload.y)
    : (payload.selector ? document.querySelector(payload.selector) : null);
  if (!target) throw new Error('click target not found');
  target.scrollIntoView?.({{ block: 'center', inline: 'center' }});
  target.focus?.({{ preventScroll: true }});
  target.click?.();
  return {{ clicked: true, tag: target.tagName, text: (target.innerText || target.textContent || '').trim().slice(0, 200) }};
}})()
"#
    ))
}

fn type_script(payload: TypeRequest) -> Result<String> {
    let payload = serde_json::to_string(&json!({
        "selector": payload.selector,
        "text": payload.text,
        "submit": payload.submit.unwrap_or(false),
    }))?;
    Ok(format!(
        r#"
(() => {{
  const payload = {payload};
  const api = window.__reverieAgent;
  if (api?.typeText) return api.typeText(payload);
  const target = payload.selector ? document.querySelector(payload.selector) : document.activeElement;
  if (!target) throw new Error('type target not found');
  target.focus?.({{ preventScroll: true }});
  if ('value' in target) {{
    target.value = `${{target.value || ''}}${{payload.text}}`;
    target.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: payload.text }}));
    target.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }} else {{
    target.dispatchEvent(new InputEvent('beforeinput', {{ bubbles: true, inputType: 'insertText', data: payload.text }}));
    document.execCommand?.('insertText', false, payload.text);
    target.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: payload.text }}));
  }}
  if (payload.submit) {{
    target.dispatchEvent(new KeyboardEvent('keydown', {{ bubbles: true, key: 'Enter', code: 'Enter' }}));
    target.dispatchEvent(new KeyboardEvent('keyup', {{ bubbles: true, key: 'Enter', code: 'Enter' }}));
  }}
  return {{ typed: true, tag: target.tagName }};
}})()
"#
    ))
}

fn press_script(payload: PressRequest) -> Result<String> {
    let payload = serde_json::to_string(&json!({
        "key": payload.key,
        "code": payload.code,
        "metaKey": payload.meta_key.unwrap_or(false),
        "ctrlKey": payload.ctrl_key.unwrap_or(false),
        "altKey": payload.alt_key.unwrap_or(false),
        "shiftKey": payload.shift_key.unwrap_or(false),
    }))?;
    Ok(format!(
        r#"
(() => {{
  const payload = {payload};
  const target = document.activeElement || document.body;
  const init = {{
    bubbles: true,
    cancelable: true,
    key: payload.key,
    code: payload.code || payload.key,
    metaKey: payload.metaKey,
    ctrlKey: payload.ctrlKey,
    altKey: payload.altKey,
    shiftKey: payload.shiftKey
  }};
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return {{ pressed: true, key: payload.key, target: target.tagName }};
}})()
"#
    ))
}

fn capture_screenshot(server: &AutomationServer) -> Result<Value> {
    fs::create_dir_all(&server.screenshot_dir)?;
    let path = server
        .screenshot_dir
        .join(format!("screenshot-{}.png", unix_millis()));
    let window_number = macos_window_number(&server.window).ok();
    let mut method = "webkit-snapshot";
    let mut size = None;
    let bytes = match macos_window_png(&server.window) {
        Ok(snapshot) => {
            fs::write(&path, &snapshot.bytes)?;
            size = Some((snapshot.width, snapshot.height));
            snapshot.bytes.len() as u64
        }
        Err(snapshot_error) => {
            method = "screencapture";
            let window_number = window_number.ok_or_else(|| {
                anyhow!(
                    "WebKit snapshot failed ({snapshot_error:#}) and no window number is available"
                )
            })?;
            capture_with_screencapture(window_number, &path)
                .with_context(|| format!("WebKit snapshot failed first: {snapshot_error:#}"))?
        }
    };
    Ok(json!({
        "path": path,
        "mime": "image/png",
        "bytes": bytes,
        "method": method,
        "size": size.map(|(width, height)| json!({ "width": width, "height": height })),
        "windowNumber": window_number,
    }))
}

fn capture_with_screencapture(window_number: i64, path: &std::path::Path) -> Result<u64> {
    let output = Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-t")
        .arg("png")
        .arg("-l")
        .arg(window_number.to_string())
        .arg(path)
        .output()
        .context("failed to run screencapture")?;
    if !output.status.success() {
        bail!(
            "screencapture exited with status {}; stderr: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(fs::metadata(path)?.len())
}

#[cfg(target_os = "macos")]
fn macos_window_number(window: &WebviewWindow) -> Result<i64> {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    let window_for_call = window.clone();
    let window_for_closure = window.clone();
    let (tx, rx) = mpsc::channel();
    window_for_call.run_on_main_thread(move || {
        let result = window_for_closure
            .ns_window()
            .map_err(anyhow::Error::from)
            .and_then(|ptr| {
                if ptr.is_null() {
                    bail!("NSWindow pointer is null");
                }
                unsafe {
                    let ns_window = ptr as *mut Object;
                    let number: isize = msg_send![ns_window, windowNumber];
                    Ok(number as i64)
                }
            });
        let _ = tx.send(result);
    })?;
    rx.recv_timeout(Duration::from_secs(2))
        .context("timed out reading macOS window number")?
}

#[cfg(target_os = "macos")]
struct MacosSnapshot {
    bytes: Vec<u8>,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
fn macos_window_png(window: &WebviewWindow) -> Result<MacosSnapshot> {
    let (tx, rx) = mpsc::channel();
    window.with_webview(move |webview| {
        let sender = tx.clone();
        if let Err(error) = start_webkit_snapshot(webview.inner(), sender.clone()) {
            let _ = sender.send(Err(error));
        }
    })?;
    rx.recv_timeout(Duration::from_secs(5))
        .context("timed out snapshotting macOS window")?
}

#[cfg(not(target_os = "macos"))]
fn macos_window_png(_window: &WebviewWindow) -> Result<MacosSnapshot> {
    bail!("WebKit snapshot is implemented only for macOS")
}

#[cfg(target_os = "macos")]
fn start_webkit_snapshot(
    webview: *mut std::ffi::c_void,
    tx: mpsc::Sender<Result<MacosSnapshot>>,
) -> Result<()> {
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    if webview.is_null() {
        bail!("WKWebView pointer is null");
    }

    let callback = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let result = unsafe { webkit_snapshot_result(image, error) };
        let _ = tx.send(result);
    });

    unsafe {
        let webview = &*(webview.cast::<WKWebView>());
        webview.takeSnapshotWithConfiguration_completionHandler(None, &callback);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe fn webkit_snapshot_result(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
) -> Result<MacosSnapshot> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError};

    if !error.is_null() {
        bail!("WebKit snapshot failed: {}", unsafe {
            ns_error_message(&*error.cast::<NSError>())
        });
    }
    if image.is_null() {
        bail!("WebKit snapshot returned no image");
    }

    let image = unsafe { &*image.cast::<NSImage>() };
    let size = image.size();
    let tiff = image
        .TIFFRepresentation()
        .context("WebKit snapshot image has no TIFF representation")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
        .context("failed to create bitmap representation from WebKit snapshot")?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }
    .context("failed to encode WebKit snapshot as PNG")?;
    let bytes = nsdata_to_vec(&png)?;
    if bytes.is_empty() {
        bail!("encoded WebKit snapshot is empty");
    }

    Ok(MacosSnapshot {
        bytes,
        width: size.width,
        height: size.height,
    })
}

#[cfg(target_os = "macos")]
fn nsdata_to_vec(data: &objc2_foundation::NSData) -> Result<Vec<u8>> {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    let len = data.length();
    let mut bytes = vec![0u8; len];
    if len > 0 {
        let ptr = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
            .context("NSData output buffer is null")?;
        unsafe {
            data.getBytes_length(ptr, len);
        }
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
unsafe fn ns_error_message(error: &objc2_foundation::NSError) -> String {
    use std::ffi::CStr;

    let description = error.localizedDescription();
    let raw = description.UTF8String();
    if raw.is_null() {
        return "unknown NSError".to_owned();
    }
    unsafe { CStr::from_ptr(raw).to_string_lossy().into_owned() }
}

#[cfg(not(target_os = "macos"))]
fn macos_window_number(_window: &WebviewWindow) -> Result<i64> {
    bail!("screenshot capture is implemented only for macOS")
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > MAX_BODY_BYTES {
            bail!("request is too large");
        }
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            bail!("connection closed before headers completed");
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let header_text =
        std::str::from_utf8(&buffer[..header_end]).context("request headers are not UTF-8")?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().context("request line missing")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let target = request_parts.next().unwrap_or_default();
    let (path, query) = split_target(target);
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        bail!("request body is too large");
    }
    let body_start = header_end + 4;
    let mut body = buffer[body_start..].to_vec();
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let mut chunk = vec![0u8; remaining.min(4096)];
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            bail!("connection closed before body completed");
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn split_target(target: &str) -> (String, HashMap<String, String>) {
    let (path, query_string) = target.split_once('?').unwrap_or((target, ""));
    let mut query = HashMap::new();
    for item in query_string.split('&').filter(|item| !item.is_empty()) {
        let (key, value) = item.split_once('=').unwrap_or((item, ""));
        query.insert(percent_decode(key), percent_decode(value));
    }
    (path.to_owned(), query)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                if let Ok(value) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                    out.push(value);
                    index += 3;
                } else {
                    out.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn write_empty(stream: &mut TcpStream, status: u16) -> Result<()> {
    write_response(stream, status, "text/plain; charset=utf-8", &[])
}

fn write_json(stream: &mut TcpStream, status: u16, value: Value) -> Result<()> {
    let body = serde_json::to_vec(&value)?;
    write_response(stream, status, "application/json; charset=utf-8", &body)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    Ok(())
}

fn enable_frontend_agent_flag(window: &WebviewWindow) {
    let Ok(mut url) = window.url() else {
        return;
    };
    let mut pairs = url.query_pairs().into_owned().collect::<Vec<_>>();
    if pairs
        .iter()
        .any(|(key, value)| key == "agentAutomation" && value == "1")
    {
        return;
    }
    pairs.push(("agentAutomation".to_owned(), "1".to_owned()));
    url.query_pairs_mut().clear().extend_pairs(pairs);
    let _ = window.navigate(url);
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

const STATUS_SCRIPT: &str = r#"
(() => ({
  title: document.title,
  location: window.location.href,
  readyState: document.readyState,
  agentHelper: Boolean(window.__reverieAgent),
  terminalDebug: Boolean(window.__REVERIE_TERMINAL_DEBUG__),
  activeElement: window.__reverieAgent?.activeElement?.() ?? null
}))()
"#;

const APP_SNAPSHOT_SCRIPT: &str = r#"
(() => {
  if (window.__reverieAgent?.snapshot) return window.__reverieAgent.snapshot();
  return {
    title: document.title,
    location: window.location.href,
    dom: window.__reverieAgent?.domSnapshot?.() ?? null,
    terminal: window.__REVERIE_TERMINAL_DEBUG__ ? {
      summary: window.__REVERIE_TERMINAL_DEBUG__.summary(),
      visibleRows: window.__REVERIE_TERMINAL_DEBUG__.visibleRows()
    } : null
  };
})()
"#;

const DOM_SNAPSHOT_SCRIPT: &str = r#"
(() => {
  if (window.__reverieAgent?.domSnapshot) return window.__reverieAgent.domSnapshot();
  const nodes = [];
  const elements = Array.from(document.querySelectorAll('button, [role], input, textarea, select, a, [tabindex], [aria-label], [data-testid]')).slice(0, 500);
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    nodes.push({
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      role: element.getAttribute('role'),
      testId: element.getAttribute('data-testid'),
      ariaLabel: element.getAttribute('aria-label'),
      text: (element.innerText || element.value || element.textContent || '').trim().slice(0, 300),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    });
  }
  return { title: document.title, location: window.location.href, nodes };
})()
"#;

const TERMINAL_SNAPSHOT_SCRIPT: &str = r#"
(() => {
  if (window.__reverieAgent?.terminalSnapshot) return window.__reverieAgent.terminalSnapshot();
  const debug = window.__REVERIE_TERMINAL_DEBUG__;
  if (!debug) return { available: false, reason: 'terminal debug API is not installed' };
  return { available: true, summary: debug.summary(), visibleRows: debug.visibleRows() };
})()
"#;
