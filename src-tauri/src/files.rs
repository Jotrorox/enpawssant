//! The file browser: folders and PGN files on disk. The frontend has no file system permissions, so
//! it lists folders and reads files through these commands, which only ever show folders and PGN
//! files and only read files that end in `.pgn`.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chess_core::pgn;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::pgn::{MAX_GAMES, OpenedPgn};

/// A folder offered as a starting point, such as Documents.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    name: String,
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    Folder,
    Pgn,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: PathBuf,
    kind: EntryKind,
    /// In bytes; 0 for folders.
    size: u64,
    /// Milliseconds since the Unix epoch, when known.
    modified: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    path: PathBuf,
    parent: Option<PathBuf>,
    /// Folders first, then PGN files, each sorted by name.
    entries: Vec<Entry>,
}

/// File name of a path, without its directory.
pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

pub fn is_pgn(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pgn"))
}

/// Fails unless `path` is an existing `.pgn` file.
pub fn check_pgn_path(path: &Path) -> Result<(), String> {
    let name = file_name(path);
    if !is_pgn(path) {
        return Err(format!("{name} is not a PGN file"));
    }
    if !path.is_file() {
        return Err(format!("{name} no longer exists"));
    }
    Ok(())
}

/// Reads up to `MAX_GAMES` games from a PGN file.
pub fn read_pgn_file(path: PathBuf) -> Result<OpenedPgn, String> {
    check_pgn_path(&path)?;
    let name = file_name(&path);
    let file = File::open(&path).map_err(|e| format!("could not open {name}: {e}"))?;
    let parsed = pgn::parse(BufReader::new(file), MAX_GAMES)
        .map_err(|e| format!("could not read {name}: {e}"))?;
    Ok(OpenedPgn { name, path, parsed })
}

fn list(path: &Path) -> Result<Listing, String> {
    let name = file_name(path);
    let read = std::fs::read_dir(path).map_err(|e| format!("could not open {name}: {e}"))?;
    let mut entries: Vec<Entry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Hidden files stay hidden, as in Finder and Explorer.
            if name.starts_with('.') {
                return None;
            }
            let path = entry.path();
            // Follows symbolic links, so linked folders can be browsed too.
            let metadata = std::fs::metadata(&path).ok()?;
            let kind = if metadata.is_dir() {
                EntryKind::Folder
            } else if metadata.is_file() && is_pgn(&path) {
                EntryKind::Pgn
            } else {
                return None;
            };
            Some(Entry {
                size: if kind == EntryKind::Pgn {
                    metadata.len()
                } else {
                    0
                },
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
                name,
                path,
                kind,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        (a.kind == EntryKind::Pgn)
            .cmp(&(b.kind == EntryKind::Pgn))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        path: path.to_owned(),
        parent: path.parent().map(Path::to_owned),
        entries,
    })
}

/// Folders to start browsing from.
#[tauri::command]
pub fn files_places<R: Runtime>(app: AppHandle<R>) -> Vec<Place> {
    let paths = app.path();
    [
        ("Home", paths.home_dir()),
        ("Desktop", paths.desktop_dir()),
        ("Documents", paths.document_dir()),
        ("Downloads", paths.download_dir()),
    ]
    .into_iter()
    .filter_map(|(name, path)| {
        let path = path.ok().filter(|p| p.is_dir())?;
        Some(Place {
            name: name.into(),
            path,
        })
    })
    .collect()
}

/// The folders and PGN files in a folder.
#[tauri::command]
pub async fn files_list(path: PathBuf) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || list(&path))
        .await
        .map_err(|e| format!("listing the folder failed: {e}"))?
}

/// Asks for a folder to browse. Returns `None` when the dialog is cancelled.
#[tauri::command]
pub async fn files_pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose a folder with PGN files")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let chosen = rx
        .await
        .map_err(|_| "the folder dialog closed unexpectedly")?;
    chosen
        .map(|path| {
            path.into_path()
                .map_err(|e| format!("unsupported folder location: {e}"))
        })
        .transpose()
}

/// Reads the games of a PGN file, e.g. a recent file or one dropped on the window.
#[tauri::command]
pub async fn pgn_read_path(path: PathBuf) -> Result<OpenedPgn, String> {
    tauri::async_runtime::spawn_blocking(move || read_pgn_file(path))
        .await
        .map_err(|e| format!("reading the file failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_and_pgn_files_only() {
        let dir = std::env::temp_dir().join(format!("enpawssant-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Openings")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("b.PGN"), "1. e4 *").unwrap();
        std::fs::write(dir.join("a.pgn"), "1. d4 *").unwrap();
        std::fs::write(dir.join("notes.txt"), "meow").unwrap();

        let listing = list(&dir).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Openings", "a.pgn", "b.PGN"]);
        assert_eq!(listing.entries[1].size, 7);
        assert_eq!(listing.parent.as_deref(), dir.parent());

        let opened = read_pgn_file(dir.join("a.pgn")).unwrap();
        assert_eq!(opened.parsed.games.len(), 1);
        assert!(read_pgn_file(dir.join("notes.txt")).is_err());
        assert!(read_pgn_file(dir.join("missing.pgn")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
