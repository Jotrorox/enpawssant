mod engine;
mod explorer;
mod lichess;
mod pgn;

use engine::{Engine, EngineEvent, EngineInfo};
use lichess::Lichess;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};

/// Starts the Stockfish sidecar if needed and describes it.
#[tauri::command]
async fn engine_info(app: AppHandle, engine: State<'_, Engine>) -> Result<EngineInfo, String> {
    engine.info(&app).await
}

/// Analyses `fen` with `multipv` lines until another position is requested or
/// `engine_stop` is called. Updates arrive on `on_event`.
#[tauri::command]
async fn engine_analyze(
    app: AppHandle,
    engine: State<'_, Engine>,
    fen: String,
    multipv: u32,
    on_event: Channel<EngineEvent>,
) -> Result<(), String> {
    engine.analyze(&app, fen, multipv, on_event).await
}

/// Stops the current analysis.
#[tauri::command]
async fn engine_stop(engine: State<'_, Engine>) -> Result<(), String> {
    engine.stop().await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .manage(Lichess::default())
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_analyze,
            engine_stop,
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
                tauri::async_runtime::block_on(app.state::<Engine>().shutdown());
            }
        });
}
