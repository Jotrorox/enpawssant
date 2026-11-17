//! Tauri commands for PGN import and export. Parsing and writing live in `chess-core`; this module
//! only adds native file dialogs, so the frontend needs no dialog or file system permissions.

use std::path::PathBuf;

use chess_core::pgn::{self, Game, ParsedPgn};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

use crate::files::{file_name, is_pgn, read_pgn_file};

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

/// A game written to a file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPgn {
    /// File name, without its directory.
    pub name: String,
    /// Full path, so later saves can go straight to the same file.
    pub path: PathBuf,
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

/// Checks a position set up by hand and returns it as a cleaned-up FEN, or why it can't be used.
#[tauri::command]
pub fn position_check(fen: String) -> Result<String, String> {
    chess_core::setup::check_position(&fen)
}

/// Asks where to save a game and writes it as PGN. Returns where it went, or `None` when the
/// dialog is cancelled.
#[tauri::command]
pub async fn pgn_save_file<R: Runtime>(
    app: AppHandle<R>,
    game: Game,
    suggested_name: String,
) -> Result<Option<SavedPgn>, String> {
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

    write_text(path, text).await.map(Some)
}

/// Writes a game back to the PGN file it was opened from or saved to, replacing its contents.
/// Only an existing PGN file holding a single readable game is replaced, so a file that has
/// gained games since (or never was this game's alone) is never overwritten with one.
#[tauri::command]
pub async fn pgn_write_path(game: Game, path: PathBuf) -> Result<SavedPgn, String> {
    let text = pgn::write(&game)?;
    let checked = path.clone();
    tauri::async_runtime::spawn_blocking(move || check_replaceable(&checked))
        .await
        .map_err(|e| format!("checking the file failed: {e}"))??;
    write_text(path, text).await
}

/// Fails unless `path` is an existing PGN file with exactly one game that reads without trouble.
fn check_replaceable(path: &std::path::Path) -> Result<(), String> {
    let name = file_name(path);
    if !is_pgn(path) {
        return Err(format!("{name} is not a PGN file"));
    }
    let opened = read_pgn_file(path.to_path_buf())?;
    let parsed = &opened.parsed;
    let whole = parsed.games.len() == 1
        && parsed.errors.is_empty()
        && !parsed.truncated
        && parsed.games[0].warnings.is_empty();
    if whole {
        Ok(())
    } else {
        Err(format!("{name} now holds more than this game"))
    }
}

async fn write_text(path: PathBuf, text: String) -> Result<SavedPgn, String> {
    let name = file_name(&path);
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| format!("could not save {name}: {e}"))?;
    Ok(SavedPgn { name, path })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_replaces_files_holding_just_one_game() {
        let dir = std::env::temp_dir().join(format!("enpawssant-pgn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("one.pgn"), "1. e4 e5 *").unwrap();
        std::fs::write(dir.join("two.pgn"), "1. e4 *\n\n1. d4 *").unwrap();
        std::fs::write(dir.join("broken.pgn"), "1. e4 e5 2. Ke3 *").unwrap();
        std::fs::write(dir.join("notes.txt"), "1. e4 *").unwrap();

        assert!(check_replaceable(&dir.join("one.pgn")).is_ok());
        assert!(check_replaceable(&dir.join("two.pgn")).is_err());
        // Saving would drop the moves that couldn't be read.
        assert!(check_replaceable(&dir.join("broken.pgn")).is_err());
        assert!(check_replaceable(&dir.join("notes.txt")).is_err());
        assert!(check_replaceable(&dir.join("missing.pgn")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
