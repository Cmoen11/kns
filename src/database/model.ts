// Pure helpers of the database view (src/database): which rows look like a database, the tree's
// filter, and how results are shown.
import type { DbCredential, DbResult, DbSchemaEntry } from "../ipc/types";
import type { ObjectRef } from "../types";

/** Kinds the database view can open: a pod, something that has pods, or a CloudNativePG cluster. */
export function canOpen(ref: ObjectRef): boolean {
  const { group, resource } = ref.gvr;
  if (group === "postgresql.cnpg.io" && resource === "clusters") return true;
  if (group === "" && (resource === "pods" || resource === "services")) return true;
  return group === "apps" && (resource === "statefulsets" || resource === "deployments" || resource === "replicasets");
}

const DB_NAME = /(postgres|postgis|psql|pgsql|timescale|cnpg|mysql|maria|percona|galera|(^|[-_.])(pg|db|database|rdbms)($|[-_.\d]))/i;
/** Names that only sit next to a database (exporters, poolers, admin UIs, backups). */
const TOOL_NAME = /(exporter|bouncer|pgadmin|phpmyadmin|adminer|backup|pooler|operator|proxy|metrics|migrat)/i;

/**
 * Whether the row menu offers "open database" for a row: its name says database. Rust decides from
 * the pod spec; `:db` runs on any row of a kind that can have one.
 */
export function looksLikeDatabase(ref: ObjectRef): boolean {
  if (!canOpen(ref)) return false;
  if (ref.gvr.group === "postgresql.cnpg.io") return true;
  return DB_NAME.test(ref.name) && !TOOL_NAME.test(ref.name);
}

/** The schemas and tables whose names contain the filter (case-insensitive); a matching schema keeps every table. */
export function filterTree(schemas: readonly DbSchemaEntry[], filter: string): DbSchemaEntry[] {
  const f = filter.trim().toLowerCase();
  if (!f) return [...schemas];
  const out: DbSchemaEntry[] = [];
  for (const s of schemas) {
    if (s.name.toLowerCase().includes(f)) out.push(s);
    else {
      const tables = s.tables.filter((t) => t.name.toLowerCase().includes(f));
      if (tables.length) out.push({ ...s, tables });
    }
  }
  return out;
}

/** 1200 → 1.2k: the server's estimate of a table's rows. */
export function approxRows(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1000) return `~${n}`;
  if (n < 1_000_000) return `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `~${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** One line under a result: rows, the command tag, time. */
export function resultSummary(r: DbResult): string {
  const parts: string[] = [];
  if (r.columns.length) parts.push(`${r.rows.length}${r.truncated ? "+" : ""} ${r.rows.length === 1 && !r.truncated ? "row" : "rows"}`);
  else if (r.affected !== undefined) parts.push(`${r.affected} ${r.affected === 1 ? "row" : "rows"} changed`);
  if (r.command && !r.columns.length) parts.unshift(r.command);
  parts.push(`${r.elapsedMs} ms`);
  return parts.join(" · ");
}

/** A credential as the "connect as" picker shows it. */
export function credentialLabel(c: DbCredential): string {
  const db = c.database ? ` → ${c.database}` : "";
  return `${c.user}${db}${c.from ? ` · ${c.from}` : " · no password"}`;
}

/** The default SQL for a table. */
export function selectSql(engine: "postgres" | "mysql", schema: string, table: string): string {
  const q = (s: string) => (engine === "postgres" ? `"${s.replace(/"/g, '""')}"` : `\`${s.replace(/`/g, "``")}\``);
  const plain = (s: string) => /^[a-z_][a-z0-9_]*$/.test(s);
  const name = (s: string) => (plain(s) ? s : q(s));
  return `SELECT * FROM ${name(schema)}.${name(table)} LIMIT 100;`;
}

/** Copyable text of a result: tab-separated with a header, NULL as an empty field. */
export function toTsv(r: DbResult): string {
  const esc = (v: string | null) => (v ?? "").replace(/[\t\n\r]/g, " ");
  return [r.columns.map((c) => c.name).join("\t"), ...r.rows.map((row) => row.map(esc).join("\t"))].join("\n");
}
