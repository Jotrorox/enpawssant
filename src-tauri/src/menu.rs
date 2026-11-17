//! The native menu bar on macOS. Choosing an item emits a `menu` event with the item's ID, and
//! the frontend runs the command of the same name, so menus and keyboard shortcuts share one code
//! path. On Windows the frontend handles the same shortcuts itself, since a menu bar would sit
//! between the system title bar and the app's own tab bar.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Prefix of the IDs of "Open Recent" items, followed by the file's index in the list.
const RECENT_PREFIX: &str = "recent:";
/// Recent files shown in the menu; the Files section has the full list.
const MAX_RECENT: usize = 10;

/// The parts of the menu that change while the app runs.
#[derive(Default)]
pub struct AppMenu(Mutex<Option<Submenu<tauri::Wry>>>);

/// A recently opened file, as the frontend lists it.
#[derive(Deserialize)]
pub struct RecentFile {
    name: String,
}

/// Builds the menu bar and starts forwarding menu choices to the frontend.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, text);
        match accelerator {
            Some(keys) => builder.accelerator(keys),
            None => builder,
        }
        .build(app)
    };

    let app_menu = SubmenuBuilder::new(app, "EnPawssant")
        .about(Some(AboutMetadata {
            name: Some("EnPawssant".into()),
            ..Default::default()
        }))
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let recent = SubmenuBuilder::new(app, "Open Recent").build()?;
    fill_recent(app, &recent, &[])?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-tab", "New Board", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open PGN…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .item(&item(
            "import",
            "Import PGN or FEN…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("export", "Export PGN…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item(
            "save-to-database",
            "Save to Database",
            Some("CmdOrCtrl+D"),
        )?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("copy-fen", "Copy FEN", Some("CmdOrCtrl+Shift+C"))?)
        .build()?;

    let board = SubmenuBuilder::new(app, "Board")
        .item(&item("flip", "Flip Board", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item(
            "edit-position",
            "Edit Position…",
            Some("CmdOrCtrl+E"),
        )?)
        .separator()
        .item(&item(
            "toggle-engine",
            "Engine Analysis",
            Some("CmdOrCtrl+L"),
        )?)
        .item(&item(
            "analyze-game",
            "Analyze Full Game",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .separator()
        .item(&item("play", "Play vs Stockfish…", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("section:board", "Board", Some("CmdOrCtrl+1"))?)
        .item(&item("section:database", "Database", Some("CmdOrCtrl+2"))?)
        .item(&item("section:engines", "Engines", Some("CmdOrCtrl+3"))?)
        .item(&item("section:puzzles", "Purrzles", Some("CmdOrCtrl+4"))?)
        .item(&item("section:files", "Files", Some("CmdOrCtrl+5"))?)
        .separator()
        .item(&item("search", "Search Games…", Some("CmdOrCtrl+K"))?)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item(
            "prev-tab",
            "Show Previous Tab",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .item(&item(
            "next-tab",
            "Show Next Tab",
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .separator()
        .bring_all_to_front()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &board, &view, &window])
        .build()?;
    app.set_menu(menu)?;
    *app.state::<AppMenu>().0.lock().expect("menu lock poisoned") = Some(recent);

    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().as_ref());
    });
    Ok(())
}

fn fill_recent<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    files: &[RecentFile],
) -> tauri::Result<()> {
    for existing in submenu.items()? {
        submenu.remove(&existing)?;
    }
    for (index, file) in files.iter().take(MAX_RECENT).enumerate() {
        let id = format!("{RECENT_PREFIX}{index}");
        submenu.append(&MenuItemBuilder::with_id(id, &file.name).build(app)?)?;
    }
    if files.is_empty() {
        let none = MenuItemBuilder::with_id("recent-none", "No Recent Files")
            .enabled(false)
            .build(app)?;
        submenu.append(&none)?;
    } else {
        submenu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
        submenu.append(&MenuItemBuilder::with_id("recent-clear", "Clear Menu").build(app)?)?;
    }
    Ok(())
}

/// Shows the recently opened files under File › Open Recent. Choosing one emits `recent:<index>`.
#[tauri::command]
pub fn menu_set_recent(
    app: AppHandle,
    menu: State<'_, AppMenu>,
    files: Vec<RecentFile>,
) -> Result<(), String> {
    let guard = menu.0.lock().map_err(|_| "menu lock poisoned")?;
    match guard.as_ref() {
        Some(submenu) => fill_recent(&app, submenu, &files).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}
