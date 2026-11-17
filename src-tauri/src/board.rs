//! Playing on lichess.org through the Board API: the account's event stream
//! (games starting and ending, challenges), game streams, moves and the other
//! game actions, seeks, challenges and the list of ongoing games.
//!
//! Streams are opened by the frontend with an ID of its choosing and run until
//! Lichess closes them or `lichess_stream_stop` is called with that ID. Their
//! lines reach the frontend as JSON, which it interprets; this module only
//! checks what goes out, so that IDs and moves can't reach other endpoints.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use crate::lichess::{Lichess, RequestError};

/// Ongoing games fetched at once; the most Lichess hands out.
const PLAYING_LIMIT: &str = "50";
/// Days per move Lichess allows for correspondence games.
const CORRESPONDENCE_DAYS: [u32; 7] = [1, 2, 3, 5, 7, 10, 14];
/// The longest chat message Lichess accepts.
const MAX_CHAT_CHARS: usize = 140;

/// Stop requests remembered for streams that haven't started yet.
const MAX_EARLY_STOPS: usize = 256;

/// The streams that are open, by the ID the frontend gave them.
#[derive(Default)]
pub struct Streams {
    state: Mutex<StreamState>,
}

#[derive(Default)]
struct StreamState {
    open: HashMap<u32, oneshot::Sender<()>>,
    /// IDs stopped before their stream registered: the stop command can run
    /// before the async command that opens the stream gets going.
    stopped_early: HashSet<u32>,
}

impl Streams {
    /// Registers stream `id`, stopping an earlier stream with the same ID. The
    /// stream stops at once if it was stopped before it started.
    fn open(&self, id: u32) -> oneshot::Receiver<()> {
        let (stop, stopped) = oneshot::channel();
        let mut state = self.state.lock().unwrap();
        if state.stopped_early.remove(&id) {
            let _ = stop.send(());
        } else if let Some(previous) = state.open.insert(id, stop) {
            let _ = previous.send(());
        }
        stopped
    }

    fn stop(&self, id: u32) {
        let mut state = self.state.lock().unwrap();
        match state.open.remove(&id) {
            Some(stop) => {
                let _ = stop.send(());
            }
            None => {
                // Either it ended already or it hasn't started; IDs are never reused, so
                // remembering a few is harmless.
                if state.stopped_early.len() >= MAX_EARLY_STOPS {
                    state.stopped_early.clear();
                }
                state.stopped_early.insert(id);
            }
        }
    }

    /// Forgets stream `id` once it has ended on its own.
    fn close(&self, id: u32) {
        let mut state = self.state.lock().unwrap();
        if state.open.get(&id).is_some_and(|stop| stop.is_closed()) {
            state.open.remove(&id);
        }
    }
}

/// The time control of a new game.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GameClock {
    /// A real-time game with a clock.
    #[serde(rename_all = "camelCase")]
    Clock {
        limit_seconds: u32,
        increment_seconds: u32,
    },
    /// A correspondence game with a number of days per move.
    Correspondence { days: u32 },
    /// No clock at all.
    Unlimited,
}

impl GameClock {
    fn validate(self) -> Result<(), RequestError> {
        match self {
            GameClock::Clock {
                limit_seconds,
                increment_seconds,
            } if limit_seconds > 10_800 || increment_seconds > 60 => {
                Err(invalid("that time control is too long"))
            }
            GameClock::Clock {
                limit_seconds: 0,
                increment_seconds: 0,
            } => Err(invalid("a clock needs some time")),
            GameClock::Correspondence { days } if !CORRESPONDENCE_DAYS.contains(&days) => Err(
                invalid("correspondence games allow 1, 2, 3, 5, 7, 10 or 14 days"),
            ),
            _ => Ok(()),
        }
    }

    /// Form fields for challenges (`clock.limit` in seconds, or `days`).
    fn challenge_fields(self) -> Vec<(&'static str, String)> {
        match self {
            GameClock::Clock {
                limit_seconds,
                increment_seconds,
            } => vec![
                ("clock.limit", limit_seconds.to_string()),
                ("clock.increment", increment_seconds.to_string()),
            ],
            GameClock::Correspondence { days } => vec![("days", days.to_string())],
            GameClock::Unlimited => Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ColorChoice {
    White,
    Black,
    Random,
}

impl ColorChoice {
    fn as_str(self) -> &'static str {
        match self {
            ColorChoice::White => "white",
            ColorChoice::Black => "black",
            ColorChoice::Random => "random",
        }
    }
}

/// A game against Lichess's own AI (Stockfish at levels 1 to 8).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGame {
    level: u8,
    clock: GameClock,
    color: ColorChoice,
    /// Where the game starts, if not from the starting position.
    fen: Option<String>,
}

/// A game against a person: a challenge to one player, or a seek for anyone.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRequest {
    clock: GameClock,
    color: ColorChoice,
    rated: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ChallengeAction {
    Accept,
    Decline,
    Cancel,
}

/// What a player can do in a game, apart from moving and chatting.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GameAction {
    Abort,
    Resign,
    /// Offers a draw, or accepts the opponent's offer.
    DrawYes,
    DrawNo,
    /// Asks to take back the last move, or accepts the opponent's request.
    TakebackYes,
    TakebackNo,
    /// Wins the game after the opponent left it.
    ClaimVictory,
    /// Draws the game after the opponent left it.
    ClaimDraw,
}

impl GameAction {
    fn path(self) -> &'static str {
        match self {
            GameAction::Abort => "abort",
            GameAction::Resign => "resign",
            GameAction::DrawYes => "draw/yes",
            GameAction::DrawNo => "draw/no",
            GameAction::TakebackYes => "takeback/yes",
            GameAction::TakebackNo => "takeback/no",
            GameAction::ClaimVictory => "claim-victory",
            GameAction::ClaimDraw => "claim-draw",
        }
    }
}

fn invalid(message: &str) -> RequestError {
    RequestError::Failed {
        message: message.to_owned(),
    }
}

/// Game and challenge IDs are eight letters and digits; a game's full ID,
/// which includes the player, is twelve.
fn check_id(id: &str) -> Result<&str, RequestError> {
    if (8..=12).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err(invalid("that isn't a Lichess game or challenge ID"))
    }
}

/// Lichess usernames: 2 to 30 letters, digits, `_` and `-`.
fn check_username(name: &str) -> Result<&str, RequestError> {
    let name = name.trim();
    if (2..=30).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(name)
    } else {
        Err(invalid("that isn't a Lichess username"))
    }
}

/// A move in UCI notation, e.g. `e2e4` or `e7e8q`.
fn check_uci(uci: &str) -> Result<&str, RequestError> {
    let bytes = uci.as_bytes();
    let square =
        |file: u8, rank: u8| (b'a'..=b'h').contains(&file) && (b'1'..=b'8').contains(&rank);
    let valid = matches!(bytes.len(), 4 | 5)
        && square(bytes[0], bytes[1])
        && square(bytes[2], bytes[3])
        && (bytes.len() == 4 || b"qrbn".contains(&bytes[4]));
    if valid {
        Ok(uci)
    } else {
        Err(invalid("that isn't a move"))
    }
}

/// Runs stream `stream_id` of `path`, handing its lines to `on_line`.
/// Resolves with whether Lichess closed it (rather than the app).
async fn run_stream(
    lichess: &Lichess,
    streams: &Streams,
    stream_id: u32,
    path: &str,
    form: Option<&[(&str, String)]>,
    on_line: impl FnMut(Value),
) -> Result<bool, RequestError> {
    let stop = streams.open(stream_id);
    let result = lichess.stream(path, form, stop, on_line).await;
    streams.close(stream_id);
    result
}

/// Forwards streamed lines to the frontend.
fn forward(channel: Channel<Value>) -> impl FnMut(Value) {
    move |line| {
        let _ = channel.send(line);
    }
}

/// Streams the account's events: games starting and finishing, and
/// challenges arriving, being cancelled or declined. Lichess sends the current
/// games and challenges first.
#[tauri::command]
pub async fn lichess_stream_events(
    lichess: State<'_, Lichess>,
    streams: State<'_, Streams>,
    stream_id: u32,
    on_event: Channel<Value>,
) -> Result<bool, RequestError> {
    run_stream(
        &lichess,
        &streams,
        stream_id,
        "/api/stream/event",
        None,
        forward(on_event),
    )
    .await
}

/// Streams game `game_id`: the full game first, then every change of state,
/// chat lines and the opponent leaving or coming back. Lichess closes the
/// stream when the game ends.
#[tauri::command]
pub async fn lichess_stream_game(
    lichess: State<'_, Lichess>,
    streams: State<'_, Streams>,
    stream_id: u32,
    game_id: String,
    on_event: Channel<Value>,
) -> Result<bool, RequestError> {
    let path = format!("/api/board/game/stream/{}", check_id(&game_id)?);
    run_stream(
        &lichess,
        &streams,
        stream_id,
        &path,
        None,
        forward(on_event),
    )
    .await
}

/// Seeks a game against anyone. A real-time seek lasts as long as stream
/// `stream_id` is open, and resolves once a game started (the game itself
/// arrives on the event stream) or the seek is stopped. A correspondence seek
/// stays on Lichess until someone takes it, and resolves right away.
#[tauri::command]
pub async fn lichess_seek(
    lichess: State<'_, Lichess>,
    streams: State<'_, Streams>,
    stream_id: u32,
    request: GameRequest,
) -> Result<bool, RequestError> {
    request.clock.validate()?;
    let mut form = vec![("rated", request.rated.to_string())];
    match request.clock {
        GameClock::Clock {
            limit_seconds,
            increment_seconds,
        } => {
            // Seeks take minutes, which may be fractional.
            form.push(("time", (f64::from(limit_seconds) / 60.0).to_string()));
            form.push(("increment", increment_seconds.to_string()));
            form.push(("color", request.color.as_str().to_owned()));
        }
        GameClock::Correspondence { days } => {
            form.push(("days", days.to_string()));
            lichess.send(Method::POST, "/api/board/seek", &form).await?;
            return Ok(true);
        }
        GameClock::Unlimited => return Err(invalid("seeks need a time control")),
    }
    // The seek stream only carries keep-alives.
    run_stream(
        &lichess,
        &streams,
        stream_id,
        "/api/board/seek",
        Some(&form),
        |_| {},
    )
    .await
}

/// Stops stream `stream_id`, e.g. a game stream when its tab closes or a seek.
#[tauri::command]
pub fn lichess_stream_stop(streams: State<'_, Streams>, stream_id: u32) {
    streams.stop(stream_id);
}

/// Starts a game against the Lichess AI and returns it, including its `id`.
#[tauri::command]
pub async fn lichess_challenge_ai(
    lichess: State<'_, Lichess>,
    game: AiGame,
) -> Result<Value, RequestError> {
    if !(1..=8).contains(&game.level) {
        return Err(invalid("the Lichess AI plays at levels 1 to 8"));
    }
    game.clock.validate()?;
    let mut form = vec![
        ("level", game.level.to_string()),
        ("color", game.color.as_str().to_owned()),
    ];
    form.extend(game.clock.challenge_fields());
    if let Some(fen) = game.fen {
        form.push(("fen", fen));
    }
    lichess.send(Method::POST, "/api/challenge/ai", &form).await
}

/// Challenges `username` to a game and returns the challenge. Real-time
/// challenges that nobody answers expire after a while.
#[tauri::command]
pub async fn lichess_challenge(
    lichess: State<'_, Lichess>,
    username: String,
    request: GameRequest,
) -> Result<Value, RequestError> {
    request.clock.validate()?;
    let username = check_username(&username)?;
    let mut form = vec![
        ("rated", request.rated.to_string()),
        ("color", request.color.as_str().to_owned()),
    ];
    form.extend(request.clock.challenge_fields());
    lichess
        .send(Method::POST, &format!("/api/challenge/{username}"), &form)
        .await
}

/// Accepts or declines a challenge to the user, or cancels one of theirs.
#[tauri::command]
pub async fn lichess_challenge_respond(
    lichess: State<'_, Lichess>,
    challenge_id: String,
    action: ChallengeAction,
) -> Result<(), RequestError> {
    let id = check_id(&challenge_id)?;
    let verb = match action {
        ChallengeAction::Accept => "accept",
        ChallengeAction::Decline => "decline",
        ChallengeAction::Cancel => "cancel",
    };
    lichess
        .send(Method::POST, &format!("/api/challenge/{id}/{verb}"), &[])
        .await?;
    Ok(())
}

/// Plays `uci` in game `game_id`, offering a draw with it if asked.
#[tauri::command]
pub async fn lichess_game_move(
    lichess: State<'_, Lichess>,
    game_id: String,
    uci: String,
    offering_draw: bool,
) -> Result<(), RequestError> {
    let path = format!(
        "/api/board/game/{}/move/{}{}",
        check_id(&game_id)?,
        check_uci(&uci)?,
        if offering_draw {
            "?offeringDraw=true"
        } else {
            ""
        }
    );
    lichess.send(Method::POST, &path, &[]).await?;
    Ok(())
}

#[tauri::command]
pub async fn lichess_game_action(
    lichess: State<'_, Lichess>,
    game_id: String,
    action: GameAction,
) -> Result<(), RequestError> {
    let path = format!("/api/board/game/{}/{}", check_id(&game_id)?, action.path());
    lichess.send(Method::POST, &path, &[]).await?;
    Ok(())
}

/// Says something to the opponent in game `game_id`.
#[tauri::command]
pub async fn lichess_game_chat(
    lichess: State<'_, Lichess>,
    game_id: String,
    text: String,
) -> Result<(), RequestError> {
    let text: String = text.trim().chars().take(MAX_CHAT_CHARS).collect();
    if text.is_empty() {
        return Ok(());
    }
    let path = format!("/api/board/game/{}/chat", check_id(&game_id)?);
    lichess
        .send(
            Method::POST,
            &path,
            &[("room", "player".to_owned()), ("text", text)],
        )
        .await?;
    Ok(())
}

/// The chat of game `game_id` so far, as `[{ user, text }]`.
#[tauri::command]
pub async fn lichess_game_chat_history(
    lichess: State<'_, Lichess>,
    game_id: String,
) -> Result<Value, RequestError> {
    let path = format!("/api/board/game/{}/chat", check_id(&game_id)?);
    lichess.send(Method::GET, &path, &[]).await
}

/// The user's ongoing games, real-time and correspondence, most urgent first.
#[tauri::command]
pub async fn lichess_playing(lichess: State<'_, Lichess>) -> Result<Value, RequestError> {
    lichess
        .get_json(
            "https://lichess.org/api/account/playing",
            &[("nb", PLAYING_LIMIT.to_owned())],
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_ids_moves_and_usernames() {
        assert!(check_id("abcd1234").is_ok());
        assert!(check_id("abcd1234WXYZ").is_ok());
        assert!(check_id("abc").is_err());
        assert!(check_id("abcd1234/../x").is_err());
        assert!(check_uci("e2e4").is_ok());
        assert!(check_uci("e7e8q").is_ok());
        assert!(check_uci("e7e8k").is_err());
        assert!(check_uci("e2e9").is_err());
        assert!(check_uci("e2e4/resign").is_err());
        assert_eq!(check_username(" Mochi_the-Cat ").unwrap(), "Mochi_the-Cat");
        assert!(check_username("a").is_err());
        assert!(check_username("mochi/abort").is_err());
    }

    #[test]
    fn stops_streams_even_before_they_start() {
        let streams = Streams::default();
        let mut running = streams.open(1);
        assert!(running.try_recv().is_err());
        streams.stop(1);
        assert!(running.try_recv().is_ok());

        streams.stop(2);
        let mut late = streams.open(2);
        assert!(late.try_recv().is_ok());
        let mut again = streams.open(3);
        assert!(again.try_recv().is_err());
    }

    #[test]
    fn checks_time_controls() {
        let clock = |limit_seconds, increment_seconds| GameClock::Clock {
            limit_seconds,
            increment_seconds,
        };
        assert!(clock(600, 5).validate().is_ok());
        assert!(clock(0, 0).validate().is_err());
        assert!(clock(20_000, 0).validate().is_err());
        assert!(GameClock::Correspondence { days: 3 }.validate().is_ok());
        assert!(GameClock::Correspondence { days: 4 }.validate().is_err());
        assert_eq!(
            clock(900, 10).challenge_fields(),
            vec![
                ("clock.limit", "900".to_owned()),
                ("clock.increment", "10".to_owned())
            ]
        );
        assert_eq!(
            GameClock::Correspondence { days: 7 }.challenge_fields(),
            vec![("days", "7".to_owned())]
        );
    }

    #[test]
    fn reads_requests_from_the_frontend() {
        let request: GameRequest = serde_json::from_str(
            r#"{"clock":{"type":"clock","limitSeconds":600,"incrementSeconds":5},"color":"random","rated":true}"#,
        )
        .unwrap();
        assert_eq!(
            request.clock,
            GameClock::Clock {
                limit_seconds: 600,
                increment_seconds: 5
            }
        );
        let action: GameAction = serde_json::from_str(r#""takebackYes""#).unwrap();
        assert_eq!(action.path(), "takeback/yes");
    }
}
