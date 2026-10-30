//! Tauri 2 plugin giving Entanglement a SQLite executor: one serialized
//! connection per opened database, so a transaction (`begin` .. `commit`) can
//! span several calls. Databases live in the app data directory.

mod store;

use std::path::PathBuf;

use serde_json::Value;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

use store::{Databases, Result};

fn dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn select<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String, sql: String, args: Option<Vec<Value>>) -> Result<Vec<Value>> {
    dbs.with(&dir(&app)?, &db, |c| store::select(c, &sql, &args.unwrap_or_default()))
}

#[tauri::command]
fn execute<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String, sql: String, args: Option<Vec<Value>>) -> Result<()> {
    dbs.with(&dir(&app)?, &db, |c| store::execute(c, &sql, &args.unwrap_or_default()))
}

#[tauri::command]
fn begin<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String) -> Result<()> {
    dbs.with(&dir(&app)?, &db, |c| store::execute(c, "BEGIN IMMEDIATE", &[]))
}

#[tauri::command]
fn commit<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String) -> Result<()> {
    dbs.with(&dir(&app)?, &db, |c| store::execute(c, "COMMIT", &[]))
}

#[tauri::command]
fn rollback<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String) -> Result<()> {
    dbs.with(&dir(&app)?, &db, |c| store::execute(c, "ROLLBACK", &[]))
}

#[tauri::command]
fn data_version<R: Runtime>(app: tauri::AppHandle<R>, dbs: State<'_, Databases>, db: String) -> Result<i64> {
    dbs.with(&dir(&app)?, &db, store::data_version)
}

#[tauri::command]
fn close(dbs: State<'_, Databases>, db: String) -> Result<()> {
    dbs.close(&db)
}

/// Register with `tauri::Builder::default().plugin(tauri_plugin_entanglement_sqlite::init())`
/// and grant `entanglement-sqlite:default` in a capability.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("entanglement-sqlite")
        .invoke_handler(tauri::generate_handler![select, execute, begin, commit, rollback, data_version, close])
        .setup(|app, _| {
            app.manage(Databases::default());
            Ok(())
        })
        .build()
}
