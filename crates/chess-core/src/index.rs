//! Position keys for the game database: every main-line position of a game, hashed so games can
//! be found by position and transpositions count as the same position.

use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{Chess, EnPassantMode, Position, Role, Square};

use crate::openings::{self, Opening};
use crate::pgn::{self, Game};
use crate::{AnalysisRoot, InvalidFen};

/// Positions of a game that are looked up in the opening tables.
const OPENING_PLIES: usize = 60;

/// A position of a game's main line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexedPosition {
    /// See [`position_key`].
    pub key: i64,
    /// 0 for the starting position.
    pub ply: u32,
    /// The move played from here in the game, packed by [`pack_move`]; `None` at the end.
    pub next: Option<u16>,
}

/// What the database stores about a game besides its PGN.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameIndex {
    pub positions: Vec<IndexedPosition>,
    /// The opening the main line is in, by position.
    pub opening: Option<Opening>,
    /// Plies in the main line.
    pub plies: u32,
}

/// The database key of a position: its Zobrist hash, which ignores the move counters, as a signed
/// integer because that is what SQLite stores.
pub fn position_key(pos: &Chess) -> i64 {
    let hash: Zobrist64 = pos.zobrist_hash(EnPassantMode::Legal);
    hash.0 as i64
}

/// The database key of the position in `fen`.
pub fn fen_key(fen: &str) -> Result<i64, InvalidFen> {
    Ok(position_key(&AnalysisRoot::from_fen(fen)?.pos))
}

/// Replays a game's main line and keys every position on it.
pub fn index_game(game: &Game) -> Result<GameIndex, String> {
    let mut pos = AnalysisRoot::from_fen(&game.start_fen)
        .map_err(|e| e.to_string())?
        .pos;
    let mut positions = Vec::with_capacity(game.moves.len() + 1);
    let mut line = Vec::with_capacity(game.moves.len() + 1);
    for (ply, mv) in game.moves.iter().enumerate() {
        let uci: UciMove = mv
            .uci
            .parse()
            .map_err(|_| format!("invalid move `{}`", mv.uci))?;
        let legal = uci
            .to_move(&pos)
            .map_err(|_| format!("illegal move `{}`", mv.uci))?;
        positions.push(IndexedPosition {
            key: position_key(&pos),
            ply: ply as u32,
            next: pack_move(&mv.uci),
        });
        line.push(pos.clone());
        pos.play_unchecked(legal);
    }
    positions.push(IndexedPosition {
        key: position_key(&pos),
        ply: game.moves.len() as u32,
        next: None,
    });
    line.push(pos);
    Ok(GameIndex {
        // Opening lines are far shorter than this; looking further would only cost time.
        opening: openings::opening_for_positions(&line[..line.len().min(OPENING_PLIES)]).cloned(),
        plies: game.moves.len() as u32,
        positions,
    })
}

/// Packs a UCI move into 16 bits: from square, to square and promotion piece.
pub fn pack_move(uci: &str) -> Option<u16> {
    let uci: UciMove = uci.parse().ok()?;
    let UciMove::Normal {
        from,
        to,
        promotion,
    } = uci
    else {
        return None;
    };
    let promotion = match promotion {
        None => 0,
        Some(Role::Knight) => 1,
        Some(Role::Bishop) => 2,
        Some(Role::Rook) => 3,
        Some(Role::Queen) => 4,
        Some(_) => return None,
    };
    Some(from.to_u32() as u16 | ((to.to_u32() as u16) << 6) | (promotion << 12))
}

/// The UCI move packed by [`pack_move`].
pub fn unpack_move(packed: u16) -> Option<String> {
    let from = Square::new(u32::from(packed & 63));
    let to = Square::new(u32::from((packed >> 6) & 63));
    let promotion = match packed >> 12 {
        0 => None,
        1 => Some(Role::Knight),
        2 => Some(Role::Bishop),
        3 => Some(Role::Rook),
        4 => Some(Role::Queen),
        _ => return None,
    };
    let uci = UciMove::Normal {
        from,
        to,
        promotion,
    };
    Some(uci.to_string())
}

/// Reads a game's main line from stored PGN text.
pub fn game_from_pgn(text: &str) -> Result<Game, String> {
    let mut parsed = pgn::parse_str(text, 1);
    match parsed.games.pop() {
        Some(imported) => Ok(imported.game),
        None => Err(parsed
            .errors
            .pop()
            .unwrap_or_else(|| "the stored game is empty".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pgn::{STARTING_FEN, parse_str};

    #[test]
    fn packs_moves() {
        for uci in ["e2e4", "e7e8q", "a2a1n", "e1g1", "h8a1"] {
            assert_eq!(unpack_move(pack_move(uci).unwrap()).as_deref(), Some(uci));
        }
        assert_eq!(pack_move("nonsense"), None);
        assert_eq!(pack_move("P@e4"), None);
    }

    #[test]
    fn indexes_the_main_line() {
        let game = parse_str("1. e4 e5 2. Nf3 (2. Bc4) 2... Nc6 3. Bb5 *", 1)
            .games
            .remove(0)
            .game;
        let index = index_game(&game).unwrap();
        assert_eq!(index.plies, 5);
        assert_eq!(index.positions.len(), 6);
        assert_eq!(index.positions[0].key, fen_key(STARTING_FEN).unwrap());
        assert_eq!(index.positions[0].next, pack_move("e2e4"));
        assert_eq!(index.positions[5].next, None);
        assert_eq!(index.positions[5].ply, 5);
        let opening = index.opening.unwrap();
        assert_eq!(opening.eco, "C60");
        assert!(opening.name.starts_with("Ruy Lopez"));
    }

    #[test]
    fn transpositions_share_keys_but_move_counters_do_not_matter() {
        let a = parse_str("1. Nf3 Nf6 2. d4 *", 1).games.remove(0).game;
        let b = parse_str("1. d4 Nf6 2. Nf3 *", 1).games.remove(0).game;
        let last = |game: &Game| index_game(game).unwrap().positions.last().unwrap().key;
        assert_eq!(last(&a), last(&b));
        assert_eq!(
            fen_key("rnbqkb1r/pppppppp/5n2/8/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 2 2").unwrap(),
            fen_key("rnbqkb1r/pppppppp/5n2/8/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 0 9").unwrap(),
        );
        assert_ne!(last(&a), fen_key(STARTING_FEN).unwrap());
    }

    #[test]
    fn reads_stored_games() {
        let game = game_from_pgn("[White \"Mochi\"]\n\n1. d4 d5 *").unwrap();
        assert_eq!(game.moves.len(), 2);
        assert!(game_from_pgn("").is_err());
    }
}
