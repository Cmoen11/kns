// The database view (`:db`, right-click → "open database", docs/tools.md#database): a Postgres or
// MySQL/MariaDB server in a pod. Rust finds the server and its credentials (database.rs), the view
// tries them in order and asks for a user and password only when none works. Left: schemas and
// tables. Right: the table's rows page by page (click a header to sort), its columns and indexes,
// and a SQL editor. Read-only unless writes are turned on for this view.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Button, EmptyState, Tabs, backend, confirm, contextFlags, engine, flash, LAYERS, objectFacts, toObjRef, usePaneContext, type ViewProps,
} from "../foundation";
import type { BackendError, DbCredential, DbResult, DbSchema, DbSession, DbTableInfo, DbTarget } from "../ipc/types";
import { setDatabaseControls } from "./actions";
import { approxRows, credentialLabel, filterTree, resultSummary, selectSql, toTsv } from "./model";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import "./database.css";

const PAGE = 100;
type Tab = "data" | "structure" | "sql";
type Phase =
  | { k: "detecting" }
  | { k: "connecting"; user: string }
  | { k: "login"; error?: string }
  | { k: "ready" }
  | { k: "failed"; message: string; reason: string };

const errOf = (e: unknown): { message: string; reason: string } => {
  const b = e as Partial<BackendError> | null;
  return { message: b?.message ?? String(e), reason: b?.reason ?? "" };
};

/** What was typed in the SQL tab, per pane, so a pane that is reopened keeps it. */
const drafts = new Map<string, string>();

function engineLabel(s: DbSession): string {
  const v = s.serverVersion.split(" ")[0] ?? "";
  if (/mariadb/i.test(s.serverVersion)) return `MariaDB ${v.replace(/-.*$/, "")}`;
  return s.engine === "postgres" ? `PostgreSQL ${v}` : `MySQL ${v.replace(/-.*$/, "")}`;
}

// ── the result grid ─────────────────────────────────────────────────────────

function ResultGrid({ result, sort, onSort, onCell, offset = 0 }: {
  result: DbResult;
  sort?: { column?: string; desc: boolean };
  onSort?: (column: string) => void;
  onCell(value: string | null, column: string): void;
  offset?: number;
}) {
  if (!result.columns.length) return null;
  return (
    <div className="db-grid-scroll">
      <table className="db-grid t-mono">
        <thead>
          <tr>
            <th className="db-rownum" />
            {result.columns.map((c, i) => (
              <th key={i} title={c.type ? `${c.name} · ${c.type}` : c.name} data-sortable={onSort ? "" : undefined} onClick={onSort ? () => onSort(c.name) : undefined}>
                <span className="db-colname">{c.name}</span>
                {sort?.column === c.name && <span className="db-sort">{sort.desc ? "▼" : "▲"}</span>}
                {c.type && <span className="db-coltype">{c.type}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r}>
              <td className="db-rownum">{offset + r + 1}</td>
              {row.map((v, i) => (
                <td key={i} data-null={v === null ? "" : undefined} onClick={() => onCell(v, result.columns[i]?.name ?? "")}>
                  {v === null ? "NULL" : v.length > 200 ? `${v.slice(0, 200)}…` : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── the view ────────────────────────────────────────────────────────────────

export default function DatabaseView({ pane, view, focused }: ViewProps<"database">) {
  const context = usePaneContext(pane);
  const refKey = `${context}/${view.ref.gvr.group}/${view.ref.gvr.resource}/${view.ref.namespace ?? ""}/${view.ref.name}`;
  const [phase, setPhase] = useState<Phase>({ k: "detecting" });
  const [target, setTarget] = useState<DbTarget | null>(null);
  const [session, setSession] = useState<DbSession | null>(null);
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column?: string; desc: boolean }>({ desc: false });
  const [data, setData] = useState<DbResult | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [info, setInfo] = useState<DbTableInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [sqlResult, setSqlResult] = useState<DbResult | null>(null);
  const [sqlError, setSqlError] = useState<{ message: string; reason: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [writes, setWrites] = useState(false);
  const [cell, setCell] = useState<{ value: string | null; column: string } | null>(null);
  const [login, setLogin] = useState({ user: "", password: "", database: "" });
  const sessionRef = useRef<DbSession | null>(null);
  const editor = useRef<SqlEditorHandle | null>(null);
  const draftKey = `${pane}/${refKey}`;

  // ── connect ──
  const open = useCallback(
    async (t: DbTarget, creds: readonly (DbCredential & { password?: string })[]) => {
      let lastAuth: string | undefined;
      for (const c of creds) {
        setPhase({ k: "connecting", user: c.user });
        try {
          const s = await backend.dbConnect({
            ref: { context: context ?? "", gvr: { group: "", version: "v1", resource: "pods" }, namespace: t.namespace, name: t.pod },
            engine: t.engine, container: t.container, port: t.port, user: c.user, password: c.password, database: c.database || undefined,
          });
          if (sessionRef.current) void backend.dbClose(sessionRef.current.id);
          sessionRef.current = s;
          setSession(s);
          setPhase({ k: "ready" });
          return;
        } catch (e) {
          const err = errOf(e);
          if (err.reason === "DbAuth") {
            lastAuth = err.message;
            continue;
          }
          setPhase({ k: "failed", ...err });
          return;
        }
      }
      setLogin((l) => ({ user: l.user || creds[0]?.user || (t.engine === "postgres" ? "postgres" : "root"), password: "", database: l.database || creds[0]?.database || "" }));
      setPhase({ k: "login", error: lastAuth ?? (creds.length ? undefined : "no credentials found: type a user and password") });
    },
    [context],
  );

  useEffect(() => {
    if (!context) return;
    let stopped = false;
    setPhase({ k: "detecting" });
    setTarget(null);
    setSession(null);
    setSchema(null);
    setSelected(null);
    backend
      .dbDetect({ ref: toObjRef(view.ref, context) })
      .then((t) => {
        if (stopped) return;
        setTarget(t);
        void open(t, t.credentials);
      })
      .catch((e) => !stopped && setPhase({ k: "failed", ...errOf(e) }));
    return () => {
      stopped = true;
    };
  }, [refKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // the connection goes with the view
  useEffect(
    () => () => {
      if (sessionRef.current) void backend.dbClose(sessionRef.current.id);
      sessionRef.current = null;
    },
    [],
  );

  // ── the tables ──
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    backend
      .dbSchema(session.id)
      .then((s) => {
        if (stopped) return;
        setSchema(s);
        // open the first table of the app's schema
        setSelected((cur) => {
          if (cur && s.schemas.some((x) => x.name === cur.schema && x.tables.some((t) => t.name === cur.table))) return cur;
          const home = s.schemas.find((x) => x.name === "public" || x.name === session.database) ?? s.schemas.find((x) => x.tables.length);
          const t = home?.tables[0];
          return home && t ? { schema: home.name, table: t.name } : null;
        });
      })
      .catch((e) => !stopped && setDataError(errOf(e).message));
    return () => {
      stopped = true;
    };
  }, [session, tick]);

  // ── the selected table: rows and structure ──
  useEffect(() => {
    if (!session || !selected) return;
    let stopped = false;
    setLoading(true);
    setDataError(null);
    backend
      .dbRows({ session: session.id, schema: selected.schema, table: selected.table, offset, limit: PAGE, orderBy: sort.column, desc: sort.desc })
      .then((r) => !stopped && setData(r))
      .catch((e) => {
        if (stopped) return;
        setData(null);
        setDataError(errOf(e).message);
      })
      .finally(() => !stopped && setLoading(false));
    return () => {
      stopped = true;
    };
  }, [session, selected, offset, sort, tick]);

  useEffect(() => {
    if (!session || !selected) return setInfo(null);
    let stopped = false;
    backend
      .dbTable({ session: session.id, schema: selected.schema, table: selected.table })
      .then((i) => !stopped && setInfo(i))
      .catch(() => !stopped && setInfo(null));
    return () => {
      stopped = true;
    };
  }, [session, selected, tick]);

  const pick = (schemaName: string, table: string) => {
    setSelected({ schema: schemaName, table });
    setOffset(0);
    setSort({ desc: false });
    setCell(null);
    if (tab === "sql" && session && !editor.current?.text().trim()) editor.current?.set(selectSql(session.engine, schemaName, table));
  };

  const switchDb = async (db: string) => {
    if (!session || db === session.database) return;
    try {
      const s = await backend.dbUse(session.id, db);
      setSession(s);
      sessionRef.current = s;
      setSelected(null);
    } catch (e) {
      flash(errOf(e).message, "warn");
    }
  };

  // ── SQL ──
  const runSql = useCallback(async () => {
    if (!session) return;
    if (tab !== "sql") setTab("sql");
    const stmt = editor.current?.statement() ?? "";
    if (!stmt) return flash("no statement to run", "warn");
    setRunning(true);
    setSqlError(null);
    try {
      const prot = context ? contextFlags(context).protected : false;
      const r = await backend.dbQuery({ session: session.id, sql: stmt, write: writes, confirmText: writes && prot ? session.database : undefined });
      setSqlResult(r);
      // a write may have changed what the tree and the data tab show
      if (writes && !r.columns.length) setTick((t) => t + 1);
    } catch (e) {
      setSqlResult(null);
      setSqlError(errOf(e));
    } finally {
      setRunning(false);
    }
  }, [session, tab, writes, context]);

  const toggleWrites = useCallback(async () => {
    if (writes) return setWrites(false);
    if (!context || !session || !target) return;
    const flags = contextFlags(context);
    if (flags.readOnly) return flash(`${context} is read-only: writes to the database stay off`, "warn");
    const ok = await confirm({
      tier: flags.protected ? 2 : 1,
      title: "Allow writes to the database",
      body: `Statements in the SQL tab of this view run read-write and are committed, as ${session.user} in ${session.database || "the server"}. Turn it off again with the same button.`,
      facts: objectFacts({ kind: "Pod", name: target.pod, namespace: target.namespace, context, protected: flags.protected }),
      typeToConfirm: flags.protected ? session.database : undefined,
      confirmLabel: "Allow writes",
    });
    if (ok) setWrites(true);
  }, [writes, context, session, target]);

  // the keys (db.run, db.refresh, db.writes) reach the view through these
  const live = useRef({ runSql, toggleWrites, session, running });
  live.current = { runSql, toggleWrites, session, running };
  useEffect(
    () =>
      setDatabaseControls(pane, {
        run: () => void live.current.runSql(),
        refresh: () => setTick((t) => t + 1),
        toggleWrites: () => void live.current.toggleWrites(),
        canRun: () => (!live.current.session ? "not connected" : live.current.running ? "running" : true),
      }),
    [pane],
  );
  useEffect(() => engine.invalidate(), [session, running, writes]);

  const submitLogin = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    void open(target, [{ user: login.user.trim(), password: login.password, database: login.database.trim() || undefined }]);
  };

  const tree = useMemo(() => filterTree(schema?.schemas ?? [], filter), [schema, filter]);
  const filterLayer = useRef<(() => void) | null>(null);

  // ── render ──
  if (phase.k === "detecting" || phase.k === "connecting") {
    return (
      <div className="db-view">
        <EmptyState compact>{phase.k === "detecting" ? "Looking for a database in the pod…" : `Connecting as ${phase.user}…`}</EmptyState>
      </div>
    );
  }
  if (phase.k === "failed") {
    return (
      <div className="db-view">
        <EmptyState
          title={phase.reason === "NoDatabase" ? "No database here" : "Could not open the database"}
          actions={
            target ? (
              <>
                <Button variant="primary" onClick={() => void open(target, target.credentials)}>Try again</Button>
                <Button onClick={() => setPhase({ k: "login" })}>Log in as…</Button>
              </>
            ) : undefined
          }
        >
          {phase.message}
        </EmptyState>
      </div>
    );
  }
  if (phase.k === "login" && target) {
    return (
      <div className="db-view">
        <form className="db-login" onSubmit={submitLogin}>
          <h2 className="t-title">Log in to {target.engine === "postgres" ? "PostgreSQL" : "MySQL"}</h2>
          <p className="t-body db-muted">
            {target.namespace}/{target.pod} · {target.container} · port {target.port}
          </p>
          {phase.error && <p className="t-body db-error">{phase.error}</p>}
          <label className="db-field">
            <span className="t-label">User</span>
            <input className="t-input" value={login.user} autoFocus spellCheck={false} autoComplete="off" onChange={(e) => setLogin({ ...login, user: e.target.value })} />
          </label>
          <label className="db-field">
            <span className="t-label">Password</span>
            <input className="t-input" type="password" value={login.password} autoComplete="off" onChange={(e) => setLogin({ ...login, password: e.target.value })} />
          </label>
          <label className="db-field">
            <span className="t-label">Database</span>
            <input className="t-input" value={login.database} spellCheck={false} autoComplete="off" placeholder="default" onChange={(e) => setLogin({ ...login, database: e.target.value })} />
          </label>
          {target.credentials.length > 0 && (
            <p className="t-ui db-muted">Tried: {target.credentials.map(credentialLabel).join("; ")}</p>
          )}
          <div className="db-login-actions">
            <Button variant="primary" type="submit" disabled={!login.user.trim()}>Connect</Button>
          </div>
        </form>
      </div>
    );
  }
  if (!session || !target) return null;

  const sortBy = (column: string) => {
    setOffset(0);
    setSort((s) => (s.column !== column ? { column, desc: false } : s.desc ? { desc: false } : { column, desc: true }));
  };

  return (
    <div className="db-view" data-pane-focused={focused || undefined}>
      <div className="db-bar t-ui">
        <span className="db-engine">{engineLabel(session)}</span>
        <span className="db-muted db-where" title={`${target.image}`}>
          {target.namespace}/{target.pod} · {target.container}
        </span>
        {target.credentials.length > 1 ? (
          <select
            className="db-select"
            title="Connect as"
            value={session.user}
            onChange={(e) => {
              const c = target.credentials.find((x) => x.user === e.target.value);
              if (c) void open(target, [c]);
            }}
          >
            {target.credentials.map((c) => (
              <option key={`${c.user}/${c.from ?? ""}`} value={c.user}>{credentialLabel(c)}</option>
            ))}
          </select>
        ) : (
          <span className="db-muted" title={target.credentials[0]?.from ?? "no password"}>as {session.user}</span>
        )}
        {session.engine === "postgres" && session.databases.length > 0 && (
          <select className="db-select" title="Database" value={session.database} onChange={(e) => void switchDb(e.target.value)}>
            {!session.databases.includes(session.database) && <option value={session.database}>{session.database}</option>}
            {session.databases.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
        <span className="db-spacer" />
        <button type="button" className="db-mode" data-on={writes || undefined} onClick={() => void toggleWrites()} title="db.writes: turn writes on or off for this view">
          {writes ? "writes on" : "read-only"}
        </button>
      </div>
      {target.notes && target.notes.length > 0 && (
        <div className="db-notes t-ui">{target.notes.join(" · ")}</div>
      )}
      <div className="db-body">
        <aside className="db-side">
          <input
            className="db-filter t-input"
            placeholder="filter tables"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onFocus={() => {
              filterLayer.current?.();
              filterLayer.current = engine.pushScope(LAYERS.filterInput);
            }}
            onBlur={() => {
              filterLayer.current?.();
              filterLayer.current = null;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <div className="db-tree" role="tree" aria-label="Tables">
            {!schema && <div className="db-muted db-pad t-ui">loading…</div>}
            {schema && tree.length === 0 && <div className="db-muted db-pad t-ui">{filter ? "no table matches" : "no tables"}</div>}
            {tree.map((s) => {
              const closed = collapsed.has(s.name) && !filter;
              return (
                <div key={s.name} role="group">
                  <button
                    type="button"
                    className="db-schema t-ui"
                    aria-expanded={!closed}
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(s.name)) n.delete(s.name);
                        else n.add(s.name);
                        return n;
                      })
                    }
                  >
                    <span className="db-caret">{closed ? "›" : "⌄"}</span>
                    {s.name}
                    <span className="db-count">{s.tables.length}</span>
                  </button>
                  {!closed &&
                    s.tables.map((t) => (
                      <button
                        type="button"
                        role="treeitem"
                        key={t.name}
                        className="db-table t-ui"
                        aria-selected={selected?.schema === s.name && selected.table === t.name}
                        onClick={() => pick(s.name, t.name)}
                        onDoubleClick={() => {
                          editor.current?.set(selectSql(session.engine, s.name, t.name));
                          setTab("sql");
                        }}
                        title={`${s.name}.${t.name} (${t.kind})`}
                      >
                        <span className="db-tname">{t.name}</span>
                        <span className="db-count">{t.kind === "table" || t.kind === "partitioned" ? approxRows(t.rows) : t.kind}</span>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </aside>
        <section className="db-main">
          <div className="db-tabs">
            <Tabs
              label="Database"
              active={tab}
              onSelect={(id) => setTab(id as Tab)}
              items={[
                { id: "data", label: selected ? `${selected.table}` : "data" },
                { id: "structure", label: "structure" },
                { id: "sql", label: "SQL" },
              ]}
            />
          </div>
          {tab === "data" && (
            <div className="db-pane">
              {!selected && <EmptyState compact>Pick a table on the left.</EmptyState>}
              {selected && dataError && <div className="db-error db-pad t-body">{dataError}</div>}
              {selected && data && <ResultGrid result={data} sort={sort} onSort={sortBy} offset={offset} onCell={(value, column) => setCell({ value, column })} />}
              {selected && (
                <div className="db-pager t-ui">
                  <span className="db-muted">
                    {selected.schema}.{selected.table}
                    {data ? ` · rows ${data.rows.length ? offset + 1 : 0}–${offset + data.rows.length}${data.truncated ? "+" : ""}` : ""}
                    {loading ? " · loading…" : ""}
                  </span>
                  <span className="db-spacer" />
                  <Button variant="tertiary" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>‹ prev</Button>
                  <Button variant="tertiary" disabled={!data?.truncated || loading} onClick={() => setOffset((o) => o + PAGE)}>next ›</Button>
                  <Button
                    variant="tertiary"
                    disabled={!data}
                    onClick={() => {
                      if (!data) return;
                      void navigator.clipboard?.writeText(toTsv(data)).then(() => flash(`copied ${data.rows.length} rows`));
                    }}
                  >
                    copy
                  </Button>
                </div>
              )}
            </div>
          )}
          {tab === "structure" && (
            <div className="db-pane db-structure">
              {!selected && <EmptyState compact>Pick a table on the left.</EmptyState>}
              {selected && !info && <div className="db-muted db-pad t-ui">loading…</div>}
              {selected && info && (
                <div className="db-grid-scroll">
                  <table className="db-grid t-mono">
                    <thead>
                      <tr>
                        <th>column</th>
                        <th>type</th>
                        <th>null</th>
                        <th>default</th>
                        <th>key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {info.columns.map((c) => (
                        <tr key={c.name}>
                          <td className="db-strong">{c.name}</td>
                          <td>{c.type}</td>
                          <td>{c.nullable ? "yes" : "no"}</td>
                          <td data-null={c.default === undefined ? "" : undefined}>{c.default ?? ""}</td>
                          <td>{c.primaryKey ? "PK" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {info.indexes.length > 0 && (
                    <>
                      <div className="db-section t-label">indexes</div>
                      {info.indexes.map((i) => (
                        <div key={i.name} className="db-index t-mono">
                          <span className="db-strong">{i.name}</span> <span className="db-muted">{i.definition}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="db-pane db-sql" hidden={tab !== "sql"}>
            <SqlEditor
              engine={session.engine}
              schemas={schema?.schemas ?? []}
              initial={drafts.get(draftKey) ?? (selected ? selectSql(session.engine, selected.schema, selected.table) : "")}
              onChange={(t) => drafts.set(draftKey, t)}
              handle={editor}
            />
            <div className="db-runbar t-ui">
              <Button variant="primary" action="db.run" disabled={running} onClick={() => void runSql()}>{running ? "running…" : "Run"}</Button>
              <span className="db-muted">{writes ? "read-write, committed" : "read-only transaction, rolled back"}</span>
              <span className="db-spacer" />
              {sqlResult && <span className="db-muted">{resultSummary(sqlResult)}</span>}
            </div>
            {sqlError && (
              <div className="db-error db-pad t-body">
                {sqlError.message}
                {sqlError.reason === "DbReadOnly" && (
                  <>
                    {" "}
                    <Button variant="tertiary" onClick={() => void toggleWrites()}>turn writes on</Button>
                  </>
                )}
              </div>
            )}
            {sqlResult && <ResultGrid result={sqlResult} onCell={(value, column) => setCell({ value, column })} />}
            {sqlResult && !sqlResult.columns.length && !sqlError && <div className="db-muted db-pad t-body">{sqlResult.command ?? "done"}</div>}
          </div>
          {cell && (
            <div className="db-cell">
              <div className="db-cell-head t-ui">
                <span className="db-strong">{cell.column}</span>
                <span className="db-spacer" />
                <Button variant="tertiary" disabled={cell.value === null} onClick={() => cell.value !== null && void navigator.clipboard?.writeText(cell.value).then(() => flash("copied"))}>copy</Button>
                <Button variant="tertiary" onClick={() => setCell(null)}>close</Button>
              </div>
              <pre className="db-cell-value t-mono" data-null={cell.value === null ? "" : undefined}>{cell.value === null ? "NULL" : prettyValue(cell.value)}</pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** JSON values pretty-printed; anything else as is. */
function prettyValue(v: string): string {
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v;
}
