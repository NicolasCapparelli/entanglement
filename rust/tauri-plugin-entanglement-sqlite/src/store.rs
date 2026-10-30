//! The command logic, free of Tauri so it can be unit-tested.
//!
//! Each opened database is exactly one `rusqlite::Connection` behind a mutex,
//! so every call is serialized and a transaction opened by `begin` stays on
//! the same connection until `commit` or `rollback` (which a connection pool
//! cannot guarantee).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde_json::{json, Map, Value as Json};

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Largest integer a JS number holds exactly.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// JSON -> SQLite value. Plain JSON covers null, numbers and strings;
/// `{"$blob": "<base64>"}` and `{"$int": "<i64>"}` carry blobs and 64-bit ints.
pub fn to_sql(v: &Json) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().ok_or("unsupported number")?),
        },
        Json::String(s) => Value::Text(s.clone()),
        Json::Object(o) => {
            if let Some(Json::String(b)) = o.get("$blob") {
                Value::Blob(STANDARD.decode(b).map_err(err)?)
            } else if let Some(Json::String(i)) = o.get("$int") {
                Value::Integer(i.parse::<i64>().map_err(err)?)
            } else {
                return Err("unsupported argument object".into());
            }
        }
        Json::Array(_) => return Err("array arguments are not supported".into()),
    })
}

fn from_sql(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) if (-MAX_SAFE..=MAX_SAFE).contains(&i) => json!(i),
        ValueRef::Integer(i) => json!({ "$int": i.to_string() }),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "$blob": STANDARD.encode(b) }),
    }
}

fn params(args: &[Json]) -> Result<Vec<Value>> {
    args.iter().map(to_sql).collect()
}

pub fn open_connection(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(err)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
        .map_err(err)?;
    Ok(conn)
}

pub fn select(conn: &Connection, sql: &str, args: &[Json]) -> Result<Vec<Json>> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(params(args)?)).map_err(err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut obj = Map::new();
        for (i, name) in names.iter().enumerate() {
            obj.insert(name.clone(), from_sql(row.get_ref(i).map_err(err)?));
        }
        out.push(Json::Object(obj));
    }
    Ok(out)
}

pub fn execute(conn: &Connection, sql: &str, args: &[Json]) -> Result<()> {
    if args.is_empty() {
        // Allows multi-statement scripts (schema setup).
        return conn.execute_batch(sql).map_err(err);
    }
    let mut stmt = conn.prepare(sql).map_err(err)?;
    stmt.execute(rusqlite::params_from_iter(params(args)?)).map_err(err)?;
    Ok(())
}

pub fn data_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA data_version", [], |r| r.get(0)).map_err(err)
}

/// Database names are file names inside the app data directory, nothing more.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// All open databases, keyed by name.
#[derive(Default)]
pub struct Databases {
    open: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl Databases {
    /// Returns the connection for `name`, opening `dir/name` on first use.
    pub fn get(&self, dir: &Path, name: &str) -> Result<Arc<Mutex<Connection>>> {
        if !valid_name(name) {
            return Err(format!("invalid database name: {name:?}"));
        }
        let mut open = self.open.lock().map_err(err)?;
        if let Some(c) = open.get(name) {
            return Ok(c.clone());
        }
        std::fs::create_dir_all(dir).map_err(err)?;
        let path: PathBuf = dir.join(name);
        let conn = Arc::new(Mutex::new(open_connection(&path)?));
        open.insert(name.to_string(), conn.clone());
        Ok(conn)
    }

    pub fn with<T>(&self, dir: &Path, name: &str, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.get(dir, name)?;
        let guard = conn.lock().map_err(err)?;
        f(&guard)
    }

    /// Closes (drops) the connection; a no-op if it was never opened.
    pub fn close(&self, name: &str) -> Result<()> {
        let removed = self.open.lock().map_err(err)?.remove(name);
        if let Some(c) = removed {
            // Waits for any in-flight call, then drops the connection.
            drop(c.lock().map_err(err)?);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn round_trips_every_value_type() {
        let c = mem();
        execute(&c, "CREATE TABLE t (a INTEGER, b REAL, c TEXT, d BLOB, e TEXT, f INTEGER)", &[]).unwrap();
        execute(
            &c,
            "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)",
            &[json!(42), json!(1.5), json!("ü"), json!({"$blob": STANDARD.encode([1u8, 2, 3])}), Json::Null, json!({"$int": "9007199254740993"})],
        )
        .unwrap();
        let rows = select(&c, "SELECT * FROM t", &[]).unwrap();
        assert_eq!(rows[0]["a"], json!(42));
        assert_eq!(rows[0]["b"], json!(1.5));
        assert_eq!(rows[0]["c"], json!("ü"));
        assert_eq!(rows[0]["d"], json!({"$blob": "AQID"}));
        assert_eq!(rows[0]["e"], Json::Null);
        assert_eq!(rows[0]["f"], json!({"$int": "9007199254740993"}));
    }

    #[test]
    fn transactions_commit_and_roll_back_on_one_connection() {
        let c = mem();
        execute(&c, "CREATE TABLE t (a INTEGER PRIMARY KEY)", &[]).unwrap();
        execute(&c, "BEGIN IMMEDIATE", &[]).unwrap();
        execute(&c, "INSERT INTO t VALUES (?)", &[json!(1)]).unwrap();
        execute(&c, "ROLLBACK", &[]).unwrap();
        assert!(select(&c, "SELECT a FROM t", &[]).unwrap().is_empty());
        execute(&c, "BEGIN IMMEDIATE", &[]).unwrap();
        execute(&c, "INSERT INTO t VALUES (?)", &[json!(2)]).unwrap();
        assert!(execute(&c, "INSERT INTO t VALUES (?)", &[json!(2)]).is_err());
        execute(&c, "COMMIT", &[]).unwrap();
        assert_eq!(select(&c, "SELECT a FROM t", &[]).unwrap().len(), 1);
    }

    #[test]
    fn begin_immediate_blocks_a_second_connection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let a = open_connection(&path).unwrap();
        let b = open_connection(&path).unwrap();
        b.execute_batch("PRAGMA busy_timeout = 0").unwrap();
        execute(&a, "CREATE TABLE t (a INTEGER)", &[]).unwrap();
        execute(&a, "BEGIN IMMEDIATE", &[]).unwrap();
        assert!(execute(&b, "BEGIN IMMEDIATE", &[]).is_err());
        execute(&a, "COMMIT", &[]).unwrap();
    }

    #[test]
    fn data_version_changes_on_foreign_commit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let a = open_connection(&path).unwrap();
        let b = open_connection(&path).unwrap();
        execute(&a, "CREATE TABLE t (a INTEGER)", &[]).unwrap();
        let before = data_version(&a).unwrap();
        assert_eq!(data_version(&a).unwrap(), before);
        execute(&b, "INSERT INTO t VALUES (1)", &[]).unwrap();
        assert!(data_version(&a).unwrap() > before);
    }

    #[test]
    fn databases_open_once_persist_and_close() {
        let dir = tempfile::tempdir().unwrap();
        let dbs = Databases::default();
        dbs.with(dir.path(), "x.db", |c| execute(c, "CREATE TABLE t (a)", &[])).unwrap();
        dbs.with(dir.path(), "x.db", |c| execute(c, "INSERT INTO t VALUES (1)", &[])).unwrap();
        dbs.close("x.db").unwrap();
        dbs.close("x.db").unwrap();
        let rows = dbs.with(dir.path(), "x.db", |c| select(c, "SELECT a FROM t", &[])).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn rejects_path_traversal_names() {
        let dir = tempfile::tempdir().unwrap();
        let dbs = Databases::default();
        for bad in ["../x", "a/b", "", ".hidden", "a\\b"] {
            assert!(dbs.get(dir.path(), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_unsupported_arguments() {
        assert!(to_sql(&json!([1])).is_err());
        assert!(to_sql(&json!({"x": 1})).is_err());
    }
}
