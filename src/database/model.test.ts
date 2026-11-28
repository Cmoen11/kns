import { describe, expect, it } from "vitest";
import { approxRows, canOpen, credentialLabel, filterTree, looksLikeDatabase, resultSummary, selectSql, toTsv } from "./model";

const ref = (resource: string, name: string, group = resource === "pods" || resource === "services" ? "" : "apps") => ({ gvr: { group, version: "v1", resource }, namespace: "ns", name });

describe("database model", () => {
  it("offers the menu entry for rows named like a database", () => {
    for (const n of ["postgres-0", "payments-pg-1", "orders-db-7f9c-abcde", "mysql", "mariadb-galera-0", "timescale-0", "app-postgresql-0"]) {
      expect(looksLikeDatabase(ref("pods", n)), n).toBe(true);
    }
    for (const n of ["web-7f9c", "postgres-exporter-1", "pgbouncer-0", "pgadmin", "dbt-runner", "debug-pod", "mysql-backup-123"]) {
      expect(looksLikeDatabase(ref("pods", n)), n).toBe(false);
    }
    expect(looksLikeDatabase(ref("statefulsets", "postgres"))).toBe(true);
    expect(looksLikeDatabase(ref("configmaps", "postgres", ""))).toBe(false);
    expect(looksLikeDatabase({ gvr: { group: "postgresql.cnpg.io", version: "v1", resource: "clusters" }, namespace: "ns", name: "main" })).toBe(true);
    expect(canOpen(ref("nodes", "x", ""))).toBe(false);
  });

  it("filters the tree", () => {
    const tree = [
      { name: "public", tables: [{ name: "orders", kind: "table" }, { name: "customers", kind: "table" }] },
      { name: "audit", tables: [{ name: "events", kind: "table" }] },
    ];
    expect(filterTree(tree, "")).toEqual(tree);
    expect(filterTree(tree, "ORD")).toEqual([{ name: "public", tables: [{ name: "orders", kind: "table" }] }]);
    expect(filterTree(tree, "aud")).toEqual([tree[1]]);
    expect(filterTree(tree, "zzz")).toEqual([]);
  });

  it("formats", () => {
    expect(approxRows(undefined)).toBe("");
    expect(approxRows(12)).toBe("~12");
    expect(approxRows(1200)).toBe("~1.2k");
    expect(approxRows(45_000)).toBe("~45k");
    expect(approxRows(3_000_000)).toBe("~3M");
    expect(resultSummary({ columns: [{ name: "a" }], rows: [["1"]], truncated: false, elapsedMs: 3 })).toBe("1 row · 3 ms");
    expect(resultSummary({ columns: [{ name: "a" }], rows: [["1"], ["2"]], truncated: true, elapsedMs: 3 })).toBe("2+ rows · 3 ms");
    expect(resultSummary({ columns: [], rows: [], truncated: false, affected: 2, command: "UPDATE 2", elapsedMs: 1 })).toBe("UPDATE 2 · 2 rows changed · 1 ms");
    expect(credentialLabel({ user: "app", database: "shop", from: "secret/pg" })).toBe("app → shop · secret/pg");
    expect(credentialLabel({ user: "postgres" })).toBe("postgres · no password");
    expect(selectSql("postgres", "public", "orders")).toBe("SELECT * FROM public.orders LIMIT 100;");
    expect(selectSql("postgres", "public", "Order Items")).toBe('SELECT * FROM public."Order Items" LIMIT 100;');
    expect(selectSql("mysql", "shop", "a`b")).toBe("SELECT * FROM shop.`a``b` LIMIT 100;");
    expect(toTsv({ columns: [{ name: "a" }, { name: "b" }], rows: [["x\ty", null]], truncated: false, elapsedMs: 0 })).toBe("a\tb\nx y\t");
  });
});
