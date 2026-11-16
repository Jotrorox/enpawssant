//! Chess logic for EnPawssant.
//!
//! This crate must stay independent of Tauri so it can be tested and reused
//! without the desktop shell.

pub mod pgn;
pub mod uci;

use std::fmt;

pub use shakmaty;
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
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
#[derive(Clone, Debug)]
pub struct AnalysisRoot {
    pos: Chess,
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
        Ok(AnalysisRoot { pos })
    }

    /// The position as a normalised FEN, to hand to the engine so that it and
    /// this root agree on castling rights and en passant.
    pub fn fen(&self) -> String {
        Fen::from_position(&self.pos, EnPassantMode::Legal).to_string()
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
    fn tolerates_bad_castling_rights_but_not_illegal_positions() {
        let root = AnalysisRoot::from_fen("4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1").unwrap();
        assert_eq!(root.fen(), "4k3/8/8/8/8/8/8/4K3 w - - 0 1");
        assert!(AnalysisRoot::from_fen("8/8/8/8/8/8/8/8 w - - 0 1").is_err());
        assert!(AnalysisRoot::from_fen("not a fen").is_err());
    }
}
