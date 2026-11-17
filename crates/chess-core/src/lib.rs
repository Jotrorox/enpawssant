//! Chess logic for EnPawssant.
//!
//! This crate must stay independent of Tauri so it can be tested and reused
//! without the desktop shell.

pub mod index;
pub mod openings;
pub mod pgn;
pub mod puzzle;
pub mod setup;
pub mod uci;

use std::fmt;

pub use shakmaty;
use shakmaty::fen::Fen;
use shakmaty::san::{San, SanPlus};
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, KnownOutcome, Position, PositionError};

use crate::uci::Score;

/// A FEN that does not describe a legal standard chess position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidFen(String);

impl fmt::Display for InvalidFen {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidFen {}

/// One move of an engine line, in both notations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineMove {
    pub uci: String,
    pub san: String,
}

/// The position an engine search starts from. Engine output refers to it, so it
/// converts lines to SAN and scores to White's point of view.
///
/// It may be reached by moves from an earlier position, which the engine is
/// then given too so it can see repetitions.
#[derive(Clone, Debug)]
pub struct AnalysisRoot {
    pos: Chess,
    /// The normalised FEN the moves start from.
    start: String,
    /// Standard UCI moves leading from `start` to `pos`.
    moves: Vec<String>,
}

impl AnalysisRoot {
    /// Parses a FEN, tolerating castling rights and en passant squares that
    /// don't match the board (they are dropped).
    pub fn from_fen(fen: &str) -> Result<AnalysisRoot, InvalidFen> {
        let parsed: Fen = fen
            .trim()
            .parse()
            .map_err(|e| InvalidFen(format!("invalid FEN: {e}")))?;
        let pos = parsed
            .into_position(CastlingMode::Standard)
            .or_else(PositionError::ignore_invalid_castling_rights)
            .or_else(PositionError::ignore_invalid_ep_square)
            .map_err(|e| InvalidFen(format!("illegal position: {e}")))?;
        Ok(AnalysisRoot {
            start: Fen::from_position(&pos, EnPassantMode::Legal).to_string(),
            pos,
            moves: Vec::new(),
        })
    }

    /// The position after playing `uci_moves` from `fen`.
    pub fn from_fen_and_moves<S: AsRef<str>>(
        fen: &str,
        uci_moves: &[S],
    ) -> Result<AnalysisRoot, InvalidFen> {
        let mut root = AnalysisRoot::from_fen(fen)?;
        for uci in uci_moves {
            let uci = uci.as_ref();
            let mv = uci
                .parse::<UciMove>()
                .ok()
                .and_then(|m| m.to_move(&root.pos).ok())
                .ok_or_else(|| InvalidFen(format!("illegal move: {uci}")))?;
            root.moves
                .push(mv.to_uci(CastlingMode::Standard).to_string());
            root.pos.play_unchecked(mv);
        }
        Ok(root)
    }

    /// The position as a normalised FEN.
    pub fn fen(&self) -> String {
        Fen::from_position(&self.pos, EnPassantMode::Legal).to_string()
    }

    /// The UCI `position` command for this root, with normalised castling
    /// rights and en passant so that the engine and this root agree on them.
    pub fn uci_position(&self) -> String {
        if self.moves.is_empty() {
            format!("position fen {}", self.start)
        } else {
            format!("position fen {} moves {}", self.start, self.moves.join(" "))
        }
    }

    pub fn turn(&self) -> Color {
        self.pos.turn()
    }

    pub fn legal_move_count(&self) -> usize {
        self.pos.legal_moves().len()
    }

    /// The result when the side to move has no legal moves (checkmate or
    /// stalemate). There is nothing for an engine to search in that case.
    pub fn final_outcome(&self) -> Option<KnownOutcome> {
        if !self.pos.legal_moves().is_empty() {
            return None;
        }
        Some(if self.pos.is_check() {
            KnownOutcome::Decisive {
                winner: !self.pos.turn(),
            }
        } else {
            KnownOutcome::Draw
        })
    }

    /// Converts a score reported for the side to move into White's point of view.
    pub fn white_score(&self, score: Score) -> Score {
        match self.pos.turn() {
            Color::White => score,
            Color::Black => score.flip(),
        }
    }

    /// Converts a line of UCI moves played from this position to SAN. The line
    /// is cut off at the first move that is malformed or illegal.
    pub fn line_to_san<S: AsRef<str>>(&self, uci_moves: &[S]) -> Vec<LineMove> {
        let mut pos = self.pos.clone();
        let mut line = Vec::with_capacity(uci_moves.len());
        for uci in uci_moves {
            let uci = uci.as_ref();
            let Some(mv) = uci
                .parse::<UciMove>()
                .ok()
                .and_then(|m| m.to_move(&pos).ok())
            else {
                break;
            };
            let san = SanPlus::from_move_and_play_unchecked(&mut pos, mv);
            line.push(LineMove {
                uci: uci.to_owned(),
                san: san.to_string(),
            });
        }
        line
    }

    /// The move `san` from this position in standard UCI notation (castling as
    /// `e1g1`, not `e1h1`), or `None` if it is not a legal move.
    pub fn san_to_uci(&self, san: &str) -> Option<String> {
        let mv = san.parse::<San>().ok()?.to_move(&self.pos).ok()?;
        Some(mv.to_uci(CastlingMode::Standard).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTING_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn sans(root: &AnalysisRoot, uci: &[&str]) -> Vec<String> {
        root.line_to_san(uci).into_iter().map(|m| m.san).collect()
    }

    #[test]
    fn starting_position_has_20_legal_moves() {
        let root = AnalysisRoot::from_fen(STARTING_FEN).unwrap();
        assert_eq!(root.legal_move_count(), 20);
        assert_eq!(root.fen(), STARTING_FEN);
    }

    #[test]
    fn converts_lines_to_san() {
        let root = AnalysisRoot::from_fen(
            "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
        )
        .unwrap();
        assert_eq!(
            sans(
                &root,
                &[
                    "d2d4", "e5d4", "c3d4", "c5b4", "c1d2", "b4d2", "b1d2", "e8g8"
                ]
            ),
            ["d4", "exd4", "cxd4", "Bb4+", "Bd2", "Bxd2+", "Nbxd2", "O-O"]
        );
    }

    #[test]
    fn converts_promotions_and_mates() {
        let root = AnalysisRoot::from_fen("7k/4P3/6K1/8/8/8/8/8 w - - 0 1").unwrap();
        assert_eq!(sans(&root, &["e7e8q"]), ["e8=Q#"]);
    }

    #[test]
    fn cuts_lines_at_illegal_moves() {
        let root = AnalysisRoot::from_fen(STARTING_FEN).unwrap();
        assert_eq!(sans(&root, &["e2e4", "e2e4", "d7d5"]), ["e4"]);
        assert_eq!(sans(&root, &["nonsense"]), Vec::<String>::new());
    }

    #[test]
    fn converts_san_to_standard_uci() {
        let root = AnalysisRoot::from_fen(
            "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
        )
        .unwrap();
        assert_eq!(root.san_to_uci("O-O").as_deref(), Some("e1g1"));
        assert_eq!(root.san_to_uci("d4").as_deref(), Some("d2d4"));
        assert_eq!(root.san_to_uci("Nxe5").as_deref(), Some("f3e5"));
        assert_eq!(root.san_to_uci("O-O-O"), None);
        assert_eq!(root.san_to_uci("nonsense"), None);
    }

    #[test]
    fn scores_are_from_whites_point_of_view() {
        let white = AnalysisRoot::from_fen(STARTING_FEN).unwrap();
        let black =
            AnalysisRoot::from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
                .unwrap();
        assert_eq!(white.white_score(Score::Cp(30)), Score::Cp(30));
        assert_eq!(black.white_score(Score::Cp(-30)), Score::Cp(30));
        assert_eq!(black.white_score(Score::Mate(2)), Score::Mate(-2));
        assert_eq!(black.white_score(Score::Mate(-4)), Score::Mate(4));
    }

    #[test]
    fn detects_finished_games() {
        let fools_mate = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
        assert_eq!(
            AnalysisRoot::from_fen(fools_mate).unwrap().final_outcome(),
            Some(KnownOutcome::Decisive {
                winner: Color::Black
            })
        );
        let stalemate = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
        assert_eq!(
            AnalysisRoot::from_fen(stalemate).unwrap().final_outcome(),
            Some(KnownOutcome::Draw)
        );
        assert_eq!(
            AnalysisRoot::from_fen(STARTING_FEN)
                .unwrap()
                .final_outcome(),
            None
        );
    }

    #[test]
    fn plays_moves_from_a_fen() {
        let root = AnalysisRoot::from_fen_and_moves(
            "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
            &["e1h1", "e8c8"],
        )
        .unwrap();
        assert_eq!(root.fen(), "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2");
        // Castling is passed on in standard notation.
        assert_eq!(
            root.uci_position(),
            "position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1g1 e8c8"
        );
        assert_eq!(
            AnalysisRoot::from_fen(STARTING_FEN).unwrap().uci_position(),
            format!("position fen {STARTING_FEN}")
        );
        assert!(AnalysisRoot::from_fen_and_moves(STARTING_FEN, &["e2e5"]).is_err());
    }

    #[test]
    fn tolerates_bad_castling_rights_but_not_illegal_positions() {
        let root = AnalysisRoot::from_fen("4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1").unwrap();
        assert_eq!(root.fen(), "4k3/8/8/8/8/8/8/4K3 w - - 0 1");
        assert!(AnalysisRoot::from_fen("8/8/8/8/8/8/8/8 w - - 0 1").is_err());
        assert!(AnalysisRoot::from_fen("not a fen").is_err());
    }
}
