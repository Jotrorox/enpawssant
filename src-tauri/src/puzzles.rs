//! Puzzles ("Purrzles"): puzzles from the Lichess puzzle database (CC0) in SQLite, with a puzzle
//! rating for the player and streaks.
//!
//! A starter pack of a few thousand puzzles is bundled, so puzzles work offline right away. The
//! full database (millions of puzzles, about 300 MB compressed) can be downloaded from the app;
//! only well-liked, often played puzzles are kept from it.
//!
//! Puzzles made from the user's own blunders (`blunders.rs`) live here too, in a table of their
//! own, and are played unrated in "My blunders" mode: new ones first, then the ones missed last
//! time.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::ops::ControlFlow;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chess_core::puzzle::{self, Puzzle};
use rusqlite::{Connection, OptionalExtension, params};
use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::io::AsyncWriteExt;

use crate::store::{self, Store};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    -- UCI moves separated by spaces, starting with the opponent's.
    moves TEXT NOT NULL,
    rating INTEGER NOT NULL,
    popularity INTEGER NOT NULL,
    plays INTEGER NOT NULL,
    themes TEXT NOT NULL,
    game_url TEXT NOT NULL,
    opening TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS puzzles_rating ON puzzles (rating);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    puzzle_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    mode TEXT NOT NULL,
    solved INTEGER NOT NULL,
    rating_before INTEGER NOT NULL,
    rating_after INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_puzzle ON attempts (puzzle_id);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Puzzles from the user's own games: the position before their blunder, one move early.
CREATE TABLE IF NOT EXISTS own_puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    moves TEXT NOT NULL,
    themes TEXT NOT NULL,
    -- The game's fingerprint in the game database, in hex.
    game TEXT NOT NULL,
    -- Moves played in the game before the blunder.
    ply INTEGER NOT NULL,
    -- The blunder, in SAN, and the winning chances it gave away in percentage points.
    played TEXT NOT NULL,
    loss REAL NOT NULL,
    white TEXT NOT NULL,
    black TEXT NOT NULL,
    date TEXT NOT NULL,
    event TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
-- Games already searched for blunders, by fingerprint.
CREATE TABLE IF NOT EXISTS scanned_games (
    game TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    found INTEGER NOT NULL
);
";

const DATABASE_URL: &str = "https://database.lichess.org/lichess_db_puzzle.csv.zst";
const DOWNLOAD_FILE: &str = "lichess_db_puzzle.csv.zst";
/// Puzzles kept from the full database: well liked, played often and with a settled rating.
const MIN_POPULARITY: i32 = 90;
const MIN_PLAYS: u32 = 1000;
const MAX_RATING_DEVIATION: u32 = 80;
/// Puzzles per transaction while importing.
const BATCH: usize = 5000;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

const START_RATING: f64 = 1500.0;
const MIN_RATING: f64 = 400.0;
const MAX_RATING: f64 = 3200.0;
/// Rated puzzles after which the rating moves more slowly.
const PROVISIONAL: u32 = 20;
/// Rating windows tried in turn when looking for an unseen puzzle.
const WINDOWS: [u32; 5] = [75, 150, 300, 600, 4000];
/// Attempts returned as recent history.
const HISTORY: u32 = 40;

pub struct Puzzles {
    store: Store,
    downloading: AtomicBool,
    cancel: Arc<AtomicBool>,
}

impl Default for Puzzles {
    fn default() -> Self {
        Puzzles {
            store: Store::new("puzzles.sqlite", SCHEMA),
            downloading: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

// --- Rating -------------------------------------------------------------------------------------

/// The player's rating after a rated puzzle: Elo against the puzzle's rating, moving faster while
/// the rating is new.
fn rate(rating: f64, puzzle_rating: u32, solved: bool, rated_count: u32) -> f64 {
    let expected = 1.0 / (1.0 + 10f64.powf((f64::from(puzzle_rating) - rating) / 400.0));
    let k = if rated_count < PROVISIONAL {
        40.0
    } else {
        20.0
    };
    let score = if solved { 1.0 } else { 0.0 };
    (rating + k * (score - expected)).clamp(MIN_RATING, MAX_RATING)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    rating: f64,
    /// Rated puzzles played.
    rated: u32,
    solved: u32,
    failed: u32,
    /// Rated puzzles solved in a row, and the most ever.
    solve_streak: u32,
    best_solve_streak: u32,
    /// The longest run in streak mode.
    best_run: u32,
}

fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

fn meta_set(conn: &Connection, key: &str, value: impl ToString) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map(|_| ())
}

fn meta_number<T: std::str::FromStr>(
    conn: &Connection,
    key: &str,
    default: T,
) -> rusqlite::Result<T> {
    Ok(meta_get(conn, key)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(default))
}

fn profile(conn: &Connection) -> rusqlite::Result<Profile> {
    let (solved, failed) = conn.query_row(
        "SELECT COALESCE(SUM(solved), 0), COALESCE(SUM(1 - solved), 0) FROM attempts",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(Profile {
        rating: meta_number(conn, "rating", START_RATING)?,
        rated: meta_number(conn, "rated", 0)?,
        solved,
        failed,
        solve_streak: meta_number(conn, "solve_streak", 0)?,
        best_solve_streak: meta_number(conn, "best_solve_streak", 0)?,
        best_run: meta_number(conn, "best_run", 0)?,
    })
}

// --- Puzzles ------------------------------------------------------------------------------------

/// A puzzle as the frontend plays it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleData {
    id: String,
    fen: String,
    moves: Vec<String>,
    rating: u32,
    popularity: i32,
    plays: u32,
    themes: Vec<String>,
    game_url: String,
    /// For puzzles from the user's own games: where the puzzle comes from.
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
}

/// The game a puzzle from the user's blunders comes from.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// The game's fingerprint in the game database, in hex.
    pub game: String,
    /// Moves played in the game before the blunder.
    pub ply: u32,
    /// The move played in the game, in SAN.
    pub played: String,
    /// Winning chances the move gave away, in percentage points.
    pub loss: f64,
    pub white: String,
    pub black: String,
    pub date: String,
    pub event: String,
}

/// A puzzle made from one of the user's blunders, ready to store.
#[derive(Clone, Debug, PartialEq)]
pub struct OwnPuzzle {
    pub id: String,
    /// The position before the opponent's move that came before the blunder.
    pub fen: String,
    /// UCI moves, starting with that opponent's move.
    pub moves: Vec<String>,
    pub themes: Vec<String>,
    pub origin: Origin,
}

fn insert_own_puzzle(conn: &Connection, puzzle: &OwnPuzzle) -> rusqlite::Result<()> {
    let origin = &puzzle.origin;
    conn.prepare_cached(
        "INSERT OR REPLACE INTO own_puzzles
            (id, fen, moves, themes, game, ply, played, loss, white, black, date, event, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    )?
    .execute(params![
        puzzle.id,
        puzzle.fen,
        puzzle.moves.join(" "),
        puzzle.themes.join(" "),
        origin.game,
        origin.ply,
        origin.played,
        origin.loss,
        origin.white,
        origin.black,
        origin.date,
        origin.event,
        store::now(),
    ])
    .map(|_| ())
}

/// Stores the puzzles found in a game and marks it as searched, all at once.
fn save_scan(conn: &mut Connection, game: &str, found: &[OwnPuzzle]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for puzzle in found {
        insert_own_puzzle(&tx, puzzle)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO scanned_games (game, at, found) VALUES (?1, ?2, ?3)",
        params![game, store::now(), found.len()],
    )?;
    tx.commit()
}

impl Puzzles {
    /// Fingerprints of the games already searched for blunders.
    pub(crate) async fn scanned_games<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<HashSet<String>, String> {
        self.store
            .run(app, |conn| {
                let mut statement = conn.prepare_cached("SELECT game FROM scanned_games")?;
                statement.query_map([], |row| row.get(0))?.collect()
            })
            .await
    }

    /// Stores the puzzles found in a game and marks it as searched.
    pub(crate) async fn save_scan<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        game: String,
        found: Vec<OwnPuzzle>,
    ) -> Result<(), String> {
        self.store
            .run(app, move |conn| save_scan(conn, &game, &found))
            .await
    }
}

fn insert_puzzle(conn: &Connection, puzzle: &Puzzle) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT OR REPLACE INTO puzzles
            (id, fen, moves, rating, popularity, plays, themes, game_url, opening)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![
        puzzle.id,
        puzzle.fen,
        puzzle.moves.join(" "),
        puzzle.rating,
        puzzle.popularity,
        puzzle.plays,
        puzzle.themes.join(" "),
        puzzle.game_url,
        puzzle.opening_tags.join(" "),
    ])
    .map(|_| ())
}

/// Loads the bundled puzzles into an empty database.
fn ensure_starter(conn: &Connection) -> rusqlite::Result<()> {
    let count: u64 = conn.query_row("SELECT COUNT(*) FROM puzzles", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut failure = None;
        // Reading from memory cannot fail.
        let _ = puzzle::read_csv(puzzle::STARTER.as_bytes(), |puzzle| {
            match insert_puzzle(conn, &puzzle) {
                Ok(()) => ControlFlow::Continue(()),
                Err(e) => {
                    failure = Some(e);
                    ControlFlow::Break(())
                }
            }
        });
        if let Some(e) = failure {
            return Err(e);
        }
        meta_set(conn, "source", "starter")
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Puzzles around the player's rating, which changes with every puzzle.
    Rated,
    /// Puzzles that get harder with every solve; one mistake ends the run.
    Streak,
    /// Puzzles from the user's own blunders, unrated.
    Mine,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Rated => "rated",
            Mode::Streak => "streak",
            Mode::Mine => "mine",
        }
    }

    fn parse(text: &str) -> Mode {
        match text {
            "streak" => Mode::Streak,
            "mine" => Mode::Mine,
            _ => Mode::Rated,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextRequest {
    /// The rating to aim for, e.g. in streak mode; the player's rating when not given.
    target: Option<u32>,
    /// A Lichess theme key such as `fork`.
    theme: Option<String>,
    /// Puzzles not to repeat even when every puzzle has been seen, e.g. the current one.
    #[serde(default)]
    exclude: Vec<String>,
}

fn next_puzzle(conn: &Connection, request: &NextRequest) -> rusqlite::Result<Option<PuzzleData>> {
    let target = match request.target {
        Some(target) => f64::from(target),
        None => meta_number(conn, "rating", START_RATING)?,
    }
    .round() as i64;
    let theme = request
        .theme
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|t| format!("% {t} %"));
    let exclude = request.exclude.join(" ");

    let mut statement = conn.prepare_cached(
        "SELECT id, fen, moves, rating, popularity, plays, themes, game_url FROM puzzles
         WHERE rating BETWEEN ?1 AND ?2
           AND (?3 IS NULL OR (' ' || themes || ' ') LIKE ?3)
           AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM attempts WHERE puzzle_id = puzzles.id))
           AND instr(' ' || ?5 || ' ', ' ' || id || ' ') = 0
         ORDER BY random()
         LIMIT 1",
    )?;
    // Prefer puzzles never seen before; repeat old ones only once all are used up.
    for unseen in [true, false] {
        for window in WINDOWS {
            let window = i64::from(window);
            let found = statement
                .query_row(
                    params![target - window, target + window, theme, unseen, exclude],
                    |row| {
                        let moves: String = row.get(2)?;
                        let themes: String = row.get(6)?;
                        Ok(PuzzleData {
                            id: row.get(0)?,
                            fen: row.get(1)?,
                            moves: moves.split_whitespace().map(str::to_owned).collect(),
                            rating: row.get(3)?,
                            popularity: row.get(4)?,
                            plays: row.get(5)?,
                            themes: themes.split_whitespace().map(str::to_owned).collect(),
                            game_url: row.get(7)?,
                            origin: None,
                        })
                    },
                )
                .optional()?;
            if found.is_some() {
                return Ok(found);
            }
        }
    }
    Ok(None)
}

/// The next puzzle from the user's blunders: one never tried, else one missed last time, else the
/// one solved longest ago. `exclude` is skipped unless nothing else is left.
fn next_own_puzzle(conn: &Connection, exclude: &[String]) -> rusqlite::Result<Option<PuzzleData>> {
    let mut statement = conn.prepare_cached(
        "SELECT id, fen, moves, themes, game, ply, played, loss, white, black, date, event,
                (SELECT solved FROM attempts WHERE puzzle_id = own_puzzles.id
                 ORDER BY attempts.id DESC LIMIT 1) AS last_solved,
                (SELECT MAX(at) FROM attempts WHERE puzzle_id = own_puzzles.id) AS last_at
         FROM own_puzzles
         WHERE instr(' ' || ?1 || ' ', ' ' || id || ' ') = 0
         ORDER BY CASE WHEN last_solved IS NULL THEN 0 WHEN last_solved = 0 THEN 1 ELSE 2 END,
                  last_at, created_at DESC, random()
         LIMIT 1",
    )?;
    for excluded in [exclude.join(" "), String::new()] {
        let found = statement
            .query_row([excluded], |row| {
                let moves: String = row.get(2)?;
                let themes: String = row.get(3)?;
                Ok(PuzzleData {
                    id: row.get(0)?,
                    fen: row.get(1)?,
                    moves: moves.split_whitespace().map(str::to_owned).collect(),
                    rating: 0,
                    popularity: 0,
                    plays: 0,
                    themes: themes.split_whitespace().map(str::to_owned).collect(),
                    game_url: String::new(),
                    origin: Some(Origin {
                        game: row.get(4)?,
                        ply: row.get(5)?,
                        played: row.get(6)?,
                        loss: row.get(7)?,
                        white: row.get(8)?,
                        black: row.get(9)?,
                        date: row.get(10)?,
                        event: row.get(11)?,
                    }),
                })
            })
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    profile: Profile,
    /// How much the rating changed, for rated puzzles.
    rating_change: Option<f64>,
}

/// Records a finished puzzle. Only the first attempt at a puzzle in rated mode moves the rating.
fn record(
    conn: &mut Connection,
    id: &str,
    mode: Mode,
    solved: bool,
) -> rusqlite::Result<RecordResult> {
    let tx = conn.transaction()?;
    // Puzzles from the user's own games have no rating, and never move theirs.
    let puzzle_rating: u32 = if mode == Mode::Mine {
        tx.query_row("SELECT 0 FROM own_puzzles WHERE id = ?1", [id], |row| {
            row.get(0)
        })?
    } else {
        tx.query_row("SELECT rating FROM puzzles WHERE id = ?1", [id], |row| {
            row.get(0)
        })?
    };
    let seen: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM attempts WHERE puzzle_id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    let before: f64 = meta_number(&tx, "rating", START_RATING)?;
    let rated_count: u32 = meta_number(&tx, "rated", 0)?;
    let rated = mode == Mode::Rated && !seen;
    let after = if rated {
        rate(before, puzzle_rating, solved, rated_count)
    } else {
        before
    };
    tx.execute(
        "INSERT INTO attempts (puzzle_id, at, mode, solved, rating_before, rating_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            store::now(),
            mode.as_str(),
            solved,
            before.round() as i64,
            after.round() as i64
        ],
    )?;
    if rated {
        meta_set(&tx, "rating", after)?;
        meta_set(&tx, "rated", rated_count + 1)?;
    }
    if mode == Mode::Rated {
        let streak = if solved {
            meta_number(&tx, "solve_streak", 0u32)? + 1
        } else {
            0
        };
        meta_set(&tx, "solve_streak", streak)?;
        if streak > meta_number(&tx, "best_solve_streak", 0u32)? {
            meta_set(&tx, "best_solve_streak", streak)?;
        }
    }
    tx.commit()?;
    Ok(RecordResult {
        profile: profile(conn)?,
        rating_change: rated.then_some(after - before),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    puzzle_id: String,
    at: i64,
    mode: Mode,
    solved: bool,
    rating_after: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleStatus {
    /// Puzzles available.
    count: u64,
    /// `starter` for the bundled puzzles, `lichess` once the full database is in.
    source: String,
    profile: Profile,
    /// The latest attempts, newest first.
    history: Vec<Attempt>,
    own: OwnStatus,
}

/// The puzzles from the user's own blunders.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnStatus {
    count: u64,
    /// Never tried yet.
    fresh: u64,
    /// Missed the last time they were tried.
    missed: u64,
    /// Games searched for blunders so far.
    scanned_games: u64,
}

fn own_status(conn: &Connection) -> rusqlite::Result<OwnStatus> {
    conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(last_solved IS NULL), 0),
                COALESCE(SUM(last_solved = 0), 0),
                (SELECT COUNT(*) FROM scanned_games)
         FROM (SELECT (SELECT solved FROM attempts WHERE puzzle_id = own_puzzles.id
                       ORDER BY attempts.id DESC LIMIT 1) AS last_solved
               FROM own_puzzles)",
        [],
        |row| {
            Ok(OwnStatus {
                count: row.get(0)?,
                fresh: row.get(1)?,
                missed: row.get(2)?,
                scanned_games: row.get(3)?,
            })
        },
    )
}

fn status(conn: &Connection) -> rusqlite::Result<PuzzleStatus> {
    ensure_starter(conn)?;
    let count = conn.query_row("SELECT COUNT(*) FROM puzzles", [], |row| row.get(0))?;
    let mut statement = conn.prepare_cached(
        "SELECT puzzle_id, at, mode, solved, rating_after FROM attempts ORDER BY id DESC LIMIT ?1",
    )?;
    let history = statement
        .query_map([HISTORY], |row| {
            let mode: String = row.get(2)?;
            Ok(Attempt {
                puzzle_id: row.get(0)?,
                at: row.get(1)?,
                mode: Mode::parse(&mode),
                solved: row.get(3)?,
                rating_after: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(PuzzleStatus {
        count,
        source: meta_get(conn, "source")?.unwrap_or_else(|| "starter".into()),
        profile: profile(conn)?,
        history,
        own: own_status(conn)?,
    })
}

// --- Downloading the full database --------------------------------------------------------------

/// Reads every frame of a zstd stream, skipping skippable frames. The Lichess file is in the
/// seekable format, which has many of both.
struct ZstdFrames<R: BufRead> {
    source: R,
    frame: FrameDecoder,
    /// Whether a frame is being decoded.
    active: bool,
}

impl<R: BufRead> ZstdFrames<R> {
    fn new(source: R) -> Self {
        ZstdFrames {
            source,
            frame: FrameDecoder::new(),
            active: false,
        }
    }
}

impl<R: BufRead> Read for ZstdFrames<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.active {
                while self.frame.can_collect() == 0 && !self.frame.is_finished() {
                    self.frame
                        .decode_blocks(&mut self.source, BlockDecodingStrategy::UptoBlocks(1))
                        .map_err(std::io::Error::other)?;
                }
                let n = self.frame.read(buf)?;
                if n > 0 || buf.is_empty() {
                    return Ok(n);
                }
                self.active = false;
            }
            if self.source.fill_buf()?.is_empty() {
                return Ok(0);
            }
            match self.frame.init(&mut self.source) {
                Ok(()) => self.active = true,
                Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
                    length,
                    ..
                })) => {
                    let skipped = std::io::copy(
                        &mut (&mut self.source).take(u64::from(length)),
                        &mut std::io::sink(),
                    )?;
                    if skipped < u64::from(length) {
                        return Err(std::io::ErrorKind::UnexpectedEof.into());
                    }
                }
                Err(e) => return Err(std::io::Error::other(e)),
            }
        }
    }
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

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Download,
    Import,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    phase: Phase,
    /// Bytes of the compressed file downloaded or read so far, and its size if known.
    bytes: u64,
    total: Option<u64>,
    /// Puzzles imported so far.
    imported: u64,
}

fn keep(puzzle: &Puzzle) -> bool {
    puzzle.popularity >= MIN_POPULARITY
        && puzzle.plays >= MIN_PLAYS
        && puzzle.rating_deviation <= MAX_RATING_DEVIATION
}

/// Imports the puzzles from a zstd-compressed CSV file. Returns how many were imported, or `None`
/// when cancelled; puzzles imported until then are kept.
fn import_file(
    conn: &Connection,
    path: &std::path::Path,
    cancel: &AtomicBool,
    channel: &Channel<DownloadProgress>,
) -> Result<Option<u64>, String> {
    let total = std::fs::metadata(path).map(|m| m.len()).ok();
    let read = Arc::new(AtomicU64::new(0));
    let file = File::open(path).map_err(|e| format!("could not open the download: {e}"))?;
    let compressed = BufReader::with_capacity(
        1 << 16,
        Counting {
            inner: file,
            count: read.clone(),
        },
    );
    let csv = BufReader::with_capacity(1 << 16, ZstdFrames::new(compressed));

    let mut imported = 0u64;
    let mut in_batch = 0;
    let mut failure = None;
    let mut last_report = Instant::now();
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let stopped = puzzle::read_csv(csv, |puzzle| {
        if cancel.load(Ordering::Relaxed) {
            return ControlFlow::Break(());
        }
        if !keep(&puzzle) {
            return ControlFlow::Continue(());
        }
        if let Err(e) = insert_puzzle(conn, &puzzle) {
            failure = Some(e.to_string());
            return ControlFlow::Break(());
        }
        imported += 1;
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
            let _ = channel.send(DownloadProgress {
                phase: Phase::Import,
                bytes: read.load(Ordering::Relaxed),
                total,
                imported,
            });
        }
        ControlFlow::Continue(())
    });
    let error = match (stopped, failure) {
        (_, Some(failure)) => Some(failure),
        (Err(e), None) => Some(format!("could not read the puzzle database: {e}")),
        (Ok(_), None) => None,
    };
    if let Some(error) = error {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(error);
    }
    let cancelled = cancel.load(Ordering::Relaxed);
    if !cancelled {
        meta_set(conn, "source", "lichess").map_err(|e| e.to_string())?;
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok((!cancelled).then_some(imported))
}

async fn download(
    target: &std::path::Path,
    cancel: &AtomicBool,
    channel: &Channel<DownloadProgress>,
) -> Result<bool, String> {
    let http = reqwest::Client::builder()
        .user_agent(concat!(
            "EnPawssant/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/Jotrorox/enpawssant)"
        ))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = http
        .get(DATABASE_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("could not reach database.lichess.org: {e}"))?;
    let total = response.content_length();
    let mut file = tokio::fs::File::create(target)
        .await
        .map_err(|e| format!("could not save the download: {e}"))?;
    let mut bytes = 0u64;
    let mut last_report = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        // A stalled connection would otherwise wait forever.
        let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| "the download stalled".to_string())?
            .map_err(|e| format!("the download failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not save the download: {e}"))?;
        bytes += chunk.len() as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            last_report = Instant::now();
            let _ = channel.send(DownloadProgress {
                phase: Phase::Download,
                bytes,
                total,
                imported: 0,
            });
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("could not save the download: {e}"))?;
    if total.is_some_and(|total| total != bytes) {
        return Err("the download ended early".into());
    }
    Ok(true)
}

// --- Commands -----------------------------------------------------------------------------------

#[tauri::command]
pub async fn puzzles_status<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
) -> Result<PuzzleStatus, String> {
    puzzles.store.run(&app, |conn| status(conn)).await
}

/// A puzzle to play, or `None` when no puzzle matches.
#[tauri::command]
pub async fn puzzles_next<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
    request: NextRequest,
) -> Result<Option<PuzzleData>, String> {
    puzzles
        .store
        .run(&app, move |conn| {
            ensure_starter(conn)?;
            next_puzzle(conn, &request)
        })
        .await
}

/// A puzzle from the user's own blunders, or `None` when there are none yet.
#[tauri::command]
pub async fn puzzles_next_own<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
    exclude: Vec<String>,
) -> Result<Option<PuzzleData>, String> {
    puzzles
        .store
        .run(&app, move |conn| next_own_puzzle(conn, &exclude))
        .await
}

/// Forgets the puzzles from the user's games and which games were searched, e.g. after they
/// changed their names. Attempts at them go too.
#[tauri::command]
pub async fn puzzles_clear_own<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
) -> Result<PuzzleStatus, String> {
    puzzles
        .store
        .run(&app, |conn| {
            conn.execute_batch(
                "DELETE FROM attempts WHERE mode = 'mine';
                 DELETE FROM own_puzzles;
                 DELETE FROM scanned_games;",
            )?;
            status(conn)
        })
        .await
}

#[tauri::command]
pub async fn puzzles_record<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
    id: String,
    mode: Mode,
    solved: bool,
) -> Result<RecordResult, String> {
    puzzles
        .store
        .run(&app, move |conn| record(conn, &id, mode, solved))
        .await
}

/// Records the length of a finished streak-mode run and returns the updated profile.
#[tauri::command]
pub async fn puzzles_finish_run<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
    length: u32,
) -> Result<Profile, String> {
    puzzles
        .store
        .run(&app, move |conn| {
            if length > meta_number(conn, "best_run", 0u32)? {
                meta_set(conn, "best_run", length)?;
            }
            profile(conn)
        })
        .await
}

/// Forgets the rating, streaks and every attempt. The puzzles stay.
#[tauri::command]
pub async fn puzzles_reset_progress<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
) -> Result<PuzzleStatus, String> {
    puzzles
        .store
        .run(&app, |conn| {
            conn.execute_batch(
                "DELETE FROM attempts;
                 DELETE FROM meta WHERE key IN
                    ('rating', 'rated', 'solve_streak', 'best_solve_streak', 'best_run');",
            )?;
            status(conn)
        })
        .await
}

/// Downloads the full Lichess puzzle database and imports the best puzzles from it. Returns how
/// many were imported, or `None` when cancelled.
#[tauri::command]
pub async fn puzzles_download<R: Runtime>(
    app: AppHandle<R>,
    puzzles: State<'_, Puzzles>,
    on_progress: Channel<DownloadProgress>,
) -> Result<Option<u64>, String> {
    if puzzles.downloading.swap(true, Ordering::SeqCst) {
        return Err("the puzzles are already downloading".into());
    }
    puzzles.cancel.store(false, Ordering::SeqCst);
    let result = download_and_import(&app, &puzzles, on_progress).await;
    puzzles.downloading.store(false, Ordering::SeqCst);
    result
}

async fn download_and_import<R: Runtime>(
    app: &AppHandle<R>,
    puzzles: &Puzzles,
    channel: Channel<DownloadProgress>,
) -> Result<Option<u64>, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not find the cache folder: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(DOWNLOAD_FILE);

    let downloaded = download(&path, &puzzles.cancel, &channel).await;
    let result = match downloaded {
        Ok(true) => {
            let conn = puzzles.store.connect(app)?;
            let cancel = puzzles.cancel.clone();
            let file = path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                import_file(&conn, &file, &cancel, &channel)
            })
            .await
            .map_err(|e| format!("the import failed: {e}"))
            .and_then(|result| result)
        }
        Ok(false) => Ok(None),
        Err(e) => Err(e),
    };
    // The download is only needed for the import.
    let _ = std::fs::remove_file(&path);
    result
}

#[tauri::command]
pub fn puzzles_cancel_download(puzzles: State<'_, Puzzles>) {
    puzzles.cancel.store(true, Ordering::SeqCst);
}

/// Opens the game a puzzle comes from on lichess.org in the browser. Other addresses are refused,
/// so the frontend can't open arbitrary links or programs.
#[tauri::command]
pub fn puzzles_open_game(url: String) -> Result<(), String> {
    if !is_lichess_url(&url) {
        return Err("only lichess.org games can be opened".into());
    }
    open::that_detached(&url).map_err(|e| format!("could not open the browser: {e}"))
}

fn is_lichess_url(url: &str) -> bool {
    url::Url::parse(url)
        .is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some("lichess.org"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::configure(&conn, SCHEMA).unwrap();
        ensure_starter(&conn).unwrap();
        conn
    }

    fn request(target: Option<u32>) -> NextRequest {
        NextRequest {
            target,
            theme: None,
            exclude: Vec::new(),
        }
    }

    #[test]
    fn only_opens_lichess_games() {
        assert!(is_lichess_url("https://lichess.org/787zsVup/black#48"));
        assert!(!is_lichess_url("http://lichess.org/787zsVup"));
        assert!(!is_lichess_url("https://lichess.org.evil.example/x"));
        assert!(!is_lichess_url("file:///etc/passwd"));
    }

    #[test]
    fn rating_moves_toward_results() {
        // An even match moves the rating by half of K.
        assert!((rate(1500.0, 1500, true, 0) - 1520.0).abs() < 1e-9);
        assert!((rate(1500.0, 1500, false, 50) - 1490.0).abs() < 1e-9);
        // Solving an easy puzzle earns little; failing it costs a lot.
        assert!(rate(1800.0, 1200, true, 50) - 1800.0 < 1.0);
        assert!(1800.0 - rate(1800.0, 1200, false, 50) > 19.0);
        assert_eq!(rate(MIN_RATING, 3000, false, 50), MIN_RATING);
    }

    #[test]
    fn loads_the_starter_pack_once() {
        let conn = database();
        let first = status(&conn).unwrap();
        assert!(first.count > 2000);
        assert_eq!(first.source, "starter");
        assert_eq!(first.profile.rating, START_RATING);
        ensure_starter(&conn).unwrap();
        assert_eq!(status(&conn).unwrap().count, first.count);
    }

    #[test]
    fn picks_puzzles_near_the_target_and_by_theme() {
        let conn = database();
        let puzzle = next_puzzle(&conn, &request(Some(1000))).unwrap().unwrap();
        assert!((925..=1075).contains(&puzzle.rating), "{}", puzzle.rating);
        assert!(puzzle.moves.len() >= 2);

        let mut themed = request(None);
        themed.theme = Some("mateIn1".into());
        let puzzle = next_puzzle(&conn, &themed).unwrap().unwrap();
        assert!(puzzle.themes.iter().any(|t| t == "mateIn1"));
        // Anything but a plain theme key is ignored rather than put into the query.
        themed.theme = Some("%' OR 1=1".into());
        assert!(next_puzzle(&conn, &themed).unwrap().is_some());
        themed.theme = Some("noSuchTheme".into());
        assert_eq!(next_puzzle(&conn, &themed).unwrap(), None);
    }

    #[test]
    fn records_attempts_and_streaks() {
        let mut conn = database();
        let first = next_puzzle(&conn, &request(None)).unwrap().unwrap();
        let result = record(&mut conn, &first.id, Mode::Rated, true).unwrap();
        assert!(result.rating_change.unwrap() > 0.0);
        assert_eq!(result.profile.rated, 1);
        assert_eq!(result.profile.solve_streak, 1);

        // A seen puzzle is not offered again while unseen ones are left.
        let mut next = request(Some(first.rating));
        for _ in 0..20 {
            let other = next_puzzle(&conn, &next).unwrap().unwrap();
            assert_ne!(other.id, first.id);
        }
        // Playing it again does not move the rating.
        let again = record(&mut conn, &first.id, Mode::Rated, false).unwrap();
        assert_eq!(again.rating_change, None);
        assert_eq!(again.profile.solve_streak, 0);
        assert_eq!(again.profile.best_solve_streak, 1);

        // Streak mode never moves the rating.
        next.exclude = vec![first.id.clone()];
        let streak = next_puzzle(&conn, &next).unwrap().unwrap();
        let result = record(&mut conn, &streak.id, Mode::Streak, false).unwrap();
        assert_eq!(result.rating_change, None);
        assert_eq!(result.profile.failed, 2);
        assert_eq!(status(&conn).unwrap().history.len(), 3);
    }

    fn own_puzzle(id: &str, game: &str) -> OwnPuzzle {
        OwnPuzzle {
            id: id.into(),
            fen: "r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24".into(),
            moves: vec!["f2g3".into(), "e6e7".into()],
            themes: vec!["advantage".into(), "oneMove".into()],
            origin: Origin {
                game: game.into(),
                ply: 47,
                played: "Qh5".into(),
                loss: 31.5,
                white: "Mochi".into(),
                black: "Tofu".into(),
                date: "2026.05.06".into(),
                event: "Casual".into(),
            },
        }
    }

    #[test]
    fn plays_own_puzzles_new_ones_first_then_misses() {
        let mut conn = database();
        assert_eq!(next_own_puzzle(&conn, &[]).unwrap(), None);
        save_scan(
            &mut conn,
            "AA",
            &[own_puzzle("own-a", "AA"), own_puzzle("own-b", "AA")],
        )
        .unwrap();
        save_scan(&mut conn, "BB", &[]).unwrap();
        let own = status(&conn).unwrap().own;
        assert_eq!(
            (own.count, own.fresh, own.missed, own.scanned_games),
            (2, 2, 0, 2)
        );

        let first = next_own_puzzle(&conn, &[]).unwrap().unwrap();
        assert_eq!(first.origin.as_ref().unwrap().played, "Qh5");
        let rating = status(&conn).unwrap().profile.rating;
        let result = record(&mut conn, &first.id, Mode::Mine, false).unwrap();
        assert_eq!(result.rating_change, None);
        assert_eq!(result.profile.rating, rating);

        // The untried one comes next, then the missed one.
        let second = next_own_puzzle(&conn, &[]).unwrap().unwrap();
        assert_ne!(second.id, first.id);
        record(&mut conn, &second.id, Mode::Mine, true).unwrap();
        assert_eq!(next_own_puzzle(&conn, &[]).unwrap().unwrap().id, first.id);
        // Excluding the only candidate still finds a puzzle.
        assert!(
            next_own_puzzle(&conn, &[first.id.clone(), second.id.clone()])
                .unwrap()
                .is_some()
        );

        let own = status(&conn).unwrap().own;
        assert_eq!((own.fresh, own.missed), (0, 1));
        assert_eq!(status(&conn).unwrap().history[0].mode, Mode::Mine);
    }

    #[test]
    fn imports_compressed_puzzle_files() {
        let dir = std::env::temp_dir().join(format!("enpawssant-puzzles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("puzzles.csv.zst");
        let header = "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate\n";
        let good = "zz001,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1819,77,95,10446,crushing long,https://lichess.org/787zsVup#48,,\n";
        let unpopular = "zz002,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7,1819,77,40,10446,crushing,,,\n";
        // Two frames with a skippable frame between them, like the seekable format.
        let mut data = Vec::new();
        for part in [format!("{header}{good}"), unpopular.to_owned()] {
            data.extend(ruzstd::encoding::compress_to_vec(
                part.as_bytes(),
                ruzstd::encoding::CompressionLevel::Fastest,
            ));
            data.extend(0x184D_2A50u32.to_le_bytes());
            data.extend(4u32.to_le_bytes());
            data.extend([1, 2, 3, 4]);
        }
        std::fs::write(&path, data).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        store::configure(&conn, SCHEMA).unwrap();
        let channel = Channel::new(|_| Ok(()));
        let imported = import_file(&conn, &path, &AtomicBool::new(false), &channel).unwrap();
        assert_eq!(imported, Some(1));
        assert_eq!(
            meta_get(&conn, "source").unwrap().as_deref(),
            Some("lichess")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
