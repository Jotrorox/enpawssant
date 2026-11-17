//! Checking positions set up by hand, e.g. in the board editor or a pasted FEN.

use shakmaty::fen::Fen;
use shakmaty::{CastlingMode, Chess, EnPassantMode, PositionError, PositionErrorKinds};

/// Checks that `fen` describes a position that can be analysed and played from. Castling rights
/// and en passant squares that don't fit the board are dropped, and positions with more material
/// than a real game could reach are allowed. Returns the cleaned-up FEN, or why the position
/// can't be used, in words meant for the user.
pub fn check_position(fen: &str) -> Result<String, String> {
    let parsed: Fen = fen.trim().parse().map_err(|_| {
        "This isn't a valid FEN. It should look like the one for the starting position.".to_owned()
    })?;
    let pos: Chess = parsed
        .into_position(CastlingMode::Standard)
        .or_else(PositionError::ignore_invalid_castling_rights)
        .or_else(PositionError::ignore_invalid_ep_square)
        .or_else(PositionError::ignore_too_much_material)
        .map_err(|error| describe(error.kinds()))?;
    Ok(Fen::from_position(&pos, EnPassantMode::Legal).to_string())
}

fn describe(kinds: PositionErrorKinds) -> String {
    let message = if kinds.contains(PositionErrorKinds::EMPTY_BOARD) {
        "The board is empty. Each side needs a king."
    } else if kinds.contains(PositionErrorKinds::MISSING_KING) {
        "Each side needs a king."
    } else if kinds.contains(PositionErrorKinds::TOO_MANY_KINGS) {
        "Each side can only have one king."
    } else if kinds.contains(PositionErrorKinds::PAWNS_ON_BACKRANK) {
        "Pawns can't stand on the first or last rank."
    } else if kinds.contains(PositionErrorKinds::OPPOSITE_CHECK) {
        "The side that isn't to move is in check."
    } else if kinds.contains(PositionErrorKinds::IMPOSSIBLE_CHECK) {
        "The king is in a check that no move could have given."
    } else {
        "This position can't be played."
    };
    message.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_normalises_positions() {
        assert_eq!(
            check_position("  4k3/8/8/8/8/8/8/4K3 w - - 0 1 ").unwrap(),
            "4k3/8/8/8/8/8/8/4K3 w - - 0 1"
        );
        // Castling rights without the rook and an en passant square without a capture are dropped.
        assert_eq!(
            check_position("4k3/8/8/8/4P3/8/8/R3K3 b KQ e3 0 1").unwrap(),
            "4k3/8/8/8/4P3/8/8/R3K3 b Q - 0 1"
        );
        // Eleven knights can't come from a real game, but are fine to analyse.
        assert!(check_position("NNNNNNNN/NNN5/8/8/8/8/8/4K2k b - - 0 1").is_ok());
    }

    #[test]
    fn explains_unusable_positions() {
        assert_eq!(
            check_position("nonsense").unwrap_err().split('.').next(),
            Some("This isn't a valid FEN")
        );
        assert_eq!(
            check_position("8/8/8/8/8/8/8/8 w - - 0 1").unwrap_err(),
            "The board is empty. Each side needs a king."
        );
        assert_eq!(
            check_position("8/8/8/8/8/8/8/4K3 w - - 0 1").unwrap_err(),
            "Each side needs a king."
        );
        assert_eq!(
            check_position("4k3/8/8/8/8/8/8/P3K3 w - - 0 1").unwrap_err(),
            "Pawns can't stand on the first or last rank."
        );
        assert_eq!(
            check_position("4k3/4R3/8/8/8/8/8/4K3 w - - 0 1").unwrap_err(),
            "The side that isn't to move is in check."
        );
    }
}
