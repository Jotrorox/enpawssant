//! Tauri commands for PGN import and export. Parsing and writing live in `chess-core`; this module
//! only adds native file dialogs, so the frontend needs no dialog or file system permissions.

use std::path::PathBuf;

use chess_core::pgn::{self, Game, ParsedPgn};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

use crate::files::{file_name, read_pgn_file};

/// More games than this are not read from one file; the result is marked as truncated.
pub const MAX_GAMES: usize = 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPgn {
    /// File name of the opened file, without its directory.
    pub name: String,
    /// Full path, so the file can be opened again from the recent files.
    pub path: PathBuf,
    #[serde(flatten)]
    pub parsed: ParsedPgn,
}

/// Reads games from PGN text, e.g. pasted from the clipboard.
#[tauri::command]
pub fn pgn_parse(text: String) -> ParsedPgn {
    pgn::parse_str(&text, MAX_GAMES)
}

/// Writes a game as PGN text.
#[tauri::command]
pub fn pgn_export(game: Game) -> Result<String, String> {
    pgn::write(&game)
}

/// Asks for a PGN file and reads its games. Returns `None` when the dialog is cancelled.
#[tauri::command]
pub async fn pgn_open_file<R: Runtime>(app: AppHandle<R>) -> Result<Option<OpenedPgn>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Open PGN")
        .add_filter("PGN", &["pgn"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = chosen_path(rx).await? else {
        return Ok(None);
    };

    tauri::async_runtime::spawn_blocking(move || read_pgn_file(path).map(Some))
        .await
        .map_err(|e| format!("reading the file failed: {e}"))?
}

/// Asks where to save a game and writes it as PGN. Returns the file name, or `None` when the
/// dialog is cancelled.
#[tauri::command]
pub async fn pgn_save_file<R: Runtime>(
    app: AppHandle<R>,
    game: Game,
    suggested_name: String,
) -> Result<Option<String>, String> {
    // Fail before asking for a path if the game cannot be written.
    let text = pgn::write(&game)?;
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Save PGN")
        .add_filter("PGN", &["pgn"])
        .set_file_name(suggested_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = chosen_path(rx).await? else {
        return Ok(None);
    };

    let name = file_name(&path);
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| format!("could not save {name}: {e}"))?;
    Ok(Some(name))
}

async fn chosen_path(rx: oneshot::Receiver<Option<FilePath>>) -> Result<Option<PathBuf>, String> {
    let chosen = rx
        .await
        .map_err(|_| "the file dialog closed unexpectedly")?;
    chosen
        .map(|path| {
            path.into_path()
                .map_err(|e| format!("unsupported file location: {e}"))
        })
        .transpose()
}
