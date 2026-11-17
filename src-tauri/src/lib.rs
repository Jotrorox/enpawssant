mod blunders;
mod board;
mod database;
mod engine;
mod engines;
mod explorer;
mod files;
mod lichess;
mod online;
mod pgn;
mod puzzles;
mod store;

use blunders::Blunders;
use database::Database;
use engine::{Clock, Engine, EngineEvent, EngineInfo, Opponent, Strength};
use engines::Engines;
use lichess::Lichess;
use online::ChessCom;
use puzzles::Puzzles;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};

/// Starts engine `engine_id` if needed and describes it.
#[tauri::command]
async fn engine_info(
    app: AppHandle,
    engine: State<'_, Engine>,
    engines: State<'_, Engines>,
    engine_id: String,
) -> Result<EngineInfo, String> {
    engine.info(&app, &engines, &engine_id).await
}

/// Analyses `fen` with engine `engine_id` and `multipv` lines until another
/// position is requested from it or `engine_stop` is called, or only to
/// `depth` when given. Updates arrive on `on_event`, which ends with a `done`
/// event.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn engine_analyze(
    app: AppHandle,
    engine: State<'_, Engine>,
    engines: State<'_, Engines>,
    engine_id: String,
    fen: String,
    multipv: u32,
    depth: Option<u32>,
    on_event: Channel<EngineEvent>,
) -> Result<(), String> {
    engine
        .analyze(&app, &engines, &engine_id, fen, multipv, depth, on_event)
        .await
}

/// Stops the current analysis of engine `engine_id`.
#[tauri::command]
async fn engine_stop(engine: State<'_, Engine>, engine_id: String) -> Result<(), String> {
    engine.stop(&engine_id).await;
    Ok(())
}

/// Starts the engine that games are played against, if needed, and describes it.
#[tauri::command]
async fn opponent_info(
    app: AppHandle,
    opponent: State<'_, Opponent>,
) -> Result<EngineInfo, String> {
    opponent.info(&app).await
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
        .play(&app, fen, moves, strength, clock, new_game, on_event)
        .await
}

/// Stops the opponent's search; its `done` event then has no move.
#[tauri::command]
async fn opponent_stop(opponent: State<'_, Opponent>) -> Result<(), String> {
    opponent.stop().await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .manage(Opponent::new())
        .manage(Engines::default())
        .manage(Lichess::default())
        .manage(board::Streams::default())
        .manage(ChessCom::default())
        .manage(Database::default())
        .manage(Puzzles::default())
        .manage(Blunders::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_analyze,
            engine_stop,
            opponent_info,
            opponent_move,
            opponent_stop,
            engines::engines_config,
            engines::engines_add,
            engines::engines_remove,
            engines::engines_rename,
            engines::engines_set_option,
            engines::engines_set_roles,
            engines::engines_probe,
            pgn::pgn_parse,
            pgn::pgn_export,
            pgn::pgn_open_file,
            pgn::pgn_save_file,
            files::files_places,
            files::files_list,
            files::files_pick_folder,
            files::pgn_read_path,
            database::db_stats,
            database::db_search,
            database::db_game,
            database::db_add_game,
            database::db_add_games,
            database::db_delete_game,
            database::db_clear,
            database::db_explorer,
            database::db_import_files,
            database::db_import_paths,
            database::db_cancel_import,
            database::db_my_names,
            database::db_set_my_names,
            database::db_find_game,
            explorer::explorer_moves,
            explorer::opening_name,
            explorer::lichess_account,
            explorer::lichess_sign_in,
            explorer::lichess_cancel_sign_in,
            explorer::lichess_sign_out,
            board::lichess_stream_events,
            board::lichess_stream_game,
            board::lichess_seek,
            board::lichess_stream_stop,
            board::lichess_challenge_ai,
            board::lichess_challenge,
            board::lichess_challenge_respond,
            board::lichess_game_move,
            board::lichess_game_action,
            board::lichess_game_chat,
            board::lichess_game_chat_history,
            board::lichess_playing,
            online::lichess_games,
            online::chesscom_games,
            puzzles::puzzles_status,
            puzzles::puzzles_next,
            puzzles::puzzles_next_own,
            puzzles::puzzles_clear_own,
            blunders::puzzles_find_blunders,
            blunders::puzzles_cancel_blunders,
            puzzles::puzzles_record,
            puzzles::puzzles_finish_run,
            puzzles::puzzles_reset_progress,
            puzzles::puzzles_download,
            puzzles::puzzles_cancel_download,
            puzzles::puzzles_open_game,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let (engine, opponent) = (app.state::<Engine>(), app.state::<Opponent>());
                let blunders = app.state::<Blunders>();
                tauri::async_runtime::block_on(async {
                    tokio::join!(engine.shutdown(), opponent.shutdown(), blunders.shutdown());
                });
            }
        });
}
