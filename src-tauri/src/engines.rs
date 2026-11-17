//! The engines the user has set up: the bundled Stockfish plus any UCI engine binary they add,
//! each with its own option values. Kept in `engines.json` in the app's config folder.
//!
//! Only Rust ever starts these programs. The frontend refers to engines by ID and can only choose
//! a binary through the native file dialog.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use chess_core::uci::UciOption;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::engine::{Engine, Handshake, LaunchSpec, Program};

/// ID of the bundled Stockfish, which cannot be removed.
pub const BUNDLED_ID: &str = "stockfish";
const CONFIG_FILE: &str = "engines.json";
/// Options the app sets itself for every search, so they are not offered in the settings.
pub const MANAGED_OPTIONS: &[&str] = &["MultiPV", "UCI_Chess960", "Ponder", "UCI_AnalyseMode"];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEntry {
    pub id: String,
    /// The name the engine reports, unless the user renamed it.
    pub name: String,
    #[serde(default)]
    pub author: Option<String>,
    /// The engine binary; `None` for the bundled Stockfish.
    #[serde(default)]
    pub path: Option<PathBuf>,
    /// Options the engine offered the last time it started.
    #[serde(default)]
    pub options: Vec<UciOption>,
    /// Values the user changed, by option name. Other options keep the engine's defaults.
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

impl EngineEntry {
    fn bundled() -> EngineEntry {
        EngineEntry {
            id: BUNDLED_ID.into(),
            name: "Stockfish".into(),
            author: None,
            path: None,
            options: Vec::new(),
            values: BTreeMap::new(),
        }
    }

    pub fn launch_spec(&self) -> LaunchSpec {
        LaunchSpec {
            program: match &self.path {
                Some(path) => Program::Path(path.clone()),
                None => Program::Bundled,
            },
            values: self.values.clone(),
        }
    }
}

/// The engine setup as stored and as sent to the frontend.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginesConfig {
    pub engines: Vec<EngineEntry>,
    /// Analyses the board, the eval bar and full-game reviews.
    pub primary: String,
    /// Analyses the same positions alongside the primary engine, if set.
    #[serde(default)]
    pub secondary: Option<String>,
}

impl Default for EnginesConfig {
    fn default() -> Self {
        EnginesConfig {
            engines: vec![EngineEntry::bundled()],
            primary: BUNDLED_ID.into(),
            secondary: None,
        }
    }
}

impl EnginesConfig {
    /// Repairs a config read from disk: the bundled engine is always there, and the roles refer
    /// to engines that exist.
    fn repaired(mut self) -> EnginesConfig {
        if !self.engines.iter().any(|e| e.id == BUNDLED_ID) {
            self.engines.insert(0, EngineEntry::bundled());
        }
        for engine in &mut self.engines {
            if engine.id == BUNDLED_ID {
                engine.path = None;
            }
        }
        if self.entry(&self.primary).is_none() {
            self.primary = BUNDLED_ID.into();
        }
        if self
            .secondary
            .as_ref()
            .is_some_and(|id| self.entry(id).is_none() || *id == self.primary)
        {
            self.secondary = None;
        }
        self
    }

    pub fn entry(&self, id: &str) -> Option<&EngineEntry> {
        self.engines.iter().find(|e| e.id == id)
    }

    fn entry_mut(&mut self, id: &str) -> Result<&mut EngineEntry, String> {
        self.engines
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| "that engine was removed".to_string())
    }
}

/// Tauri state holding the engine setup, loaded on first use.
#[derive(Default)]
pub struct Engines {
    config: Mutex<Option<EnginesConfig>>,
}

impl Engines {
    /// The current setup.
    pub fn config<R: Runtime>(&self, app: &AppHandle<R>) -> EnginesConfig {
        let mut slot = self.config.lock().unwrap_or_else(|e| e.into_inner());
        slot.get_or_insert_with(|| load(app)).clone()
    }

    /// The engine with `id`, if it exists.
    pub fn entry<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<EngineEntry, String> {
        self.config(app)
            .entry(id)
            .cloned()
            .ok_or_else(|| "that engine was removed".to_string())
    }

    /// Changes the setup and saves it.
    fn update<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        change: impl FnOnce(&mut EnginesConfig) -> Result<(), String>,
    ) -> Result<EnginesConfig, String> {
        let mut slot = self.config.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = slot.get_or_insert_with(|| load(app)).clone();
        change(&mut config)?;
        let config = config.repaired();
        save(app, &config)?;
        *slot = Some(config.clone());
        Ok(config)
    }

    /// Records what an engine reported when it started.
    pub fn discovered<R: Runtime>(&self, app: &AppHandle<R>, id: &str, handshake: &Handshake) {
        let result = self.update(app, |config| {
            let entry = config.entry_mut(id)?;
            if entry.path.is_none() || entry.name.is_empty() {
                entry.name.clone_from(&handshake.name);
            }
            entry.author.clone_from(&handshake.author);
            entry.options.clone_from(&handshake.options);
            Ok(())
        });
        if let Err(e) = result {
            eprintln!("engines: could not save what {id} reported: {e}");
        }
    }
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(dir.join(CONFIG_FILE))
}

fn load<R: Runtime>(app: &AppHandle<R>) -> EnginesConfig {
    let Ok(path) = config_path(app) else {
        return EnginesConfig::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<EnginesConfig>(&text)
            .map(EnginesConfig::repaired)
            .unwrap_or_else(|e| {
                eprintln!("engines: ignoring {}: {e}", path.display());
                EnginesConfig::default()
            }),
        Err(_) => EnginesConfig::default(),
    }
}

fn save<R: Runtime>(app: &AppHandle<R>, config: &EnginesConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    // Write a temporary file first so a crash never leaves half a config behind.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("could not save the engines: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("could not save the engines: {e}"))
}

/// A short unique ID for a new engine.
fn new_id(config: &EnginesConfig) -> String {
    let mut bytes = [0u8; 4];
    loop {
        let _ = getrandom::fill(&mut bytes);
        let id = format!("engine-{}", u32::from_le_bytes(bytes));
        if config.entry(&id).is_none() {
            return id;
        }
    }
}

// --- Commands -----------------------------------------------------------------------------------

#[tauri::command]
pub fn engines_config<R: Runtime>(app: AppHandle<R>, engines: State<'_, Engines>) -> EnginesConfig {
    engines.config(&app)
}

/// Asks for an engine binary, checks that it speaks UCI and adds it. Returns `None` when the
/// dialog is cancelled.
#[tauri::command]
pub async fn engines_add<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
) -> Result<Option<EnginesConfig>, String> {
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choose a UCI engine");
    if cfg!(windows) {
        dialog = dialog.add_filter("Programs", &["exe"]);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(chosen) = rx
        .await
        .map_err(|_| "the file dialog closed unexpectedly")?
    else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|e| format!("unsupported file location: {e}"))?;

    let handshake = crate::engine::probe(&app, &Program::Path(path.clone())).await?;
    engines
        .update(&app, |config| {
            let id = new_id(config);
            config.engines.push(EngineEntry {
                id,
                name: handshake.name,
                author: handshake.author,
                path: Some(path),
                options: handshake.options,
                values: BTreeMap::new(),
            });
            Ok(())
        })
        .map(Some)
}

#[tauri::command]
pub async fn engines_remove<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
    engine: State<'_, Engine>,
    id: String,
) -> Result<EnginesConfig, String> {
    if id == BUNDLED_ID {
        return Err("the bundled Stockfish can't be removed".into());
    }
    let config = engines.update(&app, |config| {
        config.engines.retain(|e| e.id != id);
        Ok(())
    })?;
    engine.restart(&id).await;
    Ok(config)
}

#[tauri::command]
pub fn engines_rename<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
    id: String,
    name: String,
) -> Result<EnginesConfig, String> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("the name can't be empty".into());
    }
    engines.update(&app, |config| {
        config.entry_mut(&id)?.name = name;
        Ok(())
    })
}

/// Sets an option, or resets it to the engine's default when `value` is `None`. The engine
/// restarts with the new value the next time it is used.
#[tauri::command]
pub async fn engines_set_option<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
    engine: State<'_, Engine>,
    id: String,
    name: String,
    value: Option<String>,
) -> Result<EnginesConfig, String> {
    let config = engines.update(&app, |config| {
        let entry = config.entry_mut(&id)?;
        let option = entry
            .options
            .iter()
            .find(|o| o.name == name)
            .ok_or_else(|| format!("{} has no option {name}", entry.name))?;
        if MANAGED_OPTIONS.contains(&option.name.as_str()) {
            return Err(format!("EnPawssant sets {name} itself"));
        }
        match value {
            Some(value) => {
                let value = option.normalize(&value)?;
                entry.values.insert(name.clone(), value);
            }
            None => {
                entry.values.remove(&name);
            }
        }
        Ok(())
    })?;
    engine.restart(&id).await;
    Ok(config)
}

/// Chooses the engine that analyses the board and, optionally, one that runs alongside it.
#[tauri::command]
pub async fn engines_set_roles<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
    engine: State<'_, Engine>,
    primary: String,
    secondary: Option<String>,
) -> Result<EnginesConfig, String> {
    let before = engines.config(&app);
    let config = engines.update(&app, |config| {
        config.entry(&primary).ok_or("that engine was removed")?;
        if let Some(id) = &secondary {
            config.entry(id).ok_or("that engine was removed")?;
        }
        config.primary = primary;
        config.secondary = secondary.filter(|id| *id != config.primary);
        Ok(())
    })?;
    // Engines that no longer have a role stop thinking.
    for id in [Some(before.primary), before.secondary]
        .into_iter()
        .flatten()
    {
        if id != config.primary && Some(&id) != config.secondary.as_ref() {
            engine.stop(&id).await;
        }
    }
    Ok(config)
}

/// Starts an engine if needed, so its options are known, and returns the updated setup.
#[tauri::command]
pub async fn engines_probe<R: Runtime>(
    app: AppHandle<R>,
    engines: State<'_, Engines>,
    engine: State<'_, Engine>,
    id: String,
) -> Result<EnginesConfig, String> {
    engine.info(&app, &engines, &id).await?;
    Ok(engines.config(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_configs() {
        let config: EnginesConfig = serde_json::from_str(
            r#"{"engines": [{"id": "engine-1", "name": "Lc0", "path": "/opt/lc0"}],
                "primary": "gone", "secondary": "engine-1"}"#,
        )
        .unwrap();
        let config = config.repaired();
        assert_eq!(config.engines[0].id, BUNDLED_ID);
        assert_eq!(config.primary, BUNDLED_ID);
        assert_eq!(config.secondary.as_deref(), Some("engine-1"));

        let mut same = config.clone();
        same.secondary = Some(BUNDLED_ID.into());
        assert_eq!(same.repaired().secondary, None);
    }
}
