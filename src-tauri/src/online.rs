//! Importing a player's games from Lichess and Chess.com, by count or by date.
//!
//! Lichess streams a player's games as one PGN file. Chess.com's public API needs no account and
//! serves games one month at a time, so its games are collected month by month, newest first.

use std::time::Duration;

use chess_core::pgn::{self, ParsedPgn};
use reqwest::StatusCode;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tauri::State;

use crate::lichess::{LICHESS, Lichess, RequestError, http_client, without_url};

/// Games fetched at most in one go.
pub const MAX_GAMES: usize = 200;
/// Exports stream a few dozen games a second, so a large one takes a while.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
/// Lichess games of standard chess: every speed, no variants.
const LICHESS_PERF_TYPES: &str = "ultraBullet,bullet,blitz,rapid,classical,correspondence";
/// The earliest time the Lichess games export accepts, early in 2013.
const LICHESS_FIRST_GAME: i64 = 1_356_998_400_070;
const CHESS_COM: &str = "https://api.chess.com/pub";

/// Which of a player's games to fetch.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GameFilter {
    /// The most recent games, newest first.
    Latest { count: usize },
    /// Games played between two times, in milliseconds since the Unix epoch. Either end may be
    /// open.
    Between {
        since: Option<i64>,
        until: Option<i64>,
    },
}

impl GameFilter {
    /// How many games to keep at most.
    fn limit(self) -> usize {
        match self {
            GameFilter::Latest { count } => count.clamp(1, MAX_GAMES),
            GameFilter::Between { .. } => MAX_GAMES,
        }
    }

    fn contains(self, time_ms: i64) -> bool {
        match self {
            GameFilter::Latest { .. } => true,
            GameFilter::Between { since, until } => {
                since.is_none_or(|since| time_ms >= since)
                    && until.is_none_or(|until| time_ms <= until)
            }
        }
    }
}

/// A username as both sites allow them, so it can go into a URL path as it is.
fn check_username(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a username.".into());
    }
    if name.len() > 50
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("“{name}” is not a valid username."));
    }
    Ok(name)
}

// --- Lichess ------------------------------------------------------------------------------------

fn lichess_query(filter: GameFilter) -> Vec<(&'static str, String)> {
    let mut query = vec![
        ("perfType", LICHESS_PERF_TYPES.to_owned()),
        // Evaluations of games analysed on Lichess fill the eval graph.
        ("evals", "true".to_owned()),
        ("clocks", "true".to_owned()),
        ("opening", "true".to_owned()),
    ];
    match filter {
        GameFilter::Latest { .. } => query.push(("max", filter.limit().to_string())),
        GameFilter::Between { since, until } => {
            // One more than is kept, to tell whether there were more.
            query.push(("max", (MAX_GAMES + 1).to_string()));
            // Lichess rejects times before it kept games.
            query.extend(since.map(|since| ("since", since.max(LICHESS_FIRST_GAME).to_string())));
            query.extend(until.map(|until| ("until", until.to_string())));
        }
    }
    query
}

/// Fetches `username`'s games from Lichess, newest first.
#[tauri::command]
pub async fn lichess_games(
    lichess: State<'_, Lichess>,
    username: String,
    filter: GameFilter,
) -> Result<ParsedPgn, String> {
    fetch_lichess(&lichess, &username, filter).await
}

async fn fetch_lichess(
    lichess: &Lichess,
    username: &str,
    filter: GameFilter,
) -> Result<ParsedPgn, String> {
    let username = check_username(username)?;
    let text = lichess
        .get_public_text(
            &format!("{LICHESS}/api/games/user/{username}"),
            &lichess_query(filter),
            "application/x-chess-pgn",
            EXPORT_TIMEOUT,
        )
        .await
        .map_err(|error| match error {
            RequestError::NotFound => format!("Lichess has no player called “{username}”."),
            RequestError::RateLimited => {
                "Lichess asked Mochi to slow down. Try again in a minute.".to_owned()
            }
            RequestError::SignedOut => "Lichess turned the request down.".to_owned(),
            RequestError::Failed { message } => format!("Mochi couldn't reach Lichess: {message}."),
        })?;
    Ok(pgn::parse_str(&text, filter.limit()))
}

// --- Chess.com ----------------------------------------------------------------------------------

pub struct ChessCom {
    http: reqwest::Client,
}

impl Default for ChessCom {
    fn default() -> Self {
        ChessCom {
            http: http_client(),
        }
    }
}

enum ChessComError {
    NotFound,
    Failed(String),
}

impl ChessCom {
    /// Chess.com serves serial requests without limits, so requests are made one after another.
    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, ChessComError> {
        let response = self
            .http
            .get(url)
            .timeout(EXPORT_TIMEOUT)
            .send()
            .await
            .map_err(|e| ChessComError::Failed(without_url(e)))?;
        match response.status() {
            StatusCode::NOT_FOUND | StatusCode::GONE => Err(ChessComError::NotFound),
            StatusCode::TOO_MANY_REQUESTS => Err(ChessComError::Failed(
                "Chess.com asked Mochi to slow down, try again in a minute".into(),
            )),
            status if !status.is_success() => Err(ChessComError::Failed(format!(
                "Chess.com answered {status}"
            ))),
            _ => response
                .json()
                .await
                .map_err(|e| ChessComError::Failed(without_url(e))),
        }
    }
}

#[derive(Deserialize)]
struct Archives {
    archives: Vec<String>,
}

#[derive(Deserialize)]
struct MonthGames {
    games: Vec<ApiGame>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
struct ApiGame {
    /// Missing for some games, e.g. ones that never started.
    pgn: Option<String>,
    /// Seconds since the Unix epoch.
    end_time: i64,
    /// `chess` for standard chess; variants such as `chess960` are skipped.
    rules: String,
}

/// A month of games: (year, month from 1 to 12).
type Month = (i32, u32);

/// Reads the month from an archive URL such as `…/games/2024/03`.
fn archive_month(url: &str) -> Option<Month> {
    let mut parts = url.trim_end_matches('/').rsplit('/');
    let month = parts
        .next()?
        .parse()
        .ok()
        .filter(|m| (1..=12).contains(m))?;
    let year = parts.next()?.parse().ok()?;
    Some((year, month))
}

/// Days since the Unix epoch of a date in the proleptic Gregorian calendar.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(if month <= 2 { year - 1 } else { year });
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// When a month starts and ends (exclusive), in milliseconds since the Unix epoch, UTC.
fn month_bounds((year, month): Month) -> (i64, i64) {
    let next = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let ms = |(year, month): Month| days_from_civil(year, month, 1) * 86_400_000;
    (ms((year, month)), ms(next))
}

/// Whether games of `month` can match `filter`.
fn month_matches(month: Month, filter: GameFilter) -> bool {
    match filter {
        GameFilter::Latest { .. } => true,
        GameFilter::Between { since, until } => {
            let (start, end) = month_bounds(month);
            since.is_none_or(|since| end > since) && until.is_none_or(|until| start <= until)
        }
    }
}

/// The standard games of a month that match `filter`, newest first.
fn select_games(mut games: Vec<ApiGame>, filter: GameFilter) -> Vec<ApiGame> {
    games.retain(|game| {
        game.rules == "chess" && game.pgn.is_some() && filter.contains(game.end_time * 1000)
    });
    games.sort_by_key(|game| std::cmp::Reverse(game.end_time));
    games
}

/// Fetches `username`'s games from Chess.com, newest first.
#[tauri::command]
pub async fn chesscom_games(
    chesscom: State<'_, ChessCom>,
    username: String,
    filter: GameFilter,
) -> Result<ParsedPgn, String> {
    fetch_chesscom(&chesscom, &username, filter).await
}

async fn fetch_chesscom(
    chesscom: &ChessCom,
    username: &str,
    filter: GameFilter,
) -> Result<ParsedPgn, String> {
    let username = check_username(username)?.to_ascii_lowercase();
    let failed = |message: String| format!("Mochi couldn't reach Chess.com: {message}.");

    let archives: Archives = chesscom
        .get_json(&format!("{CHESS_COM}/player/{username}/games/archives"))
        .await
        .map_err(|error| match error {
            ChessComError::NotFound => format!("Chess.com has no player called “{username}”."),
            ChessComError::Failed(message) => failed(message),
        })?;
    let mut months: Vec<Month> = archives
        .archives
        .iter()
        .filter_map(|url| archive_month(url))
        .filter(|month| month_matches(*month, filter))
        .collect();
    months.sort_unstable();
    months.dedup();

    // One more than is kept for date ranges, to tell whether there were more.
    let wanted = match filter {
        GameFilter::Latest { .. } => filter.limit(),
        GameFilter::Between { .. } => MAX_GAMES + 1,
    };
    let mut games = Vec::new();
    for (year, month) in months.into_iter().rev() {
        let url = format!("{CHESS_COM}/player/{username}/games/{year}/{month:02}");
        match chesscom.get_json::<MonthGames>(&url).await {
            Ok(month) => games.extend(select_games(month.games, filter)),
            // An archive that is listed but gone holds nothing to import.
            Err(ChessComError::NotFound) => {}
            Err(ChessComError::Failed(message)) => return Err(failed(message)),
        }
        if games.len() >= wanted {
            break;
        }
    }
    games.truncate(wanted);

    let text = games
        .into_iter()
        .filter_map(|game| game.pgn)
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(pgn::parse_str(&text, filter.limit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(end_time: i64, rules: &str) -> ApiGame {
        ApiGame {
            pgn: Some(format!("[Event \"{end_time}\"]\n\n1. e4 *")),
            end_time,
            rules: rules.into(),
        }
    }

    #[test]
    fn reads_filters_from_the_frontend() {
        let latest: GameFilter = serde_json::from_str(r#"{"kind":"latest","count":20}"#).unwrap();
        assert_eq!(latest, GameFilter::Latest { count: 20 });
        let between: GameFilter =
            serde_json::from_str(r#"{"kind":"between","since":1000,"until":null}"#).unwrap();
        assert_eq!(
            between,
            GameFilter::Between {
                since: Some(1000),
                until: None
            }
        );
    }

    #[test]
    fn checks_usernames() {
        assert_eq!(check_username("  Whisker_Paws-9 "), Ok("Whisker_Paws-9"));
        assert!(check_username("").is_err());
        assert!(check_username("../account").is_err());
        assert!(check_username("cat?max=1").is_err());
    }

    #[test]
    fn builds_lichess_queries() {
        let query = lichess_query(GameFilter::Latest { count: 5000 });
        assert!(query.contains(&("max", MAX_GAMES.to_string())));
        assert!(!query.iter().any(|(key, _)| *key == "since"));

        let query = lichess_query(GameFilter::Between {
            since: Some(1_700_000_000_000),
            until: Some(1_710_000_000_000),
        });
        assert!(query.contains(&("max", (MAX_GAMES + 1).to_string())));
        assert!(query.contains(&("since", "1700000000000".to_owned())));
        assert!(query.contains(&("until", "1710000000000".to_owned())));
        assert!(query.contains(&("perfType", LICHESS_PERF_TYPES.to_owned())));

        let query = lichess_query(GameFilter::Between {
            since: Some(0),
            until: None,
        });
        assert!(query.contains(&("since", LICHESS_FIRST_GAME.to_string())));
        assert!(!query.iter().any(|(key, _)| *key == "until"));
    }

    #[test]
    fn reads_archive_months() {
        assert_eq!(
            archive_month("https://api.chess.com/pub/player/cat/games/2024/03"),
            Some((2024, 3))
        );
        assert_eq!(
            archive_month("https://api.chess.com/pub/player/cat/games/2024/13"),
            None
        );
        assert_eq!(archive_month("nonsense"), None);
    }

    #[test]
    fn computes_month_bounds() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        // 2024-02-01T00:00:00Z and 2024-03-01T00:00:00Z.
        assert_eq!(
            month_bounds((2024, 2)),
            (1_706_745_600_000, 1_709_251_200_000)
        );
        assert_eq!(month_bounds((2023, 12)).1, month_bounds((2024, 1)).0);
    }

    #[test]
    fn picks_months_in_a_date_range() {
        let (march_start, march_end) = month_bounds((2024, 3));
        let filter = GameFilter::Between {
            since: Some(march_start + 5),
            until: Some(march_end + 5),
        };
        assert!(!month_matches((2024, 2), filter));
        assert!(month_matches((2024, 3), filter));
        assert!(month_matches((2024, 4), filter));
        assert!(!month_matches((2024, 5), filter));
        assert!(month_matches((1999, 1), GameFilter::Latest { count: 1 }));
    }

    #[test]
    fn selects_standard_games_newest_first() {
        let games = vec![
            game(100, "chess"),
            game(300, "chess960"),
            game(200, "chess"),
            ApiGame {
                pgn: None,
                ..game(400, "chess")
            },
            game(500, "chess"),
        ];
        let ends = |games: Vec<ApiGame>| games.iter().map(|g| g.end_time).collect::<Vec<_>>();
        assert_eq!(
            ends(select_games(games.clone(), GameFilter::Latest { count: 2 })),
            [500, 200, 100]
        );
        let filter = GameFilter::Between {
            since: Some(150_000),
            until: Some(450_000),
        };
        assert_eq!(ends(select_games(games, filter)), [200]);
    }

    // These reach the real sites: `cargo test -p enpawssant online -- --ignored`.

    #[tokio::test]
    #[ignore = "needs the network"]
    async fn fetches_lichess_games() {
        let lichess = Lichess::default();
        let parsed = fetch_lichess(&lichess, "thibault", GameFilter::Latest { count: 3 })
            .await
            .unwrap();
        assert_eq!(parsed.games.len(), 3);
        assert!(parsed.errors.is_empty());
        let missing = fetch_lichess(
            &lichess,
            "zz-no-such-cat-zz",
            GameFilter::Latest { count: 1 },
        )
        .await
        .unwrap_err();
        assert!(missing.contains("no player"), "{missing}");
    }

    #[tokio::test]
    #[ignore = "needs the network"]
    async fn fetches_chesscom_games() {
        let chesscom = ChessCom::default();
        let parsed = fetch_chesscom(&chesscom, "Hikaru", GameFilter::Latest { count: 3 })
            .await
            .unwrap();
        assert_eq!(parsed.games.len(), 3);
        assert!(parsed.errors.is_empty());

        let (start, end) = month_bounds((2024, 3));
        let filter = GameFilter::Between {
            since: Some(start),
            until: Some(start + (end - start) / 4),
        };
        let parsed = fetch_chesscom(&chesscom, "hikaru", filter).await.unwrap();
        assert!(!parsed.games.is_empty());
        for game in &parsed.games {
            let date = &game
                .game
                .headers
                .iter()
                .find(|(k, _)| k == "UTCDate")
                .unwrap()
                .1;
            assert!(date.starts_with("2024.03."), "{date}");
        }

        let missing = fetch_chesscom(
            &chesscom,
            "zz-no-such-cat-zz",
            GameFilter::Latest { count: 1 },
        )
        .await
        .unwrap_err();
        assert!(missing.contains("no player"), "{missing}");
    }
}
