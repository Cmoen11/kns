//! Database view: mirror of `src/ipc/contract/db.ts`. A Postgres or MySQL/MariaDB server in a pod,
//! found from the pod spec (image, ports, env), opened over a private tunnel with credentials read
//! from the pod's env and Secrets. Passwords stay in Rust: the UI sees where one comes from, never
//! the value. Produced by `crate::database`.
use serde::{Deserialize, Serialize};

use crate::ipc::ObjRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbEngine {
    Postgres,
    /// MySQL and MariaDB
    Mysql,
}

/// A user kns can log in as, and where its password comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCredential {
    pub user: String,
    /// the database to open first, when the env names one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// where the password comes from: `env POSTGRES_PASSWORD (secret/pg:password)`; none = no password
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDetectRequest {
    /// a pod, workload or Service; a workload's or Service's running pod is picked (the primary when labelled)
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
}

/// The database server kns found behind an object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTarget {
    pub engine: DbEngine,
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub image: String,
    pub port: u16,
    /// best first
    pub credentials: Vec<DbCredential>,
    /// why something was guessed or could not be read
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnectRequest {
    /// the pod (from DbTarget)
    #[serde(rename = "ref")]
    pub obj_ref: ObjRef,
    pub engine: DbEngine,
    pub container: String,
    pub port: u16,
    pub user: String,
    /// typed by the human; when absent the password is read again from the source of the user's credential
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
}

/// An open connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSession {
    pub id: String,
    pub engine: DbEngine,
    pub user: String,
    /// the database the connection is in (Postgres); MySQL: the default schema, if any
    pub database: String,
    pub server_version: String,
    /// Postgres: the databases to switch to; MySQL: the schemas
    pub databases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableEntry {
    pub name: String,
    /// table, view, matview, partitioned, foreign
    pub kind: String,
    /// the server's estimate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchemaEntry {
    pub name: String,
    pub tables: Vec<DbTableEntry>,
}

/// The tables of the open database (Postgres: by schema; MySQL: by database).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchema {
    pub schemas: Vec<DbSchemaEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbIndex {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableInfo {
    pub columns: Vec<DbColumn>,
    pub indexes: Vec<DbIndex>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTableRequest {
    pub session: String,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbRowsRequest {
    pub session: String,
    pub schema: String,
    pub table: String,
    pub offset: u32,
    /// at most 1000
    pub limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryRequest {
    pub session: String,
    /// one statement
    pub sql: String,
    /// run it read-write and commit; refused in a read-only context
    #[serde(default)]
    pub write: bool,
    /// a write in a protected context: the database name, typed by the human
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_text: Option<String>,
    /// rows to return, at most 5000 (default 500)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResultColumn {
    pub name: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
}

/// Rows as text (`null` = SQL NULL); long values are cut.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResult {
    pub columns: Vec<DbResultColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// more rows than were returned
    pub truncated: bool,
    /// rows a write changed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    /// the server's command tag (SELECT 3, UPDATE 1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::drift::Fixtures;
    use crate::ipc::Gvr;

    #[test]
    fn drift() {
        let mut f = Fixtures::new("db");
        let pod = ObjRef { context: "default".into(), gvr: Gvr::new("", "v1", "pods"), namespace: Some("payments".into()), name: "postgres-0".into() };
        f.add("detect", "DbDetectRequest", &DbDetectRequest { obj_ref: pod.clone() });
        f.add(
            "target",
            "DbTarget",
            &DbTarget {
                engine: DbEngine::Postgres,
                namespace: "payments".into(),
                pod: "postgres-0".into(),
                container: "postgres".into(),
                image: "postgres:17".into(),
                port: 5432,
                credentials: vec![
                    DbCredential { user: "app".into(), database: Some("payments".into()), from: Some("env POSTGRES_PASSWORD (secret/pg:password)".into()) },
                    DbCredential { user: "postgres".into(), database: None, from: None },
                ],
                notes: vec!["secret pg-admin is not readable (Forbidden)".into()],
            },
        );
        f.add(
            "connects",
            "DbConnectRequest[]",
            &vec![
                DbConnectRequest { obj_ref: pod.clone(), engine: DbEngine::Postgres, container: "postgres".into(), port: 5432, user: "app".into(), password: None, database: Some("payments".into()) },
                DbConnectRequest { obj_ref: pod, engine: DbEngine::Mysql, container: "mysql".into(), port: 3306, user: "root".into(), password: Some("typed".into()), database: None },
            ],
        );
        f.add(
            "session",
            "DbSession",
            &DbSession { id: "db-1".into(), engine: DbEngine::Postgres, user: "app".into(), database: "payments".into(), server_version: "17.2".into(), databases: vec!["payments".into(), "postgres".into()] },
        );
        f.add(
            "schema",
            "DbSchema",
            &DbSchema {
                schemas: vec![DbSchemaEntry {
                    name: "public".into(),
                    tables: vec![DbTableEntry { name: "orders".into(), kind: "table".into(), rows: Some(1200) }, DbTableEntry { name: "open_orders".into(), kind: "view".into(), rows: None }],
                }],
            },
        );
        f.add("tableReq", "DbTableRequest", &DbTableRequest { session: "db-1".into(), schema: "public".into(), table: "orders".into() });
        f.add(
            "tableInfo",
            "DbTableInfo",
            &DbTableInfo {
                columns: vec![
                    DbColumn { name: "id".into(), type_name: "bigint".into(), nullable: false, default: Some("nextval('orders_id_seq'::regclass)".into()), primary_key: true },
                    DbColumn { name: "note".into(), type_name: "text".into(), nullable: true, default: None, primary_key: false },
                ],
                indexes: vec![DbIndex { name: "orders_pkey".into(), definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)".into() }],
            },
        );
        f.add(
            "rowsReqs",
            "DbRowsRequest[]",
            &vec![
                DbRowsRequest { session: "db-1".into(), schema: "public".into(), table: "orders".into(), offset: 0, limit: 100, order_by: None, desc: false },
                DbRowsRequest { session: "db-1".into(), schema: "public".into(), table: "orders".into(), offset: 100, limit: 100, order_by: Some("id".into()), desc: true },
            ],
        );
        f.add(
            "queries",
            "DbQueryRequest[]",
            &vec![
                DbQueryRequest { session: "db-1".into(), sql: "select 1".into(), write: false, confirm_text: None, limit: None },
                DbQueryRequest { session: "db-1".into(), sql: "update orders set note = 'x' where id = 1".into(), write: true, confirm_text: Some("payments".into()), limit: Some(100) },
            ],
        );
        f.add(
            "result",
            "DbResult",
            &DbResult {
                columns: vec![DbResultColumn { name: "id".into(), type_name: Some("int8".into()) }, DbResultColumn { name: "note".into(), type_name: None }],
                rows: vec![vec![Some("1".into()), None], vec![Some("2".into()), Some("gift".into())]],
                truncated: false,
                affected: None,
                command: Some("SELECT 2".into()),
                elapsed_ms: 4,
            },
        );
        f.check();
    }
}
