// The `table` and `containers` views (docs/ux.md §12). Each builds a GridSource from its view
// state and live data; the Grid and the TableModel do the rest.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Json, Row, TableQuery } from "../ipc/types";
import type { Filter, Sort } from "../types";
import {
  backend, flash, isFluxGroup, gvrKey, patchView, setNamespace, useCluster, tableKey, tables, toObjRef, useConn, usePaneContext, useResource, useTable,
  type ViewOf, type ViewProps,
} from "../foundation";
import { containerRows, CONTAINER_COLUMNS } from "./containers";
import { labelSelectorOf } from "./filter";
import { Grid } from "./Grid";
import { usePodMetrics } from "./metrics";
import { TableModel, type GridSource } from "./model";
import { openFromContainers, openFromTable } from "./open";
import { updatePrefs } from "./prefs";
import { scopeSelectors, useScopeTest } from "./scope";

const EVENTS_SORT: Sort = { column: "last seen", desc: false };

function scopeKey(view: ViewOf<"table">): string {
  const s = view.scope;
  return !s ? "" : s.by === "owner" ? `o:${s.ref.uid ?? s.ref.name}` : s.by === "node" ? `n:${s.name}` : `s:${s.selector}`;
}

function ResourceTable({ pane, view, focused, visible }: ViewProps<"table">) {
  const [model] = useState(() => new TableModel(pane));
  const context = usePaneContext(pane);
  const hasMetrics = useConn(context, (c) => c.info?.hasMetrics ?? false);
  const res = useResource(view.gvr, context);
  const namespaced = res?.namespaced ?? true;
  const resource = view.gvr.resource;
  const namespace = namespaced && view.namespace !== "*" ? view.namespace : undefined;

  const selectors = scopeSelectors(view.scope);
  const labelSelector = labelSelectorOf(view.filters, selectors.labelSelector);
  const query = useMemo<TableQuery | null>(
    () => (context ? { context, gvr: view.gvr, namespace, labelSelector, fieldSelector: selectors.fieldSelector } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context, view.gvr.group, view.gvr.version, view.gvr.resource, namespace, labelSelector, selectors.fieldSelector],
  );
  const snap = useTable(query, { live: visible, pane });
  const key = query ? tableKey(query) : "";

  // listing across all namespaces is forbidden (RBAC only grants one): fall back to the
  // kubeconfig context's namespace, as kubectl would use it
  const ownNamespace = useCluster((s) => s.contexts.find((c) => c.name === context)?.namespace);
  const allForbidden = namespaced && view.namespace === "*" && snap.state === "forbidden";
  useEffect(() => {
    if (!allForbidden || !ownNamespace) return;
    setNamespace(ownNamespace, pane);
    flash(`Listing ${resource} in all namespaces is forbidden: showing ${ownNamespace}`, "warn");
  }, [allForbidden, ownNamespace, pane, resource]);

  // changed cells (§9.4). Declared after useTable: the subscription exists once its effect ran.
  useEffect(() => {
    if (!key) return;
    return tables().subscribeDelta(key, (d) => {
      if (d.reset) return model.clearDeltas();
      const now = Date.now();
      for (const [uid, prev] of d.changed) {
        const next = prev && tables().rowByUid(key, uid);
        if (prev && next) model.markChanged(uid, prev, next, now);
      }
      model.flushDeltas();
    });
  }, [key, model]);

  const scopeTest = useScopeTest(view.scope, context, visible);
  const isPods = resource === "pods" && view.gvr.group === "";
  const metricsOn = isPods && hasMetrics;
  const metrics = usePodMetrics(context, namespace, metricsOn && visible);

  const live = useRef({ view, columns: snap.columns });
  live.current = { view, columns: snap.columns };
  const prefsKey = gvrKey(view.gvr);

  const source: GridSource = {
    pane,
    kind: "table",
    resource,
    flux: isFluxGroup(view.gvr.group),
    dataKey: `${key}|${scopeKey(view)}`,
    prefsKey,
    columns: snap.columns,
    rows: snap.rows,
    synced: snap.synced,
    state: snap.state,
    message: snap.message,
    stale: snap.stale,
    namespaceColumn: namespaced && view.namespace === "*",
    metrics: metricsOn ? metrics : null,
    filters: view.filters,
    faultsOnly: view.faultsOnly,
    sort: view.sort,
    defaultSort: resource === "events" ? EVENTS_SORT : null,
    sourceOrder: false,
    wide: view.wide,
    scopeTest,
    marks: true,
    labels: true,
    emptyHint: namespace && !view.scope ? "namespace" : undefined,
    initialCursor: view.cursorUid ?? view.cursorName,
    refOf: (row) => ({ gvr: view.gvr, namespace: row.namespace, name: row.name, uid: row.uid }),
    setFilters: (filters) => patchView(pane, "table", { filters }),
    setFaults: (faultsOnly) => patchView(pane, "table", { faultsOnly }),
    setSort: (sort) => {
      // the pane's sort, and the per-kind memory (§12.4)
      patchView(pane, "table", { sort });
      updatePrefs(prefsKey, (p) => ({ ...p, sort }));
    },
    setWide: (wide) => patchView(pane, "table", { wide }),
    refresh: () => {
      if (key) tables().refresh(key);
    },
    open: (what, row, newPane) => openFromTable(pane, live.current.view, live.current.columns, what, row, newPane),
  };
  return <Grid model={model} source={source} focused={focused} visible={visible} />;
}

const CORE_PODS = { group: "", version: "v1", resource: "pods" };
const NO_ROWS: readonly Row[] = [];
const NO_FILTERS: readonly Filter[] = [];

function ContainersTable({ pane, view, focused, visible }: ViewProps<"containers">) {
  const [model] = useState(() => new TableModel(pane));
  const context = usePaneContext(pane);
  const pod = view.pod;
  const [data, setData] = useState<{ rows: readonly Row[]; synced: boolean; error?: string }>({ rows: NO_ROWS, synced: false });
  const [filters, setFilters] = useState<readonly Filter[]>(NO_FILTERS);
  const [faultsOnly, setFaults] = useState(false);
  const [wide, setWide] = useState(false);
  const [epoch, setEpoch] = useState(0);

  // the pod's own row (shared pods watch) tells when to re-read the object
  const query = useMemo<TableQuery | null>(
    () => (context ? { context, gvr: CORE_PODS, namespace: pod.namespace } : null),
    [context, pod.namespace],
  );
  const snap = useTable(query, { live: visible, pane });
  const podRow = useMemo(() => snap.rows.find((r) => (pod.uid ? r.uid === pod.uid : r.name === pod.name)), [snap.rows, pod.uid, pod.name]);

  useEffect(() => {
    if (!context) return;
    let alive = true;
    const t = setTimeout(() => {
      backend.getJson(toObjRef(pod, context)).then(
        (obj: Json) => alive && setData({ rows: containerRows(obj), synced: true }),
        (e: unknown) => alive && setData((d) => ({ rows: d.rows, synced: true, error: typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e) })),
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // re-read when the pod's table row changes (status, restarts) and on refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, pod.namespace, pod.name, podRow, epoch]);

  const deleting = !!podRow?.deleting;
  const rows = useMemo(() => (deleting ? data.rows.map((r) => ({ ...r, deleting: podRow?.deleting })) : data.rows), [data.rows, deleting, podRow?.deleting]);

  const source: GridSource = {
    pane,
    kind: "containers",
    resource: "containers",
    flux: false,
    dataKey: `containers|${context}|${pod.namespace}|${pod.name}`,
    prefsKey: "containers",
    columns: CONTAINER_COLUMNS,
    rows,
    synced: data.synced,
    state: data.error && rows.length === 0 ? "error" : "live",
    message: data.error,
    stale: snap.stale,
    namespaceColumn: false,
    metrics: null,
    filters,
    faultsOnly,
    sort: view.sort,
    defaultSort: null,
    sourceOrder: true,
    wide,
    marks: false,
    labels: false,
    initialCursor: view.cursorName,
    // the foundation stamps cursorName from this name; the object behind a container row is the pod
    refOf: (row) => ({ gvr: pod.gvr, namespace: pod.namespace, name: row.name }),
    setFilters,
    setFaults,
    setSort: (sort) => patchView(pane, "containers", { sort }),
    setWide,
    refresh: () => setEpoch((n) => n + 1),
    open: (what, row, newPane) => openFromContainers(pane, view, what, row, newPane),
  };
  return <Grid model={model} source={source} focused={focused} visible={visible} />;
}

export default function TableView(props: ViewProps) {
  if (props.view.kind === "containers") return <ContainersTable {...props} view={props.view as ViewOf<"containers">} />;
  return <ResourceTable {...props} view={props.view as ViewOf<"table">} />;
}
