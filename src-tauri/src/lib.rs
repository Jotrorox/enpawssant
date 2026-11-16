mod engine;

// Chess logic lives in `chess-core`; nothing calls into it yet.
use chess_core as _;

/// Starts the Stockfish sidecar and returns the engine's `id name`.
#[tauri::command]
async fn engine_info(app: tauri::AppHandle) -> Result<String, String> {
    engine::engine_name(&app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![engine_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
