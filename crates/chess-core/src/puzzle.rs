//! Puzzles in the format of the [Lichess puzzle database](https://database.lichess.org/#puzzles).
//!
//! A puzzle starts one move before the position the solver sees: the first move is the opponent's,
//! and the solver plays every second move after it.

use std::io::BufRead;
use std::ops::ControlFlow;

use shakmaty::Position;
use shakmaty::uci::UciMove;

use crate::AnalysisRoot;

/// The puzzles bundled with the app, in the database's CSV format with a header line.
pub const STARTER: &str = include_str!("../data/puzzles/starter.csv");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Puzzle {
    pub id: String,
    /// The position before the opponent's first move.
    pub fen: String,
    /// UCI moves, starting with the opponent's.
    pub moves: Vec<String>,
    pub rating: u32,
    pub rating_deviation: u32,
    /// From -100 to 100: how much players liked the puzzle.
    pub popularity: i32,
    pub plays: u32,
    /// Lichess theme keys such as `fork` or `mateIn2`.
    pub themes: Vec<String>,
    /// The game the puzzle comes from, on lichess.org.
    pub game_url: String,
    /// Opening keys such as `Sicilian_Defense`; empty for later positions.
    pub opening_tags: Vec<String>,
}

impl Puzzle {
    /// Parses a line of the puzzle CSV. Returns `None` for the header and malformed lines.
    pub fn from_csv(line: &str) -> Option<Puzzle> {
        // No field contains a comma, so there is no quoting to handle.
        let mut fields = line.trim_end().split(',');
        let id = fields.next()?;
        let fen = fields.next()?;
        let moves: Vec<String> = fields
            .next()?
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        let rating = fields.next()?.parse().ok()?;
        let rating_deviation = fields.next()?.parse().ok()?;
        let popularity = fields.next()?.parse().ok()?;
        let plays = fields.next()?.parse().ok()?;
        let themes = words(fields.next()?);
        let game_url = fields.next().unwrap_or("").to_owned();
        let opening_tags = words(fields.next().unwrap_or(""));
        if id.is_empty() || moves.len() < 2 {
            return None;
        }
        Some(Puzzle {
            id: id.to_owned(),
            fen: fen.to_owned(),
            moves,
            rating,
            rating_deviation,
            popularity,
            plays,
            themes,
            game_url,
            opening_tags,
        })
    }

    /// Checks that the position is legal and every move can be played in turn.
    pub fn validate(&self) -> Result<(), String> {
        let mut pos = AnalysisRoot::from_fen(&self.fen)
            .map_err(|e| format!("puzzle {}: {e}", self.id))?
            .pos;
        for uci in &self.moves {
            let mv = uci
                .parse::<UciMove>()
                .ok()
                .and_then(|m| m.to_move(&pos).ok())
                .ok_or_else(|| format!("puzzle {}: illegal move {uci}", self.id))?;
            pos.play_unchecked(mv);
        }
        Ok(())
    }
}

fn words(field: &str) -> Vec<String> {
    field.split_whitespace().map(str::to_owned).collect()
}

/// Reads puzzle CSV line by line and hands every puzzle to `each`. The header and malformed lines
/// are skipped. Returns whether `each` stopped reading before the end.
pub fn read_csv(
    reader: impl BufRead,
    mut each: impl FnMut(Puzzle) -> ControlFlow<()>,
) -> std::io::Result<bool> {
    for line in reader.lines() {
        if let Some(puzzle) = Puzzle::from_csv(&line?)
            && each(puzzle).is_break()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lines_of_both_csv_versions() {
        let line = "00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,\
                    f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1819,77,95,10446,\
                    crushing hangingPiece long middlegame,https://lichess.org/game/787zsVup/black#48,,";
        let puzzle = Puzzle::from_csv(line).unwrap();
        assert_eq!(puzzle.id, "00008");
        assert_eq!(puzzle.moves.len(), 6);
        assert_eq!(puzzle.rating, 1819);
        assert_eq!(puzzle.popularity, 95);
        assert_eq!(puzzle.themes[1], "hangingPiece");
        assert!(puzzle.opening_tags.is_empty());
        puzzle.validate().unwrap();

        let older = "0009B,r2qr1k1/b1p2ppp/pp4n1/P1P1p3/4P1n1/B2P2Pb/3NBP1P/RN1QR1K1 b - - 1 16,\
                     b6c5 e2g4 h3g4 d1g4,1112,74,87,569,advantage middlegame short,\
                     https://lichess.org/4MWQCxQ6/black#32,Kings_Pawn_Game Kings_Pawn_Game_Leonardis_Variation";
        let puzzle = Puzzle::from_csv(older).unwrap();
        assert_eq!(puzzle.opening_tags.len(), 2);
        puzzle.validate().unwrap();

        assert_eq!(Puzzle::from_csv(STARTER.lines().next().unwrap()), None);
        assert_eq!(Puzzle::from_csv("x,8/8/8/8/8/8/8/8 w - - 0 1,e2e4"), None);
    }

    #[test]
    fn rejects_illegal_moves() {
        let line = "bad,4k3/8/8/8/8/8/8/4K3 w - - 0 1,e1e2 e8e7 e2e4,1500,80,90,100,endgame,,";
        assert!(Puzzle::from_csv(line).unwrap().validate().is_err());
    }

    #[test]
    fn starter_puzzles_are_valid() {
        let mut count = 0;
        read_csv(STARTER.as_bytes(), |puzzle| {
            puzzle.validate().unwrap();
            count += 1;
            ControlFlow::Continue(())
        })
        .unwrap();
        assert!(count > 2000, "only {count} starter puzzles");
    }
}
