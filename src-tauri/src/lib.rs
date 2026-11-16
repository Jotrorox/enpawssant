mod engine;
mod explorer;
mod lichess;
mod pgn;

use engine::{Clock, Engine, EngineEvent, EngineInfo, Opponent, Strength};
use lichess::Lichess;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};

/// Starts the Stockfish sidecar if needed and describes it.
#[tauri::command]
async fn engine_info(app: AppHandle, engine: State<'_, Engine>) -> Result<EngineInfo, String> {
    engine.info(&app).await
}

/// Analyses `fen` with `multipv` lines until another position is requested or
/// `engine_stop` is called, or only to `depth` when given. Updates arrive on
/// `on_event`, which ends with a `done` event.
#[tauri::command]
async fn engine_analyze(
    app: AppHandle,
    engine: State<'_, Engine>,
    fen: String,
    multipv: u32,
    depth: Option<u32>,
    on_event: Channel<EngineEvent>,
) -> Result<(), String> {
    engine.analyze(&app, fen, multipv, depth, on_event).await
}

/// Stops the current analysis.
#[tauri::command]
async fn engine_stop(engine: State<'_, Engine>) -> Result<(), String> {
    engine.stop().await;
    Ok(())
}

/// Starts the engine that games are played against, if needed, and describes it.
#[tauri::command]
async fn opponent_info(
    app: AppHandle,
    opponent: State<'_, Opponent>,
) -> Result<EngineInfo, String> {
    opponent.0.info(&app).await
}

/// Asks the opponent for its move in the position after `moves` from `fen`,
/// playing at `strength` with `clock` (or for a second without one). Pass
/// `new_game` with the first request of a game. The move arrives in the `done`
/// event on `on_event`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn opponent_move(
    app: AppHandle,
    opponent: State<'_, Opponent>,
    fen: String,
    moves: Vec<String>,
    strength: Strength,
    clock: Option<Clock>,
    new_game: bool,
    on_event: Channel<EngineEvent>,
) -> Result<(), String> {
    opponent
        .0
        .play(&app, fen, moves, strength, clock, new_game, on_event)
        .await
}

/// Stops the opponent's search; its `done` event then has no move.
#[tauri::command]
async fn opponent_stop(opponent: State<'_, Opponent>) -> Result<(), String> {
    opponent.0.stop().await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .manage(Opponent::new())
        .manage(Lichess::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_analyze,
            engine_stop,
            opponent_info,
            opponent_move,
            opponent_stop,
            pgn::pgn_parse,
            pgn::pgn_export,
            pgn::pgn_open_file,
            pgn::pgn_save_file,
            explorer::explorer_moves,
            explorer::opening_name,
            explorer::lichess_account,
            explorer::lichess_sign_in,
            explorer::lichess_cancel_sign_in,
            explorer::lichess_sign_out,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let (engine, opponent) = (app.state::<Engine>(), app.state::<Opponent>());
                tauri::async_runtime::block_on(async {
                    tokio::join!(engine.shutdown(), opponent.0.shutdown());
                });
            }
        });
}
