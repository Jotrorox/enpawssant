//! SQLite databases in the app's data directory. Each [`Store`] opens its file on first use and
//! runs every query on a blocking thread, so commands never stall the async runtime.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};

pub struct Store {
    file_name: &'static str,
    /// Run on every new connection; must be idempotent.
    schema: &'static str,
    conn: Arc<Mutex<Option<Connection>>>,
}

impl Store {
    pub fn new(file_name: &'static str, schema: &'static str) -> Store {
        Store {
            file_name,
            schema,
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// Runs `f` on the shared connection, opening the database first if needed.
    pub async fn run<R, T, F>(&self, app: &AppHandle<R>, f: F) -> Result<T, String>
    where
        R: Runtime,
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let path = self.path(app)?;
        let schema = self.schema;
        let conn = self.conn.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut slot = conn.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_none() {
                *slot = Some(open(&path, schema)?);
            }
            f(slot.as_mut().expect("just opened")).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("the database task failed: {e}"))?
    }

    /// Opens a separate connection, for long imports that should not block other queries.
    pub fn connect<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Connection, String> {
        open(&self.path(app)?, self.schema)
    }

    /// Where the database file is.
    pub fn path<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not find the app data folder: {e}"))?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        Ok(dir.join(self.file_name))
    }
}

fn open(path: &std::path::Path, schema: &str) -> Result<Connection, String> {
    let conn =
        Connection::open(path).map_err(|e| format!("could not open {}: {e}", path.display()))?;
    configure(&conn, schema).map_err(|e| format!("could not set up {}: {e}", path.display()))?;
    Ok(conn)
}

/// Sets up a fresh connection: WAL lets an import write while searches read.
pub fn configure(conn: &Connection, schema: &str) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    )?;
    conn.execute_batch(schema)
}

/// Seconds since the Unix epoch.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}
