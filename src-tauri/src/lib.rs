mod database;
mod engine;
mod engines;
mod explorer;
mod files;
mod lichess;
mod pgn;
mod puzzles;
mod store;

use database::Database;
use engine::{Engine, EngineEvent, EngineInfo};
use engines::Engines;
use lichess::Lichess;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .manage(Engines::default())
        .manage(Lichess::default())
        .manage(Database::default())
        .manage(Puzzles::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_analyze,
            engine_stop,
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
            database::db_delete_game,
            database::db_clear,
            database::db_explorer,
            database::db_import_files,
            database::db_import_paths,
            database::db_cancel_import,
            explorer::explorer_moves,
            explorer::opening_name,
            explorer::lichess_account,
            explorer::lichess_sign_in,
            explorer::lichess_cancel_sign_in,
            explorer::lichess_sign_out,
            puzzles::puzzles_status,
            puzzles::puzzles_next,
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
                tauri::async_runtime::block_on(app.state::<Engine>().shutdown());
            }
        });
}
