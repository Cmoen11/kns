// Database view (`:db`, docs/tools.md#database): a Postgres or MySQL/MariaDB server in a pod,
// found from the pod spec (image, ports, env) and opened over a private tunnel with credentials
// read from the pod's env and Secrets. Passwords stay in Rust: the UI is told where one comes
// from, never the value. Queries are read-only (one statement in a read-only transaction) unless
// `write` is set. Mirror: src-tauri/src/contract/db.rs (types), src-tauri/src/database.rs (commands).
import type { ObjRef } from "../types";

/** "mysql" covers MariaDB */
export type DbEngine = "postgres" | "mysql";

/** A user kns can log in as, and where its password comes from. */
export interface DbCredential {
  user: string;
  /** the database to open first, when the env names one */
  database?: string;
  /** `env POSTGRES_PASSWORD (secret/pg:password)`; absent = no password */
  from?: string;
}

export interface DbDetectRequest {
  /** a pod, workload or Service; a workload's or Service's running pod is picked (the primary when labelled) */
  ref: ObjRef;
}

/** The database server kns found behind an object. */
export interface DbTarget {
  engine: DbEngine;
  namespace: string;
  pod: string;
  container: string;
  image: string;
  port: number;
  /** best first */
  credentials: DbCredential[];
  /** why something was guessed or could not be read */
  notes?: string[];
}

export interface DbConnectRequest {
  /** the pod (from DbTarget) */
  ref: ObjRef;
  engine: DbEngine;
  container: string;
  port: number;
  user: string;
  /** typed by the human; when absent Rust reads the password of the user's credential again */
  password?: string;
  database?: string;
}

/** An open connection. */
export interface DbSession {
  id: string;
  engine: DbEngine;
  user: string;
  /** the database the connection is in (Postgres); MySQL: the default schema, if any */
  database: string;
  serverVersion: string;
  /** Postgres: the databases to switch to; MySQL: the schemas */
  databases: string[];
}

export interface DbTableEntry {
  name: string;
  /** table, view, matview, partitioned, foreign */
  kind: string;
  /** the server's estimate */
  rows?: number;
}

export interface DbSchemaEntry {
  name: string;
  tables: DbTableEntry[];
}

/** The tables of the open database (Postgres: by schema; MySQL: by database). */
export interface DbSchema {
  schemas: DbSchemaEntry[];
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  primaryKey: boolean;
}

export interface DbIndex {
  name: string;
  definition: string;
}

export interface DbTableInfo {
  columns: DbColumn[];
  indexes: DbIndex[];
}

export interface DbTableRequest {
  session: string;
  schema: string;
  table: string;
}

export interface DbRowsRequest {
  session: string;
  schema: string;
  table: string;
  offset: number;
  /** at most 1000 */
  limit: number;
  orderBy?: string;
  desc: boolean;
}

export interface DbQueryRequest {
  session: string;
  /** one statement */
  sql: string;
  /** run it read-write and commit; refused in a read-only context */
  write: boolean;
  /** a write in a protected context: the database name, typed by the human */
  confirmText?: string;
  /** rows to return, at most 5000 (default 500) */
  limit?: number;
}

export interface DbResultColumn {
  name: string;
  type?: string;
}

/** Rows as text (`null` = SQL NULL); long values are cut. */
export interface DbResult {
  columns: DbResultColumn[];
  rows: (string | null)[][];
  /** more rows than were returned */
  truncated: boolean;
  /** rows a write changed */
  affected?: number;
  /** SELECT 3, UPDATE 1 */
  command?: string;
  elapsedMs: number;
}

export interface DbBackend {
  /** What database runs behind an object. Rejects with reason "NoDatabase" when none is found. */
  dbDetect(req: DbDetectRequest): Promise<DbTarget>;
  /** Opens a connection. Reasons: "DbAuth" (wrong user or password), "DbConnect", "DbNoDatabase". */
  dbConnect(req: DbConnectRequest): Promise<DbSession>;
  /** Switches the database (Postgres reconnects; MySQL changes the default schema). */
  dbUse(session: string, database: string): Promise<DbSession>;
  dbClose(session: string): Promise<void>;
  dbSchema(session: string): Promise<DbSchema>;
  dbTable(req: DbTableRequest): Promise<DbTableInfo>;
  /** A page of a table (read-only). */
  dbRows(req: DbRowsRequest): Promise<DbResult>;
  /** One statement. Reasons: "DbReadOnly" (a writing statement without `write`), "ReadOnly", "ConfirmText", "Database". */
  dbQuery(req: DbQueryRequest): Promise<DbResult>;
}
