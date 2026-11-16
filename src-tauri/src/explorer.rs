//! The opening explorer: move statistics from the Lichess explorer API and
//! opening names from the tables bundled with `chess-core`.

use chess_core::AnalysisRoot;
use chess_core::openings::{self, Opening};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lichess::{Account, Lichess, RequestError};

const EXPLORER: &str = "https://explorer.lichess.org";
/// Moves per position; more would not fit the explorer card anyway.
const MOVES: &str = "12";
/// Lichess games counted, like the explorer on lichess.org: no bullet, rated 1600+.
const LICHESS_SPEEDS: &str = "blitz,rapid,classical";
const LICHESS_RATINGS: &str = "1600,1800,2000,2200,2500";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExplorerSource {
    /// Over-the-board games between titled players.
    Masters,
    /// Games played on lichess.org.
    Lichess,
}

/// How often each move was played from a position, and how those games ended.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerResult {
    white: u64,
    draws: u64,
    black: u64,
    /// Most played first.
    moves: Vec<ExplorerMove>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerMove {
    /// Standard UCI (castling as `e1g1`).
    uci: String,
    san: String,
    white: u64,
    draws: u64,
    black: u64,
    average_rating: Option<u32>,
}

/// The parts of an explorer API response we use.
#[derive(Deserialize)]
struct ApiResult {
    white: u64,
    draws: u64,
    black: u64,
    moves: Vec<ApiMove>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMove {
    san: String,
    white: u64,
    draws: u64,
    black: u64,
    average_rating: Option<u32>,
}

impl ExplorerResult {
    /// Converts an API response for `root`. The API writes castling as the king
    /// taking its rook (`e1h1`), so moves are converted from SAN instead, and
    /// moves that are not legal here are dropped.
    fn from_api(root: &AnalysisRoot, api: ApiResult) -> ExplorerResult {
        let moves = api
            .moves
            .into_iter()
            .filter_map(|m| {
                Some(ExplorerMove {
                    uci: root.san_to_uci(&m.san)?,
                    san: m.san,
                    white: m.white,
                    draws: m.draws,
                    black: m.black,
                    average_rating: m.average_rating,
                })
            })
            .collect();
        ExplorerResult {
            white: api.white,
            draws: api.draws,
            black: api.black,
            moves,
        }
    }
}

/// Looks up the moves played from `fen` in the games of `source`.
#[tauri::command]
pub async fn explorer_moves(
    lichess: State<'_, Lichess>,
    source: ExplorerSource,
    fen: String,
) -> Result<ExplorerResult, RequestError> {
    let root = AnalysisRoot::from_fen(&fen).map_err(|e| RequestError::Failed {
        message: e.to_string(),
    })?;
    let fen = root.fen();
    let (url, query) = match source {
        ExplorerSource::Masters => (
            format!("{EXPLORER}/masters"),
            vec![
                ("fen", fen),
                ("moves", MOVES.into()),
                ("topGames", "0".into()),
            ],
        ),
        ExplorerSource::Lichess => (
            format!("{EXPLORER}/lichess"),
            vec![
                ("fen", fen),
                ("moves", MOVES.into()),
                ("speeds", LICHESS_SPEEDS.into()),
                ("ratings", LICHESS_RATINGS.into()),
                ("topGames", "0".into()),
                ("recentGames", "0".into()),
            ],
        ),
    };
    let api = lichess.get_json(&url, &query).await?;
    Ok(ExplorerResult::from_api(&root, api))
}

/// The name of the opening a line of positions is in: the last of `fens` that
/// has one.
#[tauri::command]
pub fn opening_name(fens: Vec<String>) -> Option<Opening> {
    openings::opening_for(&fens).cloned()
}

/// The signed-in Lichess account, if any.
#[tauri::command]
pub async fn lichess_account(lichess: State<'_, Lichess>) -> Result<Option<Account>, String> {
    Ok(lichess.account().await)
}

/// Signs in to Lichess through the browser.
#[tauri::command]
pub async fn lichess_sign_in(lichess: State<'_, Lichess>) -> Result<Account, String> {
    lichess.sign_in().await
}

/// Stops a sign-in that is waiting for the browser.
#[tauri::command]
pub fn lichess_cancel_sign_in(lichess: State<'_, Lichess>) {
    lichess.cancel_sign_in();
}

/// Signs out of Lichess and revokes the token.
#[tauri::command]
pub async fn lichess_sign_out(lichess: State<'_, Lichess>) -> Result<(), String> {
    lichess.sign_out().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_api_responses() {
        let root = AnalysisRoot::from_fen(
            "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2P2N2/PP1P1PPP/RNBQK2R w KQkq - 1 5",
        )
        .unwrap();
        // Shortened from a real response, plus a move that is not legal here.
        let api: ApiResult = serde_json::from_str(
            r#"{
                "white": 1542, "draws": 1323, "black": 1062,
                "moves": [
                    {"uci": "d2d4", "san": "d4", "averageRating": 2421,
                     "white": 820, "draws": 640, "black": 580, "game": null,
                     "opening": {"eco": "C54", "name": "Italian Game"}},
                    {"uci": "e1h1", "san": "O-O", "averageRating": 2433,
                     "white": 301, "draws": 352, "black": 210, "game": null, "opening": null},
                    {"uci": "e1c1", "san": "O-O-O", "averageRating": null,
                     "white": 1, "draws": 0, "black": 0, "game": null, "opening": null}
                ],
                "topGames": [],
                "opening": {"eco": "C54", "name": "Italian Game: Classical Variation"}
            }"#,
        )
        .unwrap();
        let result = ExplorerResult::from_api(&root, api);
        assert_eq!(
            (result.white, result.draws, result.black),
            (1542, 1323, 1062)
        );
        assert_eq!(
            result.moves,
            [
                ExplorerMove {
                    uci: "d2d4".into(),
                    san: "d4".into(),
                    white: 820,
                    draws: 640,
                    black: 580,
                    average_rating: Some(2421),
                },
                ExplorerMove {
                    uci: "e1g1".into(),
                    san: "O-O".into(),
                    white: 301,
                    draws: 352,
                    black: 210,
                    average_rating: Some(2433),
                },
            ]
        );
    }
}
