// Tauri mapping of DbBackend (contract/db.ts, database.rs).
import type { DbBackend } from "../types";
import { call } from "./call";

export const dbTauri: DbBackend = {
  dbDetect: (req) => call("db_detect", { req }),
  dbConnect: (req) => call("db_connect", { req }),
  dbUse: (session, database) => call("db_use", { session, database }),
  dbClose: (session) => call("db_close", { session }),
  dbSchema: (session) => call("db_schema", { session }),
  dbTable: (req) => call("db_table", { req }),
  dbRows: (req) => call("db_rows", { req }),
  dbQuery: (req) => call("db_query", { req }),
};
