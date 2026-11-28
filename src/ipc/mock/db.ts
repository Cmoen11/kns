// Mock of DbBackend (contract/db.ts): pods whose name says postgres run PostgreSQL 17 with a
// small shop (public.customers, public.orders, public.order_items, audit.events); names with
// mysql/mariadb run MariaDB with the same tables in `shop`. Any other pod has no database. The
// `staging` context's postgres asks for a password (`app` / `secret`).
import type { DbBackend, DbEngine, DbResult, DbSchema, DbTableInfo } from "../types";
import { delay, fail, mockContextFlags, mockId } from "./shared";

type Table = { columns: { name: string; type: string; pk?: boolean; nullable?: boolean; default?: string }[]; rows: (string | null)[][]; kind?: string };

const day = (i: number) => new Date(Date.UTC(2026, 10, 1) + i * 3_600_000 * 7).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");
const NAMES = ["Ada Lovelace", "Grace Hopper", "Linus Torvalds", "Margaret Hamilton", "Ken Thompson", "Barbara Liskov", "Edsger Dijkstra", "Frances Allen"];

function makeTables(): Record<string, Record<string, Table>> {
  const customers: Table = {
    columns: [{ name: "id", type: "bigint", pk: true, default: "nextval('customers_id_seq'::regclass)" }, { name: "name", type: "text" }, { name: "email", type: "text" }, { name: "created_at", type: "timestamp with time zone", default: "now()" }],
    rows: Array.from({ length: 42 }, (_, i) => [String(i + 1), NAMES[i % NAMES.length], `user${i + 1}@example.com`, day(i)]),
  };
  const orders: Table = {
    columns: [{ name: "id", type: "bigint", pk: true }, { name: "customer_id", type: "bigint" }, { name: "status", type: "text" }, { name: "total", type: "numeric(10,2)" }, { name: "note", type: "text", nullable: true }, { name: "meta", type: "jsonb", nullable: true }],
    rows: Array.from({ length: 1234 }, (_, i) => [
      String(i + 1), String((i % 42) + 1), ["paid", "shipped", "pending", "refunded"][i % 4], ((i * 37) % 900 + 9.5).toFixed(2), i % 5 === 0 ? null : `order ${i + 1}`,
      i % 7 === 0 ? JSON.stringify({ gift: true, wrap: "red", lines: [{ sku: "A-1", qty: 2 }] }) : null,
    ]),
  };
  const items: Table = {
    columns: [{ name: "order_id", type: "bigint", pk: true }, { name: "sku", type: "text", pk: true }, { name: "qty", type: "integer" }],
    rows: Array.from({ length: 300 }, (_, i) => [String((i % 120) + 1), `SKU-${(i * 13) % 50}`, String((i % 4) + 1)]),
  };
  const open: Table = { kind: "view", columns: orders.columns, rows: orders.rows.filter((r) => r[2] === "pending").slice(0, 50) };
  const events: Table = {
    columns: [{ name: "id", type: "bigint", pk: true }, { name: "at", type: "timestamp with time zone" }, { name: "payload", type: "jsonb" }],
    rows: Array.from({ length: 25 }, (_, i) => [String(i + 1), day(i), JSON.stringify({ type: "order.updated", id: i + 1 })]),
  };
  return { public: { customers, order_items: items, orders, open_orders: open }, audit: { events } };
}

interface MockSession {
  engine: DbEngine;
  database: string;
  context: string;
  tables: Record<string, Record<string, Table>>;
}
const sessions = new Map<string, MockSession>();

const engineOf = (name: string): DbEngine | null => (/mysql|maria/i.test(name) ? "mysql" : /postgres|pg|cnpg/i.test(name) ? "postgres" : null);
const schemaKey = (s: MockSession, schema: string) => (s.engine === "mysql" && schema === "shop" ? "public" : schema);
const get = (id: string) => sessions.get(id);

function table(s: MockSession, schema: string, name: string): Table | undefined {
  return s.tables[schemaKey(s, schema)]?.[name];
}

const isRead = (sql: string) => /^\s*(\(|--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\s*(select|with|values|table|show|explain|describe|desc)\b/i.test(sql);

export const dbMock: DbBackend = {
  dbDetect: (req) => {
    const engine = engineOf(req.ref.name);
    if (!engine) return fail("NoDatabase", `no Postgres or MySQL/MariaDB server found in pod ${req.ref.name}: no container has a database image, the engine's env or port 5432 / 3306`, 404);
    const pod = req.ref.gvr.resource === "pods" ? req.ref.name : `${req.ref.name}-0`;
    return delay(
      engine === "postgres"
        ? {
            engine, namespace: req.ref.namespace ?? "default", pod, container: "postgres", image: "postgres:17.2", port: 5432,
            credentials: req.ref.context === "staging"
              ? [{ user: "app", database: "shop", from: "env POSTGRES_PASSWORD (secret/postgres-wrong:password)" }]
              : [{ user: "app", database: "shop", from: "env POSTGRES_PASSWORD (secret/postgres:PASSWORD)" }, { user: "postgres", from: "env POSTGRESQL_POSTGRES_PASSWORD (secret/postgres:admin)" }],
          }
        : { engine, namespace: req.ref.namespace ?? "default", pod, container: "mariadb", image: "mariadb:11.4", port: 3306, credentials: [{ user: "app", database: "shop", from: "env MARIADB_PASSWORD (secret/mariadb:password)" }, { user: "root", database: "shop", from: "env MARIADB_ROOT_PASSWORD (secret/mariadb:root)" }] },
      250,
    );
  },
  dbConnect: (req) => {
    if (req.ref.context === "staging" && req.password !== "secret") return fail("DbAuth", `password authentication failed for user "${req.user}"`);
    const id = mockId("db-");
    const database = req.database ?? (req.engine === "postgres" ? "postgres" : "");
    sessions.set(id, { engine: req.engine, database, context: req.ref.context, tables: makeTables() });
    return delay(
      { id, engine: req.engine, user: req.user, database, serverVersion: req.engine === "postgres" ? "17.2 (Debian 17.2-1.pgdg120+1)" : "11.4.4-MariaDB-ubu2404", databases: req.engine === "postgres" ? ["postgres", "shop"] : ["information_schema", "shop"] },
      300,
    );
  },
  dbUse: (id, database) => {
    const s = get(id);
    if (!s) return fail("DbClosed", "the database connection is closed", 404);
    s.database = database;
    if (database === "postgres") s.tables = {};
    else s.tables = makeTables();
    return delay({ id, engine: s.engine, user: "app", database, serverVersion: s.engine === "postgres" ? "17.2" : "11.4.4-MariaDB", databases: s.engine === "postgres" ? ["postgres", "shop"] : ["information_schema", "shop"] });
  },
  dbClose: (id) => {
    sessions.delete(id);
    return delay(undefined);
  },
  dbSchema: (id) => {
    const s = get(id);
    if (!s) return fail("DbClosed", "the database connection is closed", 404);
    const out: DbSchema = {
      schemas: Object.entries(s.tables).map(([name, ts]) => ({
        name: s.engine === "mysql" && name === "public" ? "shop" : name,
        tables: Object.entries(ts).map(([t, v]) => ({ name: t, kind: v.kind ?? "table", rows: v.kind ? undefined : v.rows.length })),
      })),
    };
    return delay(out, 120);
  },
  dbTable: (req) => {
    const s = get(req.session);
    const t = s && table(s, req.schema, req.table);
    if (!t) return fail("Database", `relation "${req.schema}.${req.table}" does not exist`);
    const info: DbTableInfo = {
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: !!c.nullable, default: c.default, primaryKey: !!c.pk })),
      indexes: t.kind ? [] : [{ name: `${req.table}_pkey`, definition: `CREATE UNIQUE INDEX ${req.table}_pkey ON ${req.schema}.${req.table} USING btree (${t.columns.filter((c) => c.pk).map((c) => c.name).join(", ")})` }],
    };
    return delay(info);
  },
  dbRows: (req) => {
    const s = get(req.session);
    const t = s && table(s, req.schema, req.table);
    if (!t) return fail("Database", `relation "${req.schema}.${req.table}" does not exist`);
    let rows = t.rows;
    const ci = req.orderBy ? t.columns.findIndex((c) => c.name === req.orderBy) : -1;
    if (ci >= 0) {
      const num = /int|numeric|serial/.test(t.columns[ci].type);
      rows = [...rows].sort((a, b) => {
        const x = a[ci], y = b[ci];
        if (x === null) return 1;
        if (y === null) return -1;
        const c = num ? Number(x) - Number(y) : x.localeCompare(y);
        return req.desc ? -c : c;
      });
    }
    const page = rows.slice(req.offset, req.offset + req.limit);
    const r: DbResult = { columns: t.columns.map((c) => ({ name: c.name, type: c.type.split(" ")[0] })), rows: page, truncated: req.offset + req.limit < rows.length, elapsedMs: 3 };
    return delay(r, 90);
  },
  dbQuery: (req) => {
    const s = get(req.session);
    if (!s) return fail("DbClosed", "the database connection is closed", 404);
    const sql = req.sql.trim().replace(/;\s*$/, "");
    if (!req.write && !isRead(sql)) {
      const kw = (sql.match(/[a-z]+/i)?.[0] ?? "").toUpperCase();
      return fail("DbReadOnly", `${kw} can change data: turn writes on to run it (the view is read-only)`, 403);
    }
    if (req.write) {
      const f = mockContextFlags(s.context);
      if (f.readOnly) return fail("ReadOnly", `${s.context} is read-only: writes to the database are off`, 403);
      if (f.protected && req.confirmText !== s.database) return fail("ConfirmText", `${s.context} is a protected context: type ${s.database} to write`, 409);
    }
    const limit = Math.min(req.limit ?? 500, 5000);
    const from = sql.match(/\bfrom\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
    if (/^\s*select\s+1\b/i.test(sql)) return delay({ columns: [{ name: "?column?", type: "int4" }], rows: [["1"]], truncated: false, command: "SELECT 1", elapsedMs: 1 });
    if (/^\s*(update|delete|insert)/i.test(sql)) {
      const kw = sql.match(/[a-z]+/i)![0].toUpperCase();
      return delay({ columns: [], rows: [], truncated: false, affected: 1, command: `${kw} 1`, elapsedMs: 4 });
    }
    if (from) {
      const t = table(s, from[1] ?? (s.engine === "mysql" ? "shop" : "public"), from[2]);
      if (!t) return fail("Database", `relation "${from[2]}" does not exist at character ${(from.index ?? 0) + 6}`);
      const lim = Number(sql.match(/\blimit\s+(\d+)/i)?.[1] ?? Infinity);
      const all = t.rows.slice(0, Math.min(lim, t.rows.length));
      const rows = all.slice(0, limit);
      return delay({ columns: t.columns.map((c) => ({ name: c.name, type: c.type.split(" ")[0] })), rows, truncated: all.length > limit, command: `SELECT ${rows.length}${all.length > limit ? "+" : ""}`, elapsedMs: 7 }, 120);
    }
    return fail("Database", `syntax error at or near "${sql.split(/\s+/)[0] ?? ""}"`);
  },
};
