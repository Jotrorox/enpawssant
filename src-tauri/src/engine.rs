//! Stockfish sidecar handling. Only Rust spawns the engine; the frontend has
//! no shell permissions.

use std::time::Duration;

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

/// Must match the file name of the `externalBin` entry in `tauri.conf.json`.
const SIDECAR: &str = "stockfish";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const QUIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Spawns the engine, performs the UCI handshake and returns its `id name`.
pub async fn engine_name<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let (mut events, mut child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| format!("could not locate the engine: {e}"))?
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start the engine: {e}"))?;

    send(&mut child, "uci")?;
    let name = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_until_uciok(&mut events))
        .await
        .map_err(|_| "the engine did not answer `uci` in time".to_string())??;

    // Ask the engine to exit on its own; `kill_on_drop` covers the case where it doesn't.
    if send(&mut child, "quit").is_ok() {
        let _ = tokio::time::timeout(QUIT_TIMEOUT, wait_for_exit(&mut events)).await;
    }
    Ok(name)
}

fn send(child: &mut CommandChild, command: &str) -> Result<(), String> {
    child
        .write(format!("{command}\n").as_bytes())
        .map_err(|e| format!("could not write to the engine: {e}"))
}

async fn read_until_uciok(events: &mut Receiver<CommandEvent>) -> Result<String, String> {
    let mut name = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let line = text.trim();
                if let Some(value) = parse_id_name(line) {
                    name = Some(value.to_owned());
                } else if line == "uciok" {
                    return name.ok_or_else(|| "the engine sent `uciok` without `id name`".into());
                }
            }
            CommandEvent::Error(e) => return Err(format!("engine I/O error: {e}")),
            CommandEvent::Terminated(status) => {
                return Err(format!(
                    "the engine exited before `uciok` (code {:?})",
                    status.code
                ));
            }
            _ => {}
        }
    }
    Err("the engine closed its output before `uciok`".into())
}

async fn wait_for_exit(events: &mut Receiver<CommandEvent>) {
    while let Some(event) = events.recv().await {
        if matches!(event, CommandEvent::Terminated(_)) {
            break;
        }
    }
}

/// Extracts the value of a UCI `id name <value>` line.
fn parse_id_name(line: &str) -> Option<&str> {
    let mut tokens = line.splitn(3, char::is_whitespace);
    match (tokens.next(), tokens.next(), tokens.next()) {
        (Some("id"), Some("name"), Some(value)) if !value.trim().is_empty() => Some(value.trim()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_id_name;

    #[test]
    fn parses_id_name() {
        assert_eq!(parse_id_name("id name Stockfish 19"), Some("Stockfish 19"));
        assert_eq!(parse_id_name("id author the Stockfish developers"), None);
        assert_eq!(parse_id_name("id name"), None);
        assert_eq!(parse_id_name("uciok"), None);
    }
}
