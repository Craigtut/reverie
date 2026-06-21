//! Dev-only smoke test for the CLI-backed completion surface.
//!
//! Proves `complete_structured` actually round-trips structured output against
//! each installed agent CLI. Only the Codex path is exercised in production
//! today (session titles); Claude and Cortex have unit-tested arg shapes but
//! have never run against the real binaries. This example closes that gap.
//!
//! Run all installed CLIs:
//!     cargo run -p reverie-core --example completion-smoke
//! Run a subset:
//!     cargo run -p reverie-core --example completion-smoke -- claude cortex
//!
//! Each CLI spends a small amount of the user's own provider quota.

use std::{env, time::Duration};

use anyhow::Result;
use reverie_core::{
    CompletionRequest, complete_structured, domain::AgentKind, string_object_schema,
};

fn main() {
    let requested: Vec<String> = env::args().skip(1).map(|arg| arg.to_lowercase()).collect();
    let targets: Vec<AgentKind> = if requested.is_empty() {
        vec![
            AgentKind::CodexCli,
            AgentKind::ClaudeCode,
            AgentKind::CortexCode,
        ]
    } else {
        requested
            .iter()
            .filter_map(|name| match name.as_str() {
                "codex" => Some(AgentKind::CodexCli),
                "claude" => Some(AgentKind::ClaudeCode),
                "cortex" => Some(AgentKind::CortexCode),
                other => {
                    eprintln!("unknown CLI '{other}' (expected codex|claude|cortex)");
                    None
                }
            })
            .collect()
    };

    let cwd = env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut failures = 0u32;

    for kind in targets {
        print!("{kind:?}: ");
        match run_one(kind, &cwd) {
            Ok(answer) => println!("OK -> answer={answer:?}"),
            Err(error) => {
                failures += 1;
                println!("FAIL -> {error:#}");
            }
        }
    }

    if failures > 0 {
        eprintln!("\n{failures} CLI completion path(s) failed");
        std::process::exit(1);
    }
    println!("\nall requested completion paths returned valid structured output");
}

fn run_one(kind: AgentKind, cwd: &std::path::Path) -> Result<String> {
    let schema = string_object_schema(
        "answer",
        "A single lowercase word answering the question.",
    );
    let prompt = "Return a JSON object with a single field \"answer\" whose value is the \
        lowercase word \"pong\". Do not include any other text.";
    let request = CompletionRequest::structured(kind, cwd, prompt, schema)
        .with_timeout(Duration::from_secs(60));
    let value = complete_structured(&request)?;
    let answer = value
        .get("answer")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("response missing string field 'answer': {value}"))?;
    Ok(answer.to_owned())
}
