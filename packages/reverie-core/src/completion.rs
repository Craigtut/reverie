//! Lightweight structured-completion calls routed through the user's agent CLI.
//!
//! This is intentionally CLI-backed, not provider-backed. Reverie does not ask
//! the user to sign in to a second service for small product affordances such as
//! generated session titles; it reuses the authenticated CLI for the session's
//! agent kind.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value};
use tempfile::NamedTempFile;

use crate::{
    agents::{AdapterDetection, built_in_adapters},
    domain::AgentKind,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct CompletionRequest {
    pub agent_kind: AgentKind,
    pub cwd: PathBuf,
    pub prompt: String,
    pub schema: Value,
    pub model: Option<String>,
    pub timeout: Duration,
}

impl CompletionRequest {
    pub fn structured(
        agent_kind: AgentKind,
        cwd: impl Into<PathBuf>,
        prompt: impl Into<String>,
        schema: Value,
    ) -> Self {
        Self {
            agent_kind,
            cwd: cwd.into(),
            prompt: prompt.into(),
            schema,
            model: None,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

pub fn complete_structured(request: &CompletionRequest) -> Result<Value> {
    let executable = detect_executable(request.agent_kind)?;
    let value = match request.agent_kind {
        AgentKind::CodexCli => complete_with_codex(&executable, request)?,
        AgentKind::ClaudeCode => complete_with_claude(&executable, request)?,
        AgentKind::CortexCode => complete_with_cortex(&executable, request)?,
    };
    validate_schema_subset(&value, &request.schema)?;
    Ok(value)
}

fn detect_executable(agent_kind: AgentKind) -> Result<PathBuf> {
    let adapter = built_in_adapters()
        .into_iter()
        .find(|adapter| adapter.kind() == agent_kind)
        .with_context(|| format!("no adapter registered for {agent_kind:?}"))?;
    match adapter.detect() {
        AdapterDetection::Available { executable } => Ok(executable),
        AdapterDetection::Missing { candidates } => {
            bail!(
                "{} CLI is not available ({})",
                adapter.display_name(),
                candidates.join(", ")
            )
        }
    }
}

fn complete_with_codex(executable: &Path, request: &CompletionRequest) -> Result<Value> {
    let schema_file = write_schema_file(&request.schema)?;
    let mut args = vec![
        "exec".to_owned(),
        "--ephemeral".to_owned(),
        "--skip-git-repo-check".to_owned(),
        "--sandbox".to_owned(),
        "read-only".to_owned(),
        "--ask-for-approval".to_owned(),
        "never".to_owned(),
        "-c".to_owned(),
        "model_reasoning_effort=\"minimal\"".to_owned(),
        "--output-schema".to_owned(),
        schema_file.path().to_string_lossy().into_owned(),
    ];
    if let Some(model) = &request.model {
        args.push("--model".to_owned());
        args.push(model.clone());
    }
    args.push(request.prompt.clone());

    let output = run_with_timeout(executable, &args, &request.cwd, request.timeout)?;
    ensure_success("Codex completion", output)
        .and_then(|stdout| parse_json_stdout(&stdout).context("parse Codex structured output"))
}

fn complete_with_claude(executable: &Path, request: &CompletionRequest) -> Result<Value> {
    let schema = serde_json::to_string(&request.schema)?;
    let mut args = vec![
        "-p".to_owned(),
        "--no-session-persistence".to_owned(),
        "--tools".to_owned(),
        String::new(),
        "--permission-mode".to_owned(),
        "dontAsk".to_owned(),
        "--output-format".to_owned(),
        "json".to_owned(),
        "--json-schema".to_owned(),
        schema,
        "--effort".to_owned(),
        "minimal".to_owned(),
    ];
    if let Some(model) = &request.model {
        args.push("--model".to_owned());
        args.push(model.clone());
    }
    args.push(request.prompt.clone());

    let output = run_with_timeout(executable, &args, &request.cwd, request.timeout)?;
    let stdout = ensure_success("Claude completion", output)?;
    let raw = parse_json_stdout(&stdout).context("parse Claude completion output")?;
    claude_structured_value(raw)
}

fn complete_with_cortex(executable: &Path, request: &CompletionRequest) -> Result<Value> {
    let schema_file = write_schema_file(&request.schema)?;
    let mut args = vec![
        "complete".to_owned(),
        "--schema".to_owned(),
        schema_file.path().to_string_lossy().into_owned(),
    ];
    if let Some(model) = &request.model {
        args.push("--model".to_owned());
        args.push(model.clone());
    }
    args.push(request.prompt.clone());

    let output = run_with_timeout(executable, &args, &request.cwd, request.timeout)?;
    ensure_success("Cortex completion", output)
        .and_then(|stdout| parse_json_stdout(&stdout).context("parse Cortex structured output"))
}

fn write_schema_file(schema: &Value) -> Result<NamedTempFile> {
    let mut file = NamedTempFile::new().context("create temporary schema file")?;
    file.write_all(serde_json::to_string(schema)?.as_bytes())
        .context("write temporary schema file")?;
    file.flush().context("flush temporary schema file")?;
    Ok(file)
}

fn run_with_timeout(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
) -> Result<CommandOutput> {
    let mut child = Command::new(executable)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn {}", executable.display()))?;
    let started = Instant::now();
    loop {
        if started.elapsed() > timeout {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .context("collect timed-out completion")?;
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            bail!("completion timed out after {:?}: {stderr}", timeout);
        }
        if child.try_wait()?.is_some() {
            let output = child
                .wait_with_output()
                .context("collect completion output")?;
            return Ok(CommandOutput {
                status: output.status,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn ensure_success(label: &str, output: CommandOutput) -> Result<String> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = output.stderr.trim();
    let stdout = output.stdout.trim();
    if stderr.is_empty() {
        bail!("{label} failed: {stdout}");
    }
    bail!("{label} failed: {stderr}");
}

fn parse_json_stdout(stdout: &str) -> Result<Value> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        bail!("completion returned empty stdout");
    }
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }
    for line in trimmed.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str(line) {
            return Ok(value);
        }
    }
    Err(anyhow!("completion stdout did not contain JSON"))
}

fn claude_structured_value(raw: Value) -> Result<Value> {
    if let Some(value) = raw.get("structured_output") {
        return Ok(value.clone());
    }
    if let Some(result) = raw.get("result").and_then(Value::as_str) {
        return serde_json::from_str(result).context("parse Claude result as JSON");
    }
    Ok(raw)
}

fn validate_schema_subset(value: &Value, schema: &Value) -> Result<()> {
    let Some(schema_object) = schema.as_object() else {
        return Ok(());
    };
    if schema_object.get("type").and_then(Value::as_str) != Some("object") {
        return Ok(());
    }
    let Some(value_object) = value.as_object() else {
        bail!("structured completion returned non-object JSON");
    };

    if schema_object
        .get("additionalProperties")
        .and_then(Value::as_bool)
        == Some(false)
    {
        if let Some(properties) = schema_object.get("properties").and_then(Value::as_object) {
            for key in value_object.keys() {
                if !properties.contains_key(key) {
                    bail!("structured completion returned unexpected field {key}");
                }
            }
        }
    }

    if let Some(required) = schema_object.get("required").and_then(Value::as_array) {
        let properties = schema_object
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for field in required.iter().filter_map(Value::as_str) {
            let Some(field_value) = value_object.get(field) else {
                bail!("structured completion omitted required field {field}");
            };
            validate_property_type(field, field_value, properties.get(field))?;
        }
    }
    Ok(())
}

fn validate_property_type(
    field: &str,
    value: &Value,
    property_schema: Option<&Value>,
) -> Result<()> {
    let Some(property_type) = property_schema
        .and_then(Value::as_object)
        .and_then(|schema| schema.get("type"))
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let valid = match property_type {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        bail!("structured completion field {field} was not a {property_type}")
    }
}

pub fn string_object_schema(field: &str, description: &str) -> Value {
    let mut properties = Map::new();
    properties.insert(
        field.to_owned(),
        serde_json::json!({
            "type": "string",
            "description": description,
        }),
    );
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": [field],
        "additionalProperties": false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_json_line_when_cli_prints_noise() {
        let value = parse_json_stdout("notice\n{\"title\":\"Fix parser\"}\n").unwrap();
        assert_eq!(value["title"], "Fix parser");
    }

    #[test]
    fn validates_required_string_fields() {
        let schema = string_object_schema("title", "short title");
        validate_schema_subset(&serde_json::json!({"title":"Fix parser"}), &schema).unwrap();
        assert!(validate_schema_subset(&serde_json::json!({"title": 7}), &schema).is_err());
        assert!(
            validate_schema_subset(&serde_json::json!({"name":"Fix parser"}), &schema).is_err()
        );
    }
}
