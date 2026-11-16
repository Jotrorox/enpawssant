//! Chess logic for EnPawssant.
//!
//! This crate must stay independent of Tauri so it can be tested and reused
//! without the desktop shell.

pub use shakmaty;

#[cfg(test)]
mod tests {
    use shakmaty::fen::Fen;
    use shakmaty::{CastlingMode, Chess, Position};

    const STARTING_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    #[test]
    fn starting_position_has_20_legal_moves() {
        let fen: Fen = STARTING_FEN.parse().expect("starting FEN should parse");
        let pos: Chess = fen
            .into_position(CastlingMode::Standard)
            .expect("starting FEN should be a legal position");
        assert_eq!(pos.legal_moves().len(), 20);
    }
}
