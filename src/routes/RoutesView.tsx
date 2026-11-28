// The routes view (`:routes`, docs/tools.md#routes): every HTTP way into the namespace (or the
// context) drawn as a rail per route, left to right: the request (host and path), the Ingress or
// HTTPRoute that takes it, the Service and port it goes to, and the pods behind it. Hosts are
// sections; a rule that splits traffic branches into one rail per share. Wires carry the state: a
// broken link is drawn dashed with a cross where the request stops. The panel at the bottom tells
// the cursor row as the journey of one request.
//
// Keys arrive as registry actions through the pane's controller (./actions): j/k rows, h/l steps,
// Enter describes the object of the step, `c` copies the URL, `!` problems only, `a` this
// namespace / all, `/` filter. Every name is cluster text, rendered as text only.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { fallbackNamespaces } from "../catalog/namespaces";
import { backend, engine, focusPane, focusedPane, LAYERS, openInContext, PaneSlot, useScopeLayer, usePaneContext, type ViewProps } from "../foundation";
import type { RouteMap } from "../ipc/types";
import { docView } from "../table/drill";
import { BarInput, CLIP_DELAY, EmptyState, FilterChip, Glyph, tip, toast, toasts } from "../ui";
import { cleanUntrusted as t } from "../ui/untrusted";
import { useSettings } from "../store/settings";
import { setRoutesController } from "./actions";
import {
  entryUrl, flatRows, groupHosts, journey, pathLabel, rowHealth, splitWorkload, stepOpenWhy, stepRef, STEPS, summary, type Health, type RouteRow, type Step,
} from "./model";
import "./routes.css";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; map: RouteMap; at: number };

const errorText = (e: unknown) => (e as { message?: string } | null)?.message ?? String(e);
const MAX_DOTS = 8;

function FilterBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // the input owns its keys through this layer: Enter applies, Esc cancels (filter.apply / filter.cancel)
  useScopeLayer(LAYERS.filterInput);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <BarInput ref={ref} label="FILTER" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter" />;
}

/** The wire between two steps. `branch` draws the fork of a split rule. */
function Wire({ health, branch, lit }: { health: Health; branch?: RouteRow["branch"]; lit?: boolean }) {
  return (
    <span className="rt-wire" data-h={health} data-branch={branch && branch !== "only" ? branch : undefined} data-lit={lit || undefined} aria-hidden="true">
      <span className="rt-line" />
      {health === "error" && <span className="rt-break">✕</span>}
    </span>
  );
}

function Dots({ ready, total }: { ready: number; total: number }) {
  if (total === 0 || total > MAX_DOTS) return null;
  return (
    <span className="rt-dots" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <i key={i} data-ready={i < ready || undefined} />
      ))}
    </span>
  );
}

function Row({ row, index, focus, step, allNs }: { row: RouteRow; index: number; focus: boolean; step: Step; allNs: boolean }) {
  const e = row.entry;
  const b = row.backend;
  const h = rowHealth(row);
  const cur = (s: Step) => (focus && step === s) || undefined;
  const nsOf = (ns: string) => (allNs ? <span className="muted">{t(ns)}/</span> : null);
  const conds = e.conditions ?? [];
  const filters = e.filters ?? [];
  const redirect = !b ? filters.find((f) => f.startsWith("redirect")) ?? filters[0] ?? "no backend" : undefined;
  const w = splitWorkload(b?.workload);
  return (
    <div className="rt-row row t-cell" data-index={index} data-focus={focus || undefined} data-sev={h.worst} data-cont={!row.first || undefined} role="row" aria-selected={focus}>
      {/* request: path and conditions */}
      <span className="rt-cell rt-req" data-step={0} data-cur={cur(0)} {...(row.first ? tip(`${entryUrl(e)}${conds.length ? `\n${conds.join("\n")}` : ""}`, { plain: true, delay: CLIP_DELAY }) : {})}>
        {row.first && (
          <>
            <span className="rt-path" dir="ltr">{t(pathLabel(e))}</span>
            {conds.map((c) => (
              <span key={c} className="rt-tag">{t(c)}</span>
            ))}
          </>
        )}
      </span>
      <Wire health={row.first ? "ok" : "none"} lit={focus && row.first} />
      {/* route: the Ingress or HTTPRoute */}
      <span className="rt-cell rt-route" data-step={1} data-cur={cur(1)} {...(row.first ? tip(`${e.source.kind} ${e.source.namespace}/${e.source.name}${e.source.via ? `\nvia ${e.source.via}` : ""}${filters.length ? `\n${filters.join("\n")}` : ""}`, { plain: true, delay: CLIP_DELAY }) : {})}>
        {row.first && (
          <>
            <span className="rt-kind" data-kind={e.source.kind}>{e.source.kind === "HTTPRoute" ? "route" : "ing"}</span>
            <span className="rt-name">{nsOf(e.source.namespace)}{t(e.source.name)}</span>
            {b && filters.length > 0 && <span className="rt-tag">{t(filters[0])}{filters.length > 1 ? ` +${filters.length - 1}` : ""}</span>}
          </>
        )}
      </span>
      {b ? (
        <>
          <Wire health={h.toService} branch={row.branch} lit={focus} />
          {/* service: share, name, port → targetPort */}
          <span className="rt-cell rt-svc" data-step={2} data-cur={cur(2)} data-h={h.service} {...(h.service === "error" && b.problem ? tip(b.problem, { plain: true }) : {})}>
            {b.weight !== undefined && (
              <span className="rt-weight" {...tip(`${b.weight}% of the requests`, { plain: true })}>
                <span className="rt-weight-bar" style={{ inlineSize: `max(1px, calc(1.5ch * ${Math.min(100, b.weight) / 100}))` }} />
                <span className="rt-weight-num">{b.weight}%</span>
              </span>
            )}
            {h.service === "error" && <Glyph state="error" />}
            <span className="rt-name">{nsOf(b.namespace)}{t(b.service)}</span>
            {b.externalName ? (
              <span className="rt-tag">ExternalName</span>
            ) : (
            <span className="rt-port" data-h={/is not a port/.test(b.problem ?? "") ? "error" : undefined}>
              :{t(b.port)}
              {b.targetPort && b.targetPort !== b.port ? <span className="muted"> → {t(b.targetPort)}</span> : null}
            </span>
            )}
          </span>
          <Wire health={h.toPods} lit={focus} />
          {/* pods: ready dots, count, workload; or the DNS name of an ExternalName */}
          <span className="rt-cell rt-pods" data-step={3} data-cur={cur(3)} data-h={h.pods} {...(b.problem && h.service !== "error" ? tip(b.problem, { plain: true }) : {})}>
            {b.externalName ? (
              <span className="rt-name muted" dir="ltr">↗ {t(b.externalName)}</span>
            ) : h.service === "error" && b.total === 0 ? (
              <span className="muted">—</span>
            ) : (
              <>
                {(h.pods === "error" || h.pods === "warn") && <Glyph state={h.pods} />}
                <Dots ready={b.ready} total={b.total} />
                <span className="rt-count">{b.ready}/{b.total}</span>
                {w && <span className="rt-name muted">{w[0] === "Deployment" ? "" : `${w[0].toLowerCase()} `}{t(w[1])}</span>}
              </>
            )}
          </span>
        </>
      ) : (
        <>
          <Wire health="ok" lit={focus} />
          <span className="rt-cell rt-redirect" data-step={2} data-cur={cur(2) ?? cur(3)}>
            <span className="rt-name">↪ {t(redirect ?? "")}</span>
          </span>
        </>
      )}
    </div>
  );
}

function Journey({ row }: { row: RouteRow | undefined }) {
  if (!row) return null;
  const steps = journey(row);
  return (
    <div className="rt-journey" aria-label="the journey of one request">
      {steps.map((s, i) => (
        <Fragment key={s.title + i}>
          {i > 0 && <span className="rt-jarrow" data-h={s.health} aria-hidden="true">→</span>}
          <div className="rt-jstep" data-h={s.health}>
            <div className="rt-jtitle t-label">
              {s.health !== "none" && <Glyph state={s.health === "ok" ? "ok" : s.health} />}
              {s.title}
            </div>
            {s.lines.map((l, j) => (
              <div key={j} className={j === 0 ? "rt-jline" : "rt-jline muted"} dir="auto">
                {t(l)}
              </div>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export default function RoutesView({ pane, view, focused, visible }: ViewProps<"routes">) {
  const context = usePaneContext(pane);
  const rowHeight = useSettings((s) => s.rowHeight);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [epoch, setEpoch] = useState(0);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [cursorKey, setCursorKey] = useState("");
  const [step, setStep] = useState<Step>(2);
  const seq = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const beforeFilter = useRef("");
  const namespace = view.namespace;
  const allNs = !namespace;

  useEffect(() => {
    if (!context || !visible) return;
    const id = ++seq.current;
    backend.routeMap({ context, namespace, namespaces: fallbackNamespaces(context) }).then(
      (map) => id === seq.current && setLoad({ state: "ok", map, at: Date.now() }),
      (e: unknown) => id === seq.current && setLoad({ state: "error", message: errorText(e) }),
    );
  }, [context, namespace, epoch, visible]);

  const map = load.state === "ok" ? load.map : null;
  const groups = useMemo(() => groupHosts(map, { filter, problemsOnly }), [map, filter, problemsOnly]);
  const rows = useMemo(() => flatRows(groups), [groups]);
  const totals = useMemo(() => summary(groupHosts(map)), [map]);
  const index = Math.max(0, rows.findIndex((r) => r.key === cursorKey));
  const current = rows[index] as RouteRow | undefined;
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);

  const live = useRef({ rows, index, current, step, filter, filtering, problemsOnly });
  live.current = { rows, index, current, step, filter, filtering, problemsOnly };

  const goTo = useCallback((i: number) => {
    const r = live.current.rows[Math.min(Math.max(0, i), live.current.rows.length - 1)];
    if (!r) return;
    live.current = { ...live.current, index: live.current.rows.indexOf(r), current: r };
    setCursorKey(r.key);
  }, []);

  useEffect(() => {
    scroll.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, rows]);

  useEffect(() => {
    const open = (newPane: "right" | "down" | null) => {
      const { current: r, step: s } = live.current;
      const ref = r && stepRef(r, s);
      if (!ref || !context) return;
      openInContext(docView(ref, "describe"), context, { pane, newPane });
    };
    const closeFilter = () => {
      setFiltering(false);
      scroll.current?.focus();
    };
    return setRoutesController(pane, {
      move: (d) => goTo(live.current.index + d),
      page: (dir) => goTo(live.current.index + dir * Math.max(1, Math.floor((scroll.current?.clientHeight ?? rowHeight) / rowHeight) - 2)),
      edge: (w) => goTo(w === "top" ? 0 : live.current.rows.length - 1),
      step: (d) => {
        const next = Math.min(3, Math.max(0, live.current.step + d)) as Step;
        live.current = { ...live.current, step: next };
        setStep(next);
      },
      open,
      canOpen: () => stepOpenWhy(live.current.current, live.current.step),
      copyUrl: () => {
        const r = live.current.current;
        if (!r) return;
        const url = entryUrl(r.entry);
        navigator.clipboard.writeText(url).then(
          () => toast({ kind: "ok", text: `Copied ${url}` }),
          (e: unknown) => toasts.error(`Could not copy: ${errorText(e)}`),
        );
      },
      hasRow: () => !!live.current.current,
      toggleProblems: () => setProblemsOnly((p) => !p),
      rowNamespace: () => live.current.current?.entry.source.namespace,
      refresh: () => setEpoch((n) => n + 1),
      filterOpen: () => {
        beforeFilter.current = live.current.filter;
        setFiltering(true);
      },
      filterApply: closeFilter,
      filterCancel: () => {
        setFilter(beforeFilter.current);
        closeFilter();
      },
      isFiltering: () => live.current.filtering,
      hasFilter: () => live.current.filter !== "",
      filterClear: () => setFilter(""),
    });
  }, [pane, context, goTo, rowHeight]);

  // hints and `enabled` follow the cursor row and step
  const openable = current ? String(stepOpenWhy(current, step)) : "";
  useEffect(() => engine.invalidate(), [openable, filtering, filter, !!current, load.state]);

  // the pointer: a click picks the row and the step, a double click (or Ctrl/⌘+click) opens it
  const hit = (e: MouseEvent): { i: number; s?: Step } => {
    const el = e.target as HTMLElement;
    const rowEl = el.closest<HTMLElement>("[data-index]");
    const stepEl = el.closest<HTMLElement>("[data-step]");
    return { i: rowEl ? Number(rowEl.dataset.index) : -1, s: stepEl ? (Number(stepEl.dataset.step) as Step) : undefined };
  };
  const pick = (e: MouseEvent): boolean => {
    const { i, s } = hit(e);
    if (i < 0) return false;
    if (focusedPane() !== pane) focusPane(pane);
    goTo(i);
    if (s !== undefined) {
      live.current = { ...live.current, step: s };
      setStep(s);
    }
    return true;
  };
  const onClick = (e: MouseEvent) => {
    if (!pick(e)) return;
    if (e.ctrlKey || e.metaKey) engine.run("nav.open", { source: "pointer", newPane: e.shiftKey ? "down" : "right" });
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (pick(e)) engine.run("nav.open", { source: "pointer", newPane: null });
  };

  const where = namespace ? t(namespace) : "all namespaces";
  const notes = map?.notes ?? [];
  const head = (
    <div className="rt-head t-ui">
      <span className="rt-head-ref">HTTP routes · {where}</span>
      {map && (
        <span className="muted">
          {totals.routes} {totals.routes === 1 ? "route" : "routes"} · {totals.hosts} {totals.hosts === 1 ? "host" : "hosts"}
        </span>
      )}
      {totals.problems > 0 && (
        <span className="rt-head-problems" {...tip("rows with a broken link or pods that are not ready", { reason: "! problems only" })}>
          <Glyph state="error" />
          {totals.problems} with problems
        </span>
      )}
      {problemsOnly && <span className="rt-head-mode">problems only (!)</span>}
      {load.state === "ok" && <span className="muted rt-head-time">read {new Date(load.at).toLocaleTimeString()}</span>}
    </div>
  );

  const chips = (filtering || filter) && (
    <PaneSlot name="chips">{filtering ? <FilterBar value={filter} onChange={setFilter} /> : <FilterChip mode="FILTER" value={filter} onRemove={() => setFilter("")} />}</PaneSlot>
  );

  if (load.state === "loading") return <div className="rt">{head}<EmptyState compact>reading the Ingresses and HTTPRoutes of {where}</EmptyState></div>;
  if (load.state === "error") return <div className="rt">{head}<EmptyState compact title="Could not read the routes">{t(load.message)}</EmptyState></div>;

  return (
    <div className="rt" data-active={focused || undefined}>
      <PaneSlot name="count">{filter || problemsOnly ? `${rows.length}/${flatRows(groupHosts(map)).length}` : rows.length}</PaneSlot>
      {chips}
      {head}
      {notes.length > 0 && (
        <div className="rt-notes t-ui">
          {notes.map((n) => (
            <span key={n}>{t(n)}</span>
          ))}
        </div>
      )}
      {map && map.entries.length === 0 ? (
        <EmptyState compact title="No HTTP routes">
          No Ingress or HTTPRoute in {where}. {namespace ? "a shows every namespace." : ""}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState compact>{problemsOnly && !filter ? "No problems: every route reaches ready pods" : `Nothing matches “${filter}”`}</EmptyState>
      ) : (
        <>
          <div className="rt-cols t-colhead" aria-hidden="true">
            {STEPS.map((s, i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rt-wire" />}
                <span className="rt-cell" data-cur={(focused && step === i) || undefined}>{s === "route" ? "ingress / route" : s}</span>
              </Fragment>
            ))}
          </div>
          <div ref={scroll} className="rt-scroll" tabIndex={-1} role="grid" aria-label="HTTP routes" onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={(e) => void pick(e)}>
            {groups.map((g) => (
              <div key={g.host} className="rt-group" role="rowgroup">
                <div className="rt-host t-ui" role="presentation">
                  <span className="rt-scheme" data-tls={g.tls || undefined}>{g.tls ? "https" : "http"}</span>
                  <span className="rt-hostname" dir="ltr">{g.host === "*" ? "any host" : t(g.host)}</span>
                  {g.addresses.length > 0 && <span className="muted">at {g.addresses.map((a) => t(a)).join(", ")}</span>}
                  {g.problems > 0 && (
                    <span className="rt-host-problems">
                      <Glyph state="error" />
                      {g.problems}
                    </span>
                  )}
                </div>
                {g.rows.map((r) => {
                  const i = indexOf.get(r.key) ?? -1;
                  return <Row key={r.key} row={r} index={i} focus={i === index} step={step} allNs={allNs} />;
                })}
              </div>
            ))}
          </div>
          <Journey row={current} />
        </>
      )}
    </div>
  );
}
