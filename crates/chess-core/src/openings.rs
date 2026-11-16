//! Opening names, from the lichess `chess-openings` tables in `data/openings`.
//!
//! Every line of the tables names the position its moves lead to. The index is
//! keyed by position rather than by move order, so transpositions find their
//! name too.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Serialize;
use shakmaty::fen::Epd;
use shakmaty::san::San;
use shakmaty::{Chess, EnPassantMode, Position};

use crate::AnalysisRoot;

const TABLES: [&str; 5] = [
    include_str!("../data/openings/a.tsv"),
    include_str!("../data/openings/b.tsv"),
    include_str!("../data/openings/c.tsv"),
    include_str!("../data/openings/d.tsv"),
    include_str!("../data/openings/e.tsv"),
];

/// A named opening, e.g. `C50 Italian Game: Giuoco Piano`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Opening {
    pub eco: String,
    pub name: String,
}

type Index = HashMap<String, Opening>;

/// The name of the last position in `fens` that has one, e.g. the moves of a
/// game up to the current one. Positions after the opening keep the name of the
/// last named position before them. Invalid FENs are skipped.
pub fn opening_for<S: AsRef<str>>(fens: &[S]) -> Option<&'static Opening> {
    let index = index();
    fens.iter().rev().find_map(|fen| {
        let root = AnalysisRoot::from_fen(fen.as_ref()).ok()?;
        index.get(&key(&root.pos))
    })
}

fn key(pos: &Chess) -> String {
    Epd::from_position(pos, EnPassantMode::Legal).to_string()
}

fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = HashMap::new();
        for line in TABLES.iter().flat_map(|table| table.lines().skip(1)) {
            // The tables are checked by a test, so a bad line is a bug in them.
            let (opening, pos) = parse_line(line).expect("invalid line in the opening tables");
            // Several lines can reach the same position; the first one names it.
            index.entry(key(&pos)).or_insert(opening);
        }
        index
    })
}

/// Parses a `eco<TAB>name<TAB>pgn` line into the opening and the position its
/// moves lead to.
fn parse_line(line: &str) -> Result<(Opening, Chess), String> {
    let mut fields = line.split('\t');
    let (Some(eco), Some(name), Some(pgn), None) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Err(format!("expected three fields: {line}"));
    };
    let mut pos = Chess::default();
    // Move numbers (`1.`) are the only tokens that are not moves.
    for token in pgn.split_whitespace().filter(|t| !t.ends_with('.')) {
        let mv = token
            .parse::<San>()
            .ok()
            .and_then(|san| san.to_move(&pos).ok())
            .ok_or_else(|| format!("illegal move {token} in {name}"))?;
        pos.play_unchecked(mv);
    }
    let opening = Opening {
        eco: eco.to_owned(),
        name: name.to_owned(),
    };
    Ok((opening, pos))
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const ITALIAN: &str = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3";
    const GIUOCO_PIANO: &str =
        "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";

    fn name(fens: &[&str]) -> Option<String> {
        opening_for(fens).map(|o| format!("{} {}", o.eco, o.name))
    }

    #[test]
    fn every_table_line_is_legal() {
        let mut lines = 0;
        for line in TABLES.iter().flat_map(|table| table.lines().skip(1)) {
            parse_line(line).unwrap();
            lines += 1;
        }
        assert!(lines > 3000, "only {lines} lines");
        assert!(index().len() > 3000);
    }

    #[test]
    fn names_positions() {
        assert_eq!(name(&[ITALIAN]).as_deref(), Some("C50 Italian Game"));
        assert_eq!(
            name(&[GIUOCO_PIANO]).as_deref(),
            Some("C50 Italian Game: Giuoco Piano")
        );
    }

    #[test]
    fn the_starting_position_has_no_name() {
        assert_eq!(name(&[START]), None);
        assert_eq!(name(&[]), None);
    }

    #[test]
    fn later_positions_keep_the_last_name() {
        // 4. Rg1 is in no table, so the line keeps the name of 3... Bc5.
        let unnamed = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK1R1 b Qkq - 5 4";
        assert_eq!(name(&[unnamed]), None);
        assert_eq!(
            name(&[START, ITALIAN, GIUOCO_PIANO, "not a fen", unnamed]).as_deref(),
            Some("C50 Italian Game: Giuoco Piano")
        );
    }

    #[test]
    fn finds_transpositions_and_ignores_move_counters() {
        // 1. Nf3 Nc6 2. e4 e5 3. Bc4 reaches the Italian with other counters.
        let transposed = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 9 30";
        assert_eq!(name(&[transposed]).as_deref(), Some("C50 Italian Game"));
    }
}
