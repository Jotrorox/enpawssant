//! The local game database: games imported from PGN files or saved from the board, kept in SQLite
//! with every main-line position indexed by its Zobrist hash. That makes searching by position and
//! the "My games" explorer a single index lookup, transpositions included.
//!
//! The database also remembers the names the user plays under, so the explorer can say how they
//! score in a position and their games can be searched for blunders (see `blunders.rs`).

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chess_core::AnalysisRoot;
use chess_core::index::{self, GameIndex};
use chess_core::pgn::{self, Game};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::explorer::{ExplorerMove, ExplorerResult};
use crate::store::{self, Store};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    white TEXT NOT NULL,
    black TEXT NOT NULL,
    white_elo INTEGER,
    black_elo INTEGER,
    result TEXT NOT NULL,
    date TEXT NOT NULL,
    event TEXT NOT NULL,
    site TEXT NOT NULL,
    eco TEXT NOT NULL,
    opening TEXT NOT NULL,
    plies INTEGER NOT NULL,
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    -- Hash of the tags that identify a game and its main line, to skip duplicates.
    fingerprint BLOB NOT NULL UNIQUE,
    pgn TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_white ON games (white COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS games_black ON games (black COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS games_date ON games (date DESC, id DESC);
CREATE TABLE IF NOT EXISTS positions (
    key INTEGER NOT NULL,
    game_id INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,
    -- The move played from here, packed by `chess_core::index::pack_move`.
    next INTEGER,
    PRIMARY KEY (key, game_id, ply)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS positions_game ON positions (game_id);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// Games per transaction while importing.
const BATCH: usize = 500;
/// Progress is reported at most this often.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
/// Search results per page, at most.
const MAX_PAGE: u32 = 500;
/// Error messages kept from an import.
const MAX_MESSAGES: usize = 20;
/// The `meta` key of the user's player names, one per line.
const MY_NAMES: &str = "my_names";
/// Player names the user can give, at most.
const MAX_NAMES: usize = 20;
const MAX_NAME_LENGTH: usize = 100;
/// Frequent players offered as the user's names.
const SUGGESTIONS: u32 = 6;

pub struct Database {
    store: Store,
    importing: AtomicBool,
    cancel: Arc<AtomicBool>,
}

impl Default for Database {
    fn default() -> Self {
        Database {
            store: Store::new("games.sqlite", SCHEMA),
            importing: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

// --- Writing games ------------------------------------------------------------------------------

/// The columns of a game row, read from its tags and index.
struct GameRecord {
    white: String,
    black: String,
    white_elo: Option<u32>,
    black_elo: Option<u32>,
    result: String,
    date: String,
    event: String,
    site: String,
    eco: String,
    opening: String,
    fingerprint: Vec<u8>,
    pgn: String,
    index: GameIndex,
}

impl GameRecord {
    fn new(game: &Game) -> Result<GameRecord, String> {
        let index = index::index_game(game)?;
        let pgn = pgn::write(game)?;
        let tag = |name: &str| {
            game.headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.trim())
                .filter(|value| !value.is_empty() && !value.chars().all(|c| matches!(c, '?' | '.')))
                .unwrap_or("")
                .to_owned()
        };
        let elo = |name: &str| tag(name).parse().ok().filter(|elo| *elo > 0);
        let (eco, opening) = match (&index.opening, tag("ECO"), tag("Opening")) {
            (_, eco, opening) if !opening.is_empty() => (eco, opening),
            (Some(named), _, _) => (named.eco.clone(), named.name.clone()),
            (None, eco, _) => (eco, String::new()),
        };

        let mut hash = Sha256::new();
        for name in ["White", "Black", "Date", "Round", "Event", "Site", "Result"] {
            hash.update(tag(name));
            hash.update([0]);
        }
        hash.update(&game.start_fen);
        for mv in &game.moves {
            hash.update([0]);
            hash.update(&mv.uci);
        }

        Ok(GameRecord {
            white: tag("White"),
            black: tag("Black"),
            white_elo: elo("WhiteElo"),
            black_elo: elo("BlackElo"),
            result: match tag("Result").as_str() {
                result @ ("1-0" | "0-1" | "1/2-1/2") => result.to_owned(),
                _ => "*".to_owned(),
            },
            date: tag("Date"),
            event: tag("Event"),
            site: tag("Site"),
            eco,
            opening,
            fingerprint: hash.finalize().to_vec(),
            pgn,
            index,
        })
    }

    /// Inserts the game and its positions. Returns `None` when it is already in the database.
    fn insert(&self, tx: &Connection, source: &str) -> rusqlite::Result<Option<i64>> {
        let inserted = tx
            .prepare_cached(
                "INSERT OR IGNORE INTO games (white, black, white_elo, black_elo, result, date,
                    event, site, eco, opening, plies, source, added_at, fingerprint, pgn)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            )?
            .execute(params![
                self.white,
                self.black,
                self.white_elo,
                self.black_elo,
                self.result,
                self.date,
                self.event,
                self.site,
                self.eco,
                self.opening,
                self.index.plies,
                source,
                store::now(),
                self.fingerprint,
                self.pgn,
            ])?;
        if inserted == 0 {
            return Ok(None);
        }
        let id = tx.last_insert_rowid();
        let mut positions = tx.prepare_cached(
            "INSERT OR IGNORE INTO positions (key, game_id, ply, next) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for position in &self.index.positions {
            positions.execute(params![position.key, id, position.ply, position.next])?;
        }
        Ok(Some(id))
    }
}

/// Progress of an import, sent while it runs.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// Name of the file being read.
    file: String,
    files_done: usize,
    files_total: usize,
    /// Bytes read from all files so far, and their total size.
    bytes_read: u64,
    bytes_total: u64,
    imported: u64,
    duplicates: u64,
    /// Games that could not be read or stored.
    failed: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    imported: u64,
    duplicates: u64,
    failed: u64,
    cancelled: bool,
    /// The first few reasons games failed.
    messages: Vec<String>,
}

/// Counts the bytes read through it, for progress.
struct Counting<R> {
    inner: R,
    count: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/// Imports PGN files into `conn`, reporting progress on `channel`. Games are committed in batches,
/// so a cancelled import keeps what it had read.
fn import_files(
    conn: &Connection,
    paths: &[PathBuf],
    cancel: &AtomicBool,
    channel: &Channel<ImportProgress>,
) -> Result<ImportSummary, String> {
    let bytes_total = paths
        .iter()
        .map(|path| std::fs::metadata(path).map_or(0, |m| m.len()))
        .sum();
    let read = Arc::new(AtomicU64::new(0));
    let mut progress = ImportProgress {
        files_total: paths.len(),
        bytes_total,
        ..ImportProgress::default()
    };
    let mut messages = Vec::new();
    let mut cancelled = false;
    let mut last_report = Instant::now();

    for path in paths {
        let name = crate::files::file_name(path);
        progress.file = name.clone();
        let _ = channel.send(progress.clone());
        let file = File::open(path).map_err(|e| format!("could not open {name}: {e}"))?;
        let reader = BufReader::with_capacity(
            1 << 16,
            Counting {
                inner: file,
                count: read.clone(),
            },
        );

        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let mut in_batch = 0;
        let mut failure: Option<String> = None;
        let outcome = pgn::read_games(reader, |result| {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                return ControlFlow::Break(());
            }
            match result.and_then(|imported| GameRecord::new(&imported.game)) {
                Ok(record) => match record.insert(conn, &name) {
                    Ok(Some(_)) => progress.imported += 1,
                    Ok(None) => progress.duplicates += 1,
                    Err(e) => {
                        failure = Some(format!("could not store a game: {e}"));
                        return ControlFlow::Break(());
                    }
                },
                Err(message) => {
                    progress.failed += 1;
                    if messages.len() < MAX_MESSAGES {
                        messages.push(format!("{name}: {message}"));
                    }
                }
            }
            in_batch += 1;
            if in_batch >= BATCH {
                in_batch = 0;
                if let Err(e) = conn.execute_batch("COMMIT; BEGIN") {
                    failure = Some(e.to_string());
                    return ControlFlow::Break(());
                }
            }
            if last_report.elapsed() >= PROGRESS_INTERVAL {
                last_report = Instant::now();
                progress.bytes_read = read.load(Ordering::Relaxed);
                let _ = channel.send(progress.clone());
            }
            ControlFlow::Continue(())
        });
        let error = match (outcome, failure) {
            (_, Some(failure)) => Some(failure),
            (Err(e), None) => Some(format!("could not read {name}: {e}")),
            (Ok(_), None) => None,
        };
        if let Some(error) = error {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        progress.files_done += 1;
        if cancelled {
            break;
        }
    }
    progress.bytes_read = read.load(Ordering::Relaxed);
    let _ = channel.send(progress.clone());
    Ok(ImportSummary {
        imported: progress.imported,
        duplicates: progress.duplicates,
        failed: progress.failed,
        cancelled,
        messages,
    })
}

// --- Reading games ------------------------------------------------------------------------------

/// What to look for. Every field that is set must match.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    /// Matches players, event, site and opening.
    text: Option<String>,
    /// Matches either player.
    player: Option<String>,
    /// Matches the ECO code (as a prefix) or the opening name.
    opening: Option<String>,
    /// `1-0`, `0-1` or `1/2-1/2`.
    result: Option<String>,
    /// Games that reached this position in their main line.
    fen: Option<String>,
    /// Only games the user played, under one of their names.
    mine: bool,
    offset: u32,
    limit: u32,
}

/// A game as listed in search results.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSummary {
    id: i64,
    white: String,
    black: String,
    white_elo: Option<u32>,
    black_elo: Option<u32>,
    result: String,
    date: String,
    event: String,
    site: String,
    eco: String,
    opening: String,
    plies: u32,
    /// For position searches: the first ply at which the game reached the position.
    ply: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    games: Vec<GameSummary>,
    /// Matching games in all, of which `games` is one page.
    total: u64,
}

/// `%text%` for `LIKE … ESCAPE '\'`.
fn contains(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn search(conn: &Connection, query: &SearchQuery) -> Result<SearchResult, String> {
    let mut joins = String::new();
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let mut ply = "NULL";

    if let Some(fen) = query
        .fen
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        let key = index::fen_key(fen).map_err(|e| e.to_string())?;
        joins.push_str(
            " JOIN (SELECT game_id, MIN(ply) AS ply FROM positions WHERE key = ? GROUP BY game_id)
               AS hit ON hit.game_id = games.id",
        );
        values.push(Value::Integer(key));
        ply = "hit.ply";
    }
    let filled = |field: &Option<String>| {
        field
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    if let Some(text) = filled(&query.text) {
        // Every word must match somewhere, so `carlsen sicilian` finds Carlsen's Sicilians.
        for word in text.split_whitespace() {
            conditions.push(
                "(white LIKE ?1 ESCAPE '\\' OR black LIKE ?1 ESCAPE '\\' OR event LIKE ?1 ESCAPE '\\'
                  OR site LIKE ?1 ESCAPE '\\' OR opening LIKE ?1 ESCAPE '\\' OR eco LIKE ?1 ESCAPE '\\')"
                    .replace("?1", &format!("?{}", values.len() + 1)),
            );
            values.push(Value::Text(contains(word)));
        }
    }
    if let Some(player) = filled(&query.player) {
        let n = values.len() + 1;
        conditions.push(format!(
            "(white LIKE ?{n} ESCAPE '\\' OR black LIKE ?{n} ESCAPE '\\')"
        ));
        values.push(Value::Text(contains(&player)));
    }
    if let Some(opening) = filled(&query.opening) {
        let n = values.len() + 1;
        conditions.push(format!(
            "(eco LIKE ?{} ESCAPE '\\' OR opening LIKE ?{n} ESCAPE '\\')",
            n + 1
        ));
        values.push(Value::Text(contains(&opening)));
        values.push(Value::Text(format!("{}%", opening.to_uppercase())));
    }
    if let Some(result) = filled(&query.result) {
        conditions.push(format!("result = ?{}", values.len() + 1));
        values.push(Value::Text(result));
    }
    if query.mine {
        let names = my_names(conn).map_err(|e| e.to_string())?;
        let n = values.len() + 1;
        conditions.push(format!(
            "(white COLLATE NOCASE IN (SELECT value FROM json_each(?{n}))
              OR black COLLATE NOCASE IN (SELECT value FROM json_each(?{n})))"
        ));
        values.push(Value::Text(names_json(&names)));
    }
    // The FEN parameter is positional (`?`), so the numbered ones start after it.
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    let total: u64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM games{joins}{filter}"),
            params_from_iter(values.iter()),
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let limit = query.limit.clamp(1, MAX_PAGE);
    let sql = format!(
        "SELECT id, white, black, white_elo, black_elo, result, date, event, site, eco, opening,
                plies, {ply}
         FROM games{joins}{filter}
         ORDER BY date DESC, id DESC
         LIMIT {limit} OFFSET {}",
        query.offset
    );
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let games = statement
        .query_map(params_from_iter(values.iter()), |row| {
            Ok(GameSummary {
                id: row.get(0)?,
                white: row.get(1)?,
                black: row.get(2)?,
                white_elo: row.get(3)?,
                black_elo: row.get(4)?,
                result: row.get(5)?,
                date: row.get(6)?,
                event: row.get(7)?,
                site: row.get(8)?,
                eco: row.get(9)?,
                opening: row.get(10)?,
                plies: row.get(11)?,
                ply: row.get(12)?,
            })
        })
        .and_then(Iterator::collect)
        .map_err(|e| e.to_string())?;
    Ok(SearchResult { games, total })
}

/// A colour the user played, to explore only those games.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    White,
    Black,
}

/// Move statistics for a position from the games in the database, or only from the games in which
/// the user had `side`.
fn explorer(
    conn: &Connection,
    root: &AnalysisRoot,
    side: Option<Side>,
) -> rusqlite::Result<ExplorerResult> {
    let key = index::fen_key(&root.fen()).expect("the root's FEN is valid");
    let (filter, names) = match side {
        None => ("", String::new()),
        Some(side) => (
            match side {
                Side::White => {
                    "WHERE games.white COLLATE NOCASE IN (SELECT value FROM json_each(?2))"
                }
                Side::Black => {
                    "WHERE games.black COLLATE NOCASE IN (SELECT value FROM json_each(?2))"
                }
            },
            names_json(&my_names(conn)?),
        ),
    };
    // A game that repeats the position counts once per move played from it.
    let mut statement = conn.prepare_cached(&format!(
        "SELECT hit.next, games.result, COUNT(*),
                AVG(CASE WHEN white_elo IS NOT NULL AND black_elo IS NOT NULL
                         THEN (white_elo + black_elo) / 2.0 END)
         FROM (SELECT DISTINCT game_id, next FROM positions WHERE key = ?1) AS hit
         JOIN games ON games.id = hit.game_id
         {filter}
         GROUP BY hit.next, games.result"
    ))?;
    let params: Vec<Value> = if side.is_some() {
        vec![Value::Integer(key), Value::Text(names)]
    } else {
        vec![Value::Integer(key)]
    };
    let rows = statement.query_map(params_from_iter(params.iter()), |row| {
        Ok((
            row.get::<_, Option<u16>>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, u64>(2)?,
            row.get::<_, Option<f64>>(3)?,
        ))
    })?;

    #[derive(Default)]
    struct Tally {
        white: u64,
        draws: u64,
        black: u64,
        rating_sum: f64,
        rated: u64,
    }
    let mut moves: BTreeMap<u16, Tally> = BTreeMap::new();
    let mut total = Tally::default();
    for row in rows {
        let (next, result, count, rating) = row?;
        let add = |tally: &mut Tally| {
            match result.as_str() {
                "1-0" => tally.white += count,
                "0-1" => tally.black += count,
                "1/2-1/2" => tally.draws += count,
                _ => {}
            }
            if let Some(rating) = rating {
                tally.rating_sum += rating * count as f64;
                tally.rated += count;
            }
        };
        if let Some(next) = next {
            add(moves.entry(next).or_default());
        }
        add(&mut total);
    }

    let mut moves: Vec<ExplorerMove> = moves
        .into_iter()
        .filter_map(|(packed, tally)| {
            let uci = index::unpack_move(packed)?;
            let san = root.line_to_san(&[&uci]).pop()?.san;
            Some(ExplorerMove {
                uci,
                san,
                white: tally.white,
                draws: tally.draws,
                black: tally.black,
                average_rating: (tally.rated > 0)
                    .then(|| (tally.rating_sum / tally.rated as f64).round() as u32),
            })
        })
        .collect();
    moves.sort_by_key(|m| std::cmp::Reverse(m.white + m.draws + m.black));
    Ok(ExplorerResult {
        white: total.white,
        draws: total.draws,
        black: total.black,
        moves,
    })
}

// --- The user's names ---------------------------------------------------------------------------

/// Trims names and drops blanks and repeats (ignoring case), keeping the first spelling.
fn clean_names(names: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    names
        .into_iter()
        .map(|name| {
            name.chars()
                .filter(|c| !c.is_control())
                .take(MAX_NAME_LENGTH)
                .collect::<String>()
                .trim()
                .to_owned()
        })
        .filter(|name| !name.is_empty() && seen.insert(name.to_lowercase()))
        .take(MAX_NAMES)
        .collect()
}

/// The names the user plays under.
pub(crate) fn my_names(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [MY_NAMES], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(value
        .map(|value| value.lines().map(str::to_owned).collect())
        .unwrap_or_default())
}

fn set_my_names(conn: &Connection, names: Vec<String>) -> rusqlite::Result<Vec<String>> {
    let names = clean_names(names);
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![MY_NAMES, names.join("\n")],
    )?;
    Ok(names)
}

/// Names as a JSON array, for `json_each` in queries.
fn names_json(names: &[String]) -> String {
    serde_json::to_string(names).expect("strings serialise")
}

/// The players with the most games, as suggestions for the user's own names.
fn frequent_players(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare_cached(
        "SELECT name FROM (SELECT white AS name FROM games UNION ALL SELECT black FROM games)
         WHERE name NOT IN ('', '?')
         GROUP BY name COLLATE NOCASE
         ORDER BY COUNT(*) DESC, name
         LIMIT ?1",
    )?;
    statement
        .query_map([SUGGESTIONS], |row| row.get(0))?
        .collect()
}

/// A game the user played, as the blunder search reads it.
pub(crate) struct OwnGame {
    /// Identifies the game across databases: its fingerprint in hex.
    pub fingerprint: String,
    pub game: Game,
    pub white: String,
    pub black: String,
    pub date: String,
    pub event: String,
}

impl Database {
    /// The user's names and the fingerprints of the games they played, newest first.
    pub(crate) async fn own_games<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<(Vec<String>, Vec<String>), String> {
        self.store
            .run(app, |conn| {
                let names = my_names(conn)?;
                let mut statement = conn.prepare_cached(
                    "SELECT hex(fingerprint) FROM games
                     WHERE white COLLATE NOCASE IN (SELECT value FROM json_each(?1))
                        OR black COLLATE NOCASE IN (SELECT value FROM json_each(?1))
                     ORDER BY date DESC, id DESC",
                )?;
                let games = statement
                    .query_map([names_json(&names)], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                Ok((names, games))
            })
            .await
    }

    /// Reads one of the user's games by fingerprint; `None` if it was deleted.
    pub(crate) async fn own_game<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        fingerprint: String,
    ) -> Result<Option<OwnGame>, String> {
        let Some(blob) = from_hex(&fingerprint) else {
            return Ok(None);
        };
        let row = self
            .store
            .run(app, move |conn| {
                conn.query_row(
                    "SELECT pgn, white, black, date, event FROM games WHERE fingerprint = ?1",
                    [blob],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()
            })
            .await?;
        let Some((pgn, white, black, date, event)) = row else {
            return Ok(None);
        };
        Ok(Some(OwnGame {
            game: index::game_from_pgn(&pgn)?,
            fingerprint,
            white,
            black,
            date,
            event,
        }))
    }
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || !hex.is_ascii() {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

// --- Commands -----------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    games: u64,
    /// Where the database file is, to show in the UI.
    path: String,
}

#[tauri::command]
pub async fn db_stats<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
) -> Result<DatabaseStats, String> {
    let path = db.store.path(&app)?.display().to_string();
    let games = db
        .store
        .run(&app, |conn| {
            conn.query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
        })
        .await?;
    Ok(DatabaseStats { games, path })
}

#[tauri::command]
pub async fn db_search<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    query: SearchQuery,
) -> Result<SearchResult, String> {
    db.store
        .run(&app, move |conn| Ok(search(conn, &query)))
        .await?
}

/// A stored game, ready to open in a tab.
#[tauri::command]
pub async fn db_game<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    id: i64,
) -> Result<Game, String> {
    let text: Option<String> = db
        .store
        .run(&app, move |conn| {
            conn.query_row("SELECT pgn FROM games WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()
        })
        .await?;
    index::game_from_pgn(&text.ok_or("the game is no longer in the database")?)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedGame {
    id: Option<i64>,
    /// The game was already in the database.
    duplicate: bool,
}

/// Saves a game, e.g. the one on the board.
#[tauri::command]
pub async fn db_add_game<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    game: Game,
) -> Result<AddedGame, String> {
    let record = GameRecord::new(&game)?;
    db.store
        .run(&app, move |conn| {
            let tx = conn.transaction()?;
            let id = record.insert(&tx, "Board")?;
            tx.commit()?;
            Ok(AddedGame {
                id,
                duplicate: id.is_none(),
            })
        })
        .await
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedGames {
    imported: u64,
    duplicates: u64,
    failed: u64,
}

/// Saves several games at once, e.g. ones fetched from Lichess or Chess.com. `source` names where
/// they came from.
#[tauri::command]
pub async fn db_add_games<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    games: Vec<Game>,
    source: String,
) -> Result<AddedGames, String> {
    let mut added = AddedGames::default();
    let records: Vec<GameRecord> = games
        .iter()
        .filter_map(|game| GameRecord::new(game).ok())
        .collect();
    added.failed = (games.len() - records.len()) as u64;
    db.store
        .run(&app, move |conn| {
            let tx = conn.transaction()?;
            for record in &records {
                match record.insert(&tx, &source)? {
                    Some(_) => added.imported += 1,
                    None => added.duplicates += 1,
                }
            }
            tx.commit()?;
            Ok(added)
        })
        .await
}

#[tauri::command]
pub async fn db_delete_game<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    id: i64,
) -> Result<(), String> {
    db.store
        .run(&app, move |conn| {
            conn.execute("DELETE FROM games WHERE id = ?1", [id])
                .map(|_| ())
        })
        .await
}

/// Deletes every game.
#[tauri::command]
pub async fn db_clear<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
) -> Result<(), String> {
    if db.importing.load(Ordering::SeqCst) {
        return Err("wait for the import to finish first".into());
    }
    db.store
        .run(&app, |conn| {
            conn.execute_batch("DELETE FROM positions; DELETE FROM games; VACUUM;")
        })
        .await
}

/// Move statistics for `fen` from the database, for the explorer's "My games" tab: from every
/// game, or with `side` only from the games in which the user played that colour.
#[tauri::command]
pub async fn db_explorer<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    fen: String,
    side: Option<Side>,
) -> Result<ExplorerResult, String> {
    let root = AnalysisRoot::from_fen(&fen).map_err(|e| e.to_string())?;
    db.store
        .run(&app, move |conn| explorer(conn, &root, side))
        .await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyNames {
    names: Vec<String>,
    /// The players with the most games, to pick from.
    suggestions: Vec<String>,
}

/// The names the user plays under, and suggestions from the database.
#[tauri::command]
pub async fn db_my_names<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
) -> Result<MyNames, String> {
    db.store
        .run(&app, |conn| {
            Ok(MyNames {
                names: my_names(conn)?,
                suggestions: frequent_players(conn)?,
            })
        })
        .await
}

/// Sets the names the user plays under and returns them cleaned up.
#[tauri::command]
pub async fn db_set_my_names<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    names: Vec<String>,
) -> Result<Vec<String>, String> {
    db.store
        .run(&app, move |conn| set_my_names(conn, names))
        .await
}

/// The ID of the game with this fingerprint (in hex), if it is still in the database.
#[tauri::command]
pub async fn db_find_game<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    fingerprint: String,
) -> Result<Option<i64>, String> {
    let Some(blob) = from_hex(&fingerprint) else {
        return Ok(None);
    };
    db.store
        .run(&app, move |conn| {
            conn.query_row(
                "SELECT id FROM games WHERE fingerprint = ?1",
                [blob],
                |row| row.get(0),
            )
            .optional()
        })
        .await
}

/// Asks for PGN files and imports them. Returns `None` when the dialog is cancelled.
#[tauri::command]
pub async fn db_import_files<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    on_progress: Channel<ImportProgress>,
) -> Result<Option<ImportSummary>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Import PGN files into the database")
        .add_filter("PGN", &["pgn"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let Some(chosen) = rx
        .await
        .map_err(|_| "the file dialog closed unexpectedly")?
    else {
        return Ok(None);
    };
    let paths = chosen
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|e| format!("unsupported file location: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    import(&app, &db, paths, on_progress).await.map(Some)
}

/// Imports PGN files by path, e.g. dropped on the window or chosen in the file browser.
#[tauri::command]
pub async fn db_import_paths<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: Vec<PathBuf>,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportSummary, String> {
    for path in &paths {
        crate::files::check_pgn_path(path)?;
    }
    import(&app, &db, paths, on_progress).await
}

/// Stops the running import after the game it is reading.
#[tauri::command]
pub fn db_cancel_import(db: State<'_, Database>) {
    db.cancel.store(true, Ordering::SeqCst);
}

async fn import<R: Runtime>(
    app: &AppHandle<R>,
    db: &Database,
    paths: Vec<PathBuf>,
    channel: Channel<ImportProgress>,
) -> Result<ImportSummary, String> {
    if db.importing.swap(true, Ordering::SeqCst) {
        return Err("another import is still running".into());
    }
    db.cancel.store(false, Ordering::SeqCst);
    let conn = db.store.connect(app);
    let cancel = db.cancel.clone();
    let result = match conn {
        Ok(conn) => tauri::async_runtime::spawn_blocking(move || {
            import_files(&conn, &paths, &cancel, &channel)
        })
        .await
        .map_err(|e| format!("the import failed: {e}"))
        .and_then(|result| result),
        Err(e) => Err(e),
    };
    db.importing.store(false, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::configure(&conn, SCHEMA).unwrap();
        conn
    }

    fn add(conn: &mut Connection, pgn_text: &str) -> Option<i64> {
        let game = pgn::parse_str(pgn_text, 1).games.remove(0).game;
        let record = GameRecord::new(&game).unwrap();
        let tx = conn.transaction().unwrap();
        let id = record.insert(&tx, "test").unwrap();
        tx.commit().unwrap();
        id
    }

    fn query(build: impl FnOnce(&mut SearchQuery)) -> SearchQuery {
        let mut query = SearchQuery {
            limit: 50,
            ..SearchQuery::default()
        };
        build(&mut query);
        query
    }

    const RUY: &str = "[White \"Whiskers\"]\n[Black \"Mochi\"]\n[WhiteElo \"2100\"]\n[BlackElo \"1900\"]\n[Result \"1-0\"]\n[Date \"2026.01.02\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0";
    const ITALIAN: &str = "[White \"Mochi\"]\n[Black \"Tofu\"]\n[Result \"0-1\"]\n[Date \"2026.03.04\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 0-1";
    const QUEENS: &str = "[White \"Tofu\"]\n[Black \"Whiskers\"]\n[Result \"1/2-1/2\"]\n[Event \"Sunday nap\"]\n\n1. d4 d5 2. c4 1/2-1/2";

    #[test]
    fn skips_duplicates_and_names_openings() {
        let mut conn = database();
        assert!(add(&mut conn, RUY).is_some());
        assert_eq!(add(&mut conn, RUY), None);
        let found = search(&conn, &query(|_| {})).unwrap();
        assert_eq!(found.total, 1);
        let game = &found.games[0];
        assert_eq!(
            (game.white.as_str(), game.black.as_str()),
            ("Whiskers", "Mochi")
        );
        assert_eq!((game.white_elo, game.result.as_str()), (Some(2100), "1-0"));
        assert_eq!(game.eco, "C70");
        assert!(game.opening.starts_with("Ruy Lopez"), "{}", game.opening);
        assert_eq!(game.plies, 6);
    }

    #[test]
    fn searches_by_text_player_opening_result_and_position() {
        let mut conn = database();
        for pgn_text in [RUY, ITALIAN, QUEENS] {
            add(&mut conn, pgn_text);
        }
        let names = |query: SearchQuery| -> Vec<String> {
            search(&conn, &query)
                .unwrap()
                .games
                .into_iter()
                .map(|g| format!("{}-{}", g.white, g.black))
                .collect()
        };
        // Newest first; games without a date last.
        assert_eq!(
            names(query(|q| q.player = Some("whisk".into()))),
            ["Whiskers-Mochi", "Tofu-Whiskers"]
        );
        assert_eq!(
            names(query(|q| q.text = Some("mochi italian".into()))),
            ["Mochi-Tofu"]
        );
        assert_eq!(
            names(query(|q| q.text = Some("nap".into()))),
            ["Tofu-Whiskers"]
        );
        assert_eq!(
            names(query(|q| q.opening = Some("d0".into()))),
            ["Tofu-Whiskers"]
        );
        assert_eq!(
            names(query(|q| q.result = Some("0-1".into()))),
            ["Mochi-Tofu"]
        );
        // `%` is not a wildcard.
        assert!(names(query(|q| q.text = Some("%".into()))).is_empty());

        // After 1. e4 e5 2. Nf3 Nc6 both open games match, at ply 4.
        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        let found = search(&conn, &query(|q| q.fen = Some(fen.into()))).unwrap();
        assert_eq!(found.total, 2);
        assert!(found.games.iter().all(|g| g.ply == Some(4)));
        let found = search(
            &conn,
            &query(|q| {
                q.fen = Some(fen.into());
                q.player = Some("tofu".into());
            }),
        )
        .unwrap();
        assert_eq!(found.total, 1);
        assert!(search(&conn, &query(|q| q.fen = Some("nonsense".into()))).is_err());

        let page = search(
            &conn,
            &query(|q| {
                q.limit = 1;
                q.offset = 1;
            }),
        )
        .unwrap();
        assert_eq!((page.total, page.games.len()), (3, 1));
        assert_eq!(page.games[0].white, "Whiskers");
    }

    #[test]
    fn explores_positions() {
        let mut conn = database();
        for pgn_text in [RUY, ITALIAN, QUEENS] {
            add(&mut conn, pgn_text);
        }
        let root = AnalysisRoot::from_fen(pgn::STARTING_FEN).unwrap();
        let result = explorer(&conn, &root, None).unwrap();
        assert_eq!((result.white, result.draws, result.black), (1, 1, 1));
        assert_eq!(result.moves.len(), 2);
        assert_eq!(result.moves[0].san, "e4");
        assert_eq!((result.moves[0].white, result.moves[0].black), (1, 1));
        assert_eq!(result.moves[0].average_rating, Some(2000));
        assert_eq!(result.moves[1].san, "d4");
        assert_eq!(result.moves[1].average_rating, None);

        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
        let result = explorer(&conn, &AnalysisRoot::from_fen(fen).unwrap(), None).unwrap();
        let sans: Vec<_> = result.moves.iter().map(|m| m.san.as_str()).collect();
        assert_eq!(sans.len(), 2);
        assert!(sans.contains(&"Bb5") && sans.contains(&"Bc4"));
    }

    #[test]
    fn remembers_the_users_names_and_explores_their_games() {
        let mut conn = database();
        for pgn_text in [RUY, ITALIAN, QUEENS] {
            add(&mut conn, pgn_text);
        }
        assert!(my_names(&conn).unwrap().is_empty());
        let suggestions = frequent_players(&conn).unwrap();
        assert_eq!(suggestions.len(), 3);
        let saved = set_my_names(
            &conn,
            vec![" mochi ".into(), "".into(), "MOCHI".into(), "Mochi2".into()],
        )
        .unwrap();
        assert_eq!(saved, ["mochi", "Mochi2"]);
        assert_eq!(my_names(&conn).unwrap(), saved);

        // Mochi had Black in the Ruy Lopez (lost) and White in the Italian (lost).
        let root = AnalysisRoot::from_fen(pgn::STARTING_FEN).unwrap();
        let white = explorer(&conn, &root, Some(Side::White)).unwrap();
        assert_eq!((white.white, white.draws, white.black), (0, 0, 1));
        let black = explorer(&conn, &root, Some(Side::Black)).unwrap();
        assert_eq!((black.white, black.draws, black.black), (1, 0, 0));
        assert_eq!(black.moves[0].san, "e4");

        let mine = search(&conn, &query(|q| q.mine = true)).unwrap();
        assert_eq!(mine.total, 2);
        set_my_names(&conn, Vec::new()).unwrap();
        assert_eq!(search(&conn, &query(|q| q.mine = true)).unwrap().total, 0);
        let none = explorer(&conn, &root, Some(Side::White)).unwrap();
        assert!(none.moves.is_empty());
    }

    #[test]
    fn decodes_fingerprints() {
        assert_eq!(from_hex("00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(from_hex("0"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn deleting_a_game_removes_its_positions() {
        let mut conn = database();
        let id = add(&mut conn, RUY).unwrap();
        conn.execute("DELETE FROM games WHERE id = ?1", [id])
            .unwrap();
        let left: u64 = conn
            .query_row("SELECT COUNT(*) FROM positions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn imports_files_in_batches() {
        let dir = std::env::temp_dir().join(format!("enpawssant-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("games.pgn");
        let mut text = String::new();
        for round in 0..(BATCH + 20) {
            text.push_str(&format!("[Round \"{round}\"]\n\n1. e4 e5 *\n\n"));
        }
        text.push_str("[FEN \"not a fen\"]\n\n1. e4 *\n\n");
        text.push_str("[Round \"0\"]\n\n1. e4 e5 *\n");
        std::fs::write(&path, text).unwrap();

        let conn = database();
        let channel = Channel::new(|_| Ok(()));
        let summary = import_files(&conn, &[path], &AtomicBool::new(false), &channel).unwrap();
        assert_eq!(summary.imported, BATCH as u64 + 20);
        assert_eq!(summary.duplicates, 1);
        assert_eq!(summary.failed, 1);
        assert!(!summary.cancelled);
        assert_eq!(summary.messages.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
