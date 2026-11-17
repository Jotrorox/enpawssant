//! Puzzles from the user's own blunders: their games in the game database are searched with the
//! analysis engine for moves that threw away a good part of their winning chances. Where the
//! engine's better move was clearly the only good one, the position becomes a puzzle: "find the
//! move you missed", continued while each next move is just as clearly the only good one.
//!
//! The engine runs as a separate background process with half the cores (see
//! [`Engine::background`]), so the live analysis carries on meanwhile. Every searched game is
//! remembered, so the search picks up where it stopped and only looks at new games next time.
//!
//! Winning chances use the same formula as the game review (`src/chess/review.ts`), so a blunder
//! here is a blunder (`??`) there too.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chess_core::AnalysisRoot;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::database::{Database, OwnGame};
use crate::engine::{AnalysisUpdate, Engine, Line, WireScore};
use crate::engines::Engines;
use crate::puzzles::{Origin, OwnPuzzle, Puzzles};

/// Depth of the first pass over every position of a game.
const SCAN_DEPTH: u32 = 13;
/// Depth for checking a blunder and building its puzzle.
const VERIFY_DEPTH: u32 = 18;
/// Winning chances, in percentage points, a move must give away to count as a blunder.
const BLUNDER_LOSS: f64 = 15.0;
/// How much better than the second-best move a move must be to be the only good one.
const ONLY_MOVE_GAP: f64 = 10.0;
/// Moves the solver makes in a puzzle, at most.
const MAX_SOLVER_MOVES: usize = 3;
/// Puzzles kept from one game, the worst blunders first.
const MAX_PER_GAME: usize = 4;
/// Centipawns beyond this count as completely winning; mates count as this much.
const CP_CEILING: i32 = 1000;

pub struct Blunders {
    engine: Engine,
    running: AtomicBool,
    cancel: Arc<AtomicBool>,
}

impl Default for Blunders {
    fn default() -> Self {
        Blunders {
            engine: Engine::background(),
            running: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Blunders {
    /// Stops the background engine, e.g. when the app quits.
    pub async fn shutdown(&self) {
        self.engine.shutdown().await;
    }
}

// --- Judging moves ------------------------------------------------------------------------------

/// White's chance of winning in percent (0..100), with evaluations capped at ±10 pawns.
fn win_percent(white_cp: i32) -> f64 {
    let cp = f64::from(white_cp.clamp(-CP_CEILING, CP_CEILING));
    50.0 + 50.0 * (2.0 / (1.0 + (-0.003_682_08 * cp).exp()) - 1.0)
}

/// A score as centipawns for White, mates and finished games included.
fn score_cp(score: WireScore) -> i32 {
    match score {
        WireScore::Cp(cp) => cp,
        WireScore::Mate(moves) if moves > 0 => CP_CEILING,
        WireScore::Mate(_) => -CP_CEILING,
    }
}

/// The evaluation of a searched position as centipawns for White.
fn position_cp(update: &AnalysisUpdate) -> Option<i32> {
    match update.outcome {
        Some("1-0") => Some(CP_CEILING),
        Some("0-1") => Some(-CP_CEILING),
        Some(_) => Some(0),
        None => update.lines.first().map(|line| score_cp(line.score)),
    }
}

/// The winning chances of one side.
fn chances(white_cp: i32, white: bool) -> f64 {
    let win = win_percent(white_cp);
    if white { win } else { 100.0 - win }
}

fn mates_for(score: WireScore, white: bool) -> bool {
    matches!(score, WireScore::Mate(moves) if (moves > 0) == white)
}

/// Whether the best of `lines` (searched with MultiPV 2) is the only good move for the side to
/// move: the only mate, or clearly better than the next best move.
fn only_good_move(lines: &[Line], white: bool) -> bool {
    let [best, second, ..] = lines else {
        // A single legal move is the only one.
        return !lines.is_empty();
    };
    if mates_for(best.score, white) {
        return !mates_for(second.score, white);
    }
    chances(score_cp(best.score), white) - chances(score_cp(second.score), white) >= ONLY_MOVE_GAP
}

fn white_to_move(fen: &str) -> bool {
    fen.split_whitespace().nth(1) != Some("b")
}

/// Lichess-style themes for a puzzle: how it ends and how long it is.
fn themes(best: WireScore, white: bool, solver_moves: usize) -> Vec<String> {
    let mut themes = Vec::new();
    match best {
        WireScore::Mate(moves) if mates_for(best, white) => {
            themes.push("mate".to_owned());
            if moves.unsigned_abs() as usize == solver_moves {
                themes.push(format!("mateIn{solver_moves}"));
            }
        }
        _ => {
            let cp = score_cp(best);
            let own = if white { cp } else { -cp };
            themes.push(
                match own {
                    300.. => "crushing",
                    100.. => "advantage",
                    _ => "equality",
                }
                .to_owned(),
            );
        }
    }
    themes.push(
        match solver_moves {
            1 => "oneMove",
            2 => "short",
            _ => "long",
        }
        .to_owned(),
    );
    themes
}

// --- Searching games ----------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    games_done: u32,
    games_total: u32,
    /// Positions searched in the current game.
    positions_done: u32,
    positions_total: u32,
    /// Puzzles found so far.
    found: u32,
    /// The current game, e.g. `Mochi – Tofu`.
    game: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    /// Games searched in this run.
    scanned: u32,
    found: u32,
    cancelled: bool,
    /// The user's games still waiting to be searched.
    remaining: u32,
}

/// Searches positions to a depth: the background engine in the app, a plain Stockfish in tests.
trait Searcher {
    async fn search(&self, fen: &str, multipv: u32, depth: u32) -> Result<AnalysisUpdate, String>;
}

/// The user's analysis engine, as a background session.
struct BackgroundEngine<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    engine: &'a Engine,
    engines: &'a Engines,
    id: String,
}

impl<R: Runtime> Searcher for BackgroundEngine<'_, R> {
    async fn search(&self, fen: &str, multipv: u32, depth: u32) -> Result<AnalysisUpdate, String> {
        self.engine
            .search(self.app, self.engines, &self.id, fen, multipv, depth)
            .await
    }
}

/// What a game search needs: something to search with, a way to stop and where to report.
struct Scan<'a, S: Searcher> {
    searcher: S,
    cancel: &'a AtomicBool,
    on_progress: &'a (dyn Fn(&ScanProgress) + Sync),
    progress: ScanProgress,
}

/// Why a game search ended early.
enum Failure {
    Cancelled,
    Error(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Error(message)
    }
}

impl<S: Searcher> Scan<'_, S> {
    fn check(&self) -> Result<(), Failure> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(Failure::Cancelled)
        } else {
            Ok(())
        }
    }

    async fn search(&self, fen: &str, multipv: u32, depth: u32) -> Result<AnalysisUpdate, Failure> {
        self.check()?;
        let result = self.searcher.search(fen, multipv, depth).await;
        // Stopping the run stops the engine mid-search.
        self.check()?;
        Ok(result?)
    }

    fn report(&self) {
        (self.on_progress)(&self.progress);
    }

    /// Finds the puzzles in one of the user's games.
    async fn game(&mut self, own: &OwnGame, names: &[String]) -> Result<Vec<OwnPuzzle>, Failure> {
        let is_mine = |player: &str| names.iter().any(|n| n.eq_ignore_ascii_case(player.trim()));
        let (white_mine, black_mine) = (is_mine(&own.white), is_mine(&own.black));
        let game = &own.game;
        // `fens[i]` is the position before move `i`.
        let fens: Vec<&str> = std::iter::once(game.start_fen.as_str())
            .chain(game.moves.iter().map(|m| m.fen.as_str()))
            .collect();

        // Every position but the first: a puzzle needs the opponent's move before the blunder.
        self.progress.positions_done = 0;
        self.progress.positions_total = fens.len().saturating_sub(1) as u32;
        self.report();
        let mut evals: Vec<Option<i32>> = vec![None; fens.len()];
        for (i, fen) in fens.iter().enumerate().skip(1) {
            evals[i] = position_cp(&self.search(fen, 1, SCAN_DEPTH).await?);
            self.progress.positions_done += 1;
            self.report();
        }

        let mut candidates: Vec<(usize, f64)> = (1..game.moves.len())
            .filter_map(|i| {
                let white = white_to_move(fens[i]);
                if !(if white { white_mine } else { black_mine }) {
                    return None;
                }
                let loss = chances(evals[i]?, white) - chances(evals[i + 1]?, white);
                (loss >= BLUNDER_LOSS).then_some((i, loss))
            })
            .collect();
        candidates.sort_by(|a, b| b.1.total_cmp(&a.1));

        let mut found = Vec::new();
        for (ply, _) in candidates {
            if found.len() == MAX_PER_GAME {
                break;
            }
            if let Some(puzzle) = self.puzzle(own, &fens, ply).await? {
                found.push(puzzle);
            }
        }
        Ok(found)
    }

    /// Checks the blunder before move `ply` more deeply and builds its puzzle, if it makes one.
    async fn puzzle(
        &self,
        own: &OwnGame,
        fens: &[&str],
        ply: usize,
    ) -> Result<Option<OwnPuzzle>, Failure> {
        let game = &own.game;
        let fen = fens[ply];
        let white = white_to_move(fen);
        let played = &game.moves[ply];

        let before = self.search(fen, 2, VERIFY_DEPTH).await?;
        let Some(best) = before.lines.first() else {
            return Ok(None);
        };
        if best.uci.first() == Some(&played.uci) || !only_good_move(&before.lines, white) {
            return Ok(None);
        }
        let after = self.search(fens[ply + 1], 1, VERIFY_DEPTH).await?;
        let Some(after_cp) = position_cp(&after) else {
            return Ok(None);
        };
        let loss = chances(score_cp(best.score), white) - chances(after_cp, white);
        if loss < BLUNDER_LOSS {
            return Ok(None);
        }

        // The solution: the better move, then the engine's line while each move of the solver's
        // is the only good one.
        let mut solution = vec![best.uci[0].clone()];
        let mut line = best.uci.clone();
        while solution.len().div_ceil(2) < MAX_SOLVER_MOVES {
            let Some(reply) = line.get(1) else { break };
            let mut moves = solution.clone();
            moves.push(reply.clone());
            let Ok(root) = AnalysisRoot::from_fen_and_moves(fen, &moves) else {
                break;
            };
            if root.final_outcome().is_some() {
                break;
            }
            let next = self.search(&root.fen(), 2, VERIFY_DEPTH).await?;
            let Some(next_best) = next.lines.first() else {
                break;
            };
            if !only_good_move(&next.lines, white) {
                break;
            }
            solution.push(reply.clone());
            solution.push(next_best.uci[0].clone());
            line = next_best.uci.clone();
        }

        let solver_moves = solution.len().div_ceil(2);
        let mut moves = vec![game.moves[ply - 1].uci.clone()];
        moves.extend(solution);
        Ok(Some(OwnPuzzle {
            id: format!("own-{}-{ply}", fingerprint_prefix(&own.fingerprint)),
            fen: fens[ply - 1].to_owned(),
            moves,
            themes: themes(best.score, white, solver_moves),
            origin: Origin {
                game: own.fingerprint.clone(),
                ply: ply as u32,
                played: played.san.clone(),
                loss: (loss * 10.0).round() / 10.0,
                white: own.white.clone(),
                black: own.black.clone(),
                date: own.date.clone(),
                event: own.event.clone(),
            },
        }))
    }
}

async fn scan<R: Runtime>(
    app: &AppHandle<R>,
    blunders: &Blunders,
    db: &Database,
    puzzles: &Puzzles,
    engines: &Engines,
    channel: &Channel<ScanProgress>,
) -> Result<ScanSummary, String> {
    let (names, games) = db.own_games(app).await?;
    if names.is_empty() {
        return Err("tell Mochi your player names first".into());
    }
    if games.is_empty() {
        return Err(format!(
            "none of the games in the database were played by {}; import yours first",
            names.join(" or ")
        ));
    }
    let scanned = puzzles.scanned_games(app).await?;
    let pending: Vec<String> = games
        .into_iter()
        .filter(|game| !scanned.contains(game))
        .collect();

    let report = |progress: &ScanProgress| {
        let _ = channel.send(progress.clone());
    };
    let mut run = Scan {
        searcher: BackgroundEngine {
            app,
            engine: &blunders.engine,
            engines,
            id: engines.config(app).primary,
        },
        cancel: &blunders.cancel,
        on_progress: &report,
        progress: ScanProgress {
            games_total: pending.len() as u32,
            ..ScanProgress::default()
        },
    };
    let mut cancelled = false;
    for fingerprint in &pending {
        if run.check().is_err() {
            cancelled = true;
            break;
        }
        // Deleted since the list was read.
        let Some(own) = db.own_game(app, fingerprint.clone()).await? else {
            run.progress.games_done += 1;
            continue;
        };
        run.progress.game = format!("{} – {}", or_unknown(&own.white), or_unknown(&own.black));
        match run.game(&own, &names).await {
            Ok(found) => {
                run.progress.found += found.len() as u32;
                puzzles.save_scan(app, fingerprint.clone(), found).await?;
            }
            Err(Failure::Cancelled) => {
                cancelled = true;
                break;
            }
            Err(Failure::Error(message)) => return Err(message),
        }
        run.progress.games_done += 1;
        run.report();
    }
    let progress = run.progress;
    Ok(ScanSummary {
        scanned: progress.games_done,
        found: progress.found,
        cancelled,
        remaining: progress.games_total - progress.games_done,
    })
}

/// The start of a fingerprint, enough to tell games apart in puzzle IDs.
fn fingerprint_prefix(fingerprint: &str) -> &str {
    &fingerprint[..fingerprint.len().min(16)]
}

fn or_unknown(name: &str) -> &str {
    if name.is_empty() { "?" } else { name }
}

// --- Commands -----------------------------------------------------------------------------------

/// Searches the user's games that haven't been searched yet for blunders and turns them into
/// puzzles. Progress arrives on `on_progress`; puzzles are saved game by game, so stopping keeps
/// what was found.
#[tauri::command]
pub async fn puzzles_find_blunders<R: Runtime>(
    app: AppHandle<R>,
    blunders: State<'_, Blunders>,
    db: State<'_, Database>,
    puzzles: State<'_, Puzzles>,
    engines: State<'_, Engines>,
    on_progress: Channel<ScanProgress>,
) -> Result<ScanSummary, String> {
    if blunders.running.swap(true, Ordering::SeqCst) {
        return Err("Mochi is already looking through your games".into());
    }
    blunders.cancel.store(false, Ordering::SeqCst);
    let result = scan(&app, &blunders, &db, &puzzles, &engines, &on_progress).await;
    // The engine is only needed while searching.
    blunders.engine.shutdown().await;
    blunders.running.store(false, Ordering::SeqCst);
    result
}

/// Stops the blunder search; what it found so far is kept.
#[tauri::command]
pub async fn puzzles_cancel_blunders(blunders: State<'_, Blunders>) -> Result<(), String> {
    blunders.cancel.store(true, Ordering::SeqCst);
    // Quitting the engine ends the running search right away.
    blunders.engine.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chess_core::index;

    use super::*;
    use crate::engine::testing::LocalStockfish;

    impl Searcher for LocalStockfish {
        async fn search(
            &self,
            fen: &str,
            multipv: u32,
            depth: u32,
        ) -> Result<AnalysisUpdate, String> {
            LocalStockfish::search(self, fen, multipv, depth).await
        }
    }

    fn own_game(pgn: &str) -> OwnGame {
        let game = index::game_from_pgn(pgn).unwrap();
        let tag = |name: &str| {
            game.headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };
        OwnGame {
            fingerprint: "00112233445566778899AABBCCDDEEFF".into(),
            white: tag("White"),
            black: tag("Black"),
            date: tag("Date"),
            event: tag("Event"),
            game,
        }
    }

    /// Searches a game for puzzles with the bundled Stockfish.
    fn find(pgn: &str, names: &[&str]) -> Vec<OwnPuzzle> {
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        tauri::async_runtime::block_on(async {
            let cancel = AtomicBool::new(false);
            let mut scan = Scan {
                searcher: LocalStockfish::start(),
                cancel: &cancel,
                on_progress: &|_| {},
                progress: ScanProgress::default(),
            };
            match scan.game(&own_game(pgn), &names).await {
                Ok(found) => found,
                Err(Failure::Error(message)) => panic!("{message}"),
                Err(Failure::Cancelled) => panic!("cancelled"),
            }
        })
    }

    #[test]
    fn finds_a_missed_mate() {
        // After 3...Nf6?? White mates with 4. Qxf7#, but plays 4. d3.
        let pgn = "[White \"Mochi\"]\n[Black \"Tofu\"]\n[Date \"2026.05.06\"]\n\n\
            1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. d3 *";
        let found = find(pgn, &["mochi"]);
        assert_eq!(found.len(), 1, "{found:?}");
        let puzzle = &found[0];
        // One move early: Black's blunder first, then the mate.
        assert_eq!(puzzle.moves, ["g8f6", "h5f7"]);
        assert_eq!(puzzle.themes, ["mate", "mateIn1", "oneMove"]);
        assert_eq!(puzzle.origin.played, "d3");
        assert_eq!(puzzle.origin.ply, 6);
        assert_eq!(puzzle.origin.white, "Mochi");
        assert_eq!(puzzle.origin.date, "2026.05.06");
        assert!(puzzle.origin.loss >= BLUNDER_LOSS);
        assert!(puzzle.id.starts_with("own-0011223344556677-"));
    }

    #[test]
    fn finds_a_missed_capture_and_only_the_users_moves() {
        // 2...Qh4?? hangs the queen to 3. Nxh4, which White misses.
        let pgn = "[White \"Mochi\"]\n[Black \"Tofu\"]\n\n1. e4 e5 2. Nf3 Qh4 3. d3 *";
        let found = find(pgn, &["Mochi"]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].moves[..2], ["d8h4", "f3h4"]);
        assert_eq!(found[0].themes[0], "crushing");

        // Black's own blunder had plenty of good alternatives, so it makes no puzzle.
        assert!(find(pgn, &["Tofu"]).is_empty());
    }

    fn line(score: WireScore) -> Line {
        Line::for_tests(score, vec!["e2e4".into()])
    }

    #[test]
    fn judges_winning_chances_like_the_review() {
        assert!((win_percent(0) - 50.0).abs() < 1e-9);
        assert!(win_percent(5000) > 97.0 && win_percent(5000) == win_percent(CP_CEILING));
        assert!((chances(300, true) + chances(300, false) - 100.0).abs() < 1e-9);
        // Dropping a piece in a level position is a blunder; a pawn's worth isn't.
        assert!(chances(0, true) - chances(-300, true) >= BLUNDER_LOSS);
        assert!(chances(0, true) - chances(-80, true) < BLUNDER_LOSS);
        assert_eq!(score_cp(WireScore::Mate(-2)), -CP_CEILING);
    }

    #[test]
    fn finds_only_good_moves() {
        let win = WireScore::Cp(400);
        let equal = WireScore::Cp(0);
        assert!(only_good_move(&[line(win), line(equal)], true));
        assert!(!only_good_move(
            &[line(win), line(WireScore::Cp(350))],
            true
        ));
        // From Black's side, +4 for White is bad, so a level line is clearly better.
        assert!(only_good_move(&[line(equal), line(win)], false));
        // The only mate is the only good move; one of two mates is not.
        assert!(only_good_move(&[line(WireScore::Mate(2)), line(win)], true));
        assert!(!only_good_move(
            &[line(WireScore::Mate(2)), line(WireScore::Mate(3))],
            true
        ));
        assert!(only_good_move(&[line(win)], true));
        assert!(!only_good_move(&[], true));
    }

    #[test]
    fn names_puzzle_themes() {
        assert_eq!(
            themes(WireScore::Mate(2), true, 2),
            ["mate", "mateIn2", "short"]
        );
        assert_eq!(themes(WireScore::Mate(-3), false, 1), ["mate", "oneMove"]);
        assert_eq!(
            themes(WireScore::Cp(-450), false, 1),
            ["crushing", "oneMove"]
        );
        assert_eq!(themes(WireScore::Cp(150), true, 3), ["advantage", "long"]);
        assert_eq!(themes(WireScore::Cp(20), true, 1), ["equality", "oneMove"]);
    }

    #[test]
    fn reads_the_side_to_move() {
        assert!(white_to_move(chess_core::pgn::STARTING_FEN));
        assert!(!white_to_move(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        ));
    }
}
