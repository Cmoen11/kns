// The routes map, pure (`:routes`, docs/tools.md#routes): entries grouped by host, one row per
// backend (a split rule gets a row per share), where each request stops, and the words of the
// journey panel. No React, no backend.
import type { RouteBackend, RouteEntry, RouteMap } from "../ipc/types";
import type { ObjectRef } from "../types";

/** The four steps of a row, left to right: what is asked, what routes it, the Service, the pods. */
export const STEPS = ["request", "route", "service", "pods"] as const;
export type Step = 0 | 1 | 2 | 3;
export type Health = "ok" | "warn" | "error" | "none";

export interface RouteRow {
  key: string;
  entry: RouteEntry;
  /** undefined: a rule that only redirects */
  backend?: RouteBackend;
  /** the first row of its entry carries the request and route cells */
  first: boolean;
  /** position among the entry's backends, for the branch drawing */
  branch: "only" | "first" | "middle" | "last";
}

export interface HostGroup {
  host: string;
  tls: boolean;
  rows: RouteRow[];
  /** rows with a broken or degraded link */
  problems: number;
  /** the distinct addresses clients reach this host at */
  addresses: string[];
}

export interface RowHealth {
  /** the Service cell */
  service: Health;
  /** the pods cell */
  pods: Health;
  /** the wire into the Service cell, and the one into the pods cell */
  toService: Health;
  toPods: Health;
  /** the worst of them */
  worst: Health;
}

const RANK: Record<Health, number> = { none: 0, ok: 1, warn: 2, error: 3 };
const worse = (a: Health, b: Health): Health => (RANK[b] > RANK[a] ? b : a);

/** Where a request through this backend stops, cell by cell. */
export function rowHealth(row: RouteRow): RowHealth {
  const b = row.backend;
  if (!b) {
    // redirect only: the request ends at the route, by design
    return { service: "none", pods: "none", toService: "none", toPods: "none", worst: "ok" };
  }
  const p = b.problem ?? "";
  let h: Omit<RowHealth, "worst">;
  if (/not found|not a Service|no port given/.test(p)) h = { service: "error", pods: "none", toService: "error", toPods: "none" };
  else if (/is not a port/.test(p)) h = { service: "error", pods: b.total ? (b.ready ? "ok" : "error") : "none", toService: "ok", toPods: "error" };
  else if (b.externalName) h = { service: "ok", pods: "none", toService: "ok", toPods: "ok" };
  else if (p) h = { service: "ok", pods: "error", toService: "ok", toPods: "error" };
  else if (b.ready < b.total) h = { service: "ok", pods: "warn", toService: "ok", toPods: "warn" };
  else h = { service: "ok", pods: "ok", toService: "ok", toPods: "ok" };
  return { ...h, worst: [h.service, h.pods, h.toService, h.toPods].reduce(worse, "ok" as Health) };
}

export const hasProblem = (row: RouteRow): boolean => RANK[rowHealth(row).worst] >= RANK.warn;

function rowsOf(entry: RouteEntry, i: number): RouteRow[] {
  const id = `${entry.source.kind}/${entry.source.namespace}/${entry.source.name}|${entry.host}|${entry.matchType}|${entry.path}|${(entry.conditions ?? []).join(",")}|${i}`;
  if (entry.backends.length === 0) return [{ key: id, entry, first: true, branch: "only" }];
  const n = entry.backends.length;
  return entry.backends.map((backend, j) => ({
    key: `${id}|${j}`,
    entry,
    backend,
    first: j === 0,
    branch: n === 1 ? "only" : j === 0 ? "first" : j === n - 1 ? "last" : "middle",
  }));
}

/** The words a filter matches for a row. */
export function rowSearch(row: RouteRow): string {
  const e = row.entry;
  const b = row.backend;
  return [
    e.host, e.path, e.matchType, e.source.kind, e.source.namespace, e.source.name, e.source.via, e.source.address, ...(e.conditions ?? []), ...(e.filters ?? []),
    b?.service, b?.namespace, b?.port, b?.targetPort, b?.workload, b?.externalName, b?.problem,
  ].filter(Boolean).join(" ").toLowerCase();
}

/** Every word of the filter must occur in the row. */
export function matchesFilter(row: RouteRow, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = rowSearch(row);
  return words.every((w) => hay.includes(w));
}

/** Entries grouped by host in the order Rust sorted them (`*` last). An entry keeps all its rows when one matches. */
export function groupHosts(map: RouteMap | null, opts: { filter?: string; problemsOnly?: boolean } = {}): HostGroup[] {
  if (!map) return [];
  const groups: HostGroup[] = [];
  map.entries.forEach((entry, i) => {
    const rows = rowsOf(entry, i);
    if (opts.filter && !rows.some((r) => matchesFilter(r, opts.filter!))) return;
    if (opts.problemsOnly && !rows.some(hasProblem)) return;
    let g = groups.find((x) => x.host === entry.host);
    if (!g) {
      g = { host: entry.host, tls: false, rows: [], problems: 0, addresses: [] };
      groups.push(g);
    }
    g.tls ||= entry.tls;
    g.rows.push(...rows);
    g.problems += rows.filter(hasProblem).length;
    const a = entry.source.address;
    if (a && !g.addresses.includes(a)) g.addresses.push(a);
  });
  return groups;
}

export const flatRows = (groups: readonly HostGroup[]): RouteRow[] => groups.flatMap((g) => g.rows);

// ── words ─────────────────────────────────────────────────────────────────────

/** `https://shop.example.com/api`; a route for any host uses its address when it has one. */
export function entryUrl(e: RouteEntry): string {
  const scheme = e.tls ? "https" : "http";
  const host = e.host === "*" ? e.source.address ?? "<address>" : e.host.replace(/^\*\./, "any.");
  const path = e.matchType === "RegularExpression" ? "/" : e.path.startsWith("/") ? e.path : `/${e.path}`;
  return `${scheme}://${host}${path}`;
}

/** What the path match takes, in words. */
export function matchWords(e: RouteEntry): string {
  switch (e.matchType) {
    case "Prefix":
      return e.path === "/" ? "every path" : `${e.path} and every path under it`;
    case "Exact":
      return `only ${e.path}`;
    case "RegularExpression":
      return `paths matching ${e.path}`;
    case "default":
      return "anything no rule of the Ingress takes";
    default:
      return `${e.path}, as the controller reads it`;
  }
}

/** The short path label of the request cell: `/api/*`, `= /admin`, `~ ^/v[0-9]`, `default`. */
export function pathLabel(e: RouteEntry): string {
  switch (e.matchType) {
    case "Prefix":
      return e.path === "/" ? "/*" : `${e.path.replace(/\/$/, "")}/*`;
    case "Exact":
      return `= ${e.path}`;
    case "RegularExpression":
      return `~ ${e.path}`;
    case "default":
      return "default";
    default:
      return e.path;
  }
}

/** `Deployment/web` → ["Deployment", "web"]. */
export function splitWorkload(w: string | undefined): [string, string] | null {
  const i = w?.indexOf("/") ?? -1;
  return w && i > 0 ? [w.slice(0, i), w.slice(i + 1)] : null;
}

const WORKLOAD_GVR: Record<string, { group: string; version: string; resource: string }> = {
  Deployment: { group: "apps", version: "v1", resource: "deployments" },
  StatefulSet: { group: "apps", version: "v1", resource: "statefulsets" },
  DaemonSet: { group: "apps", version: "v1", resource: "daemonsets" },
  ReplicaSet: { group: "apps", version: "v1", resource: "replicasets" },
  Job: { group: "batch", version: "v1", resource: "jobs" },
};

/** The object behind a step of a row, for describe; none for a step with nothing to open. */
export function stepRef(row: RouteRow, step: Step): ObjectRef | undefined {
  const e = row.entry;
  const b = row.backend;
  switch (step) {
    case 0:
    case 1:
      return e.source.kind === "HTTPRoute"
        ? { gvr: { group: "gateway.networking.k8s.io", version: "v1", resource: "httproutes" }, namespace: e.source.namespace, name: e.source.name }
        : { gvr: { group: "networking.k8s.io", version: "v1", resource: "ingresses" }, namespace: e.source.namespace, name: e.source.name };
    case 2:
      return b && !/not found|not a Service/.test(b.problem ?? "") ? { gvr: { group: "", version: "v1", resource: "services" }, namespace: b.namespace, name: b.service } : undefined;
    case 3: {
      const w = splitWorkload(b?.workload);
      const gvr = w && WORKLOAD_GVR[w[0]];
      return b && w && gvr ? { gvr, namespace: b.namespace, name: w[1] } : undefined;
    }
  }
}

/** What Enter would open on a step, for the hint and the tooltip. */
export function stepOpenWhy(row: RouteRow | undefined, step: Step): true | string {
  if (!row) return "no row selected";
  if (stepRef(row, step)) return true;
  if (step === 2) return row.backend ? "the Service does not exist" : "a redirect: no Service";
  return row.backend?.externalName ? "outside the cluster" : "no workload behind the Service";
}

export interface JourneyStep {
  title: string;
  lines: string[];
  health: Health;
}

/** The journey panel: the focused row told as what happens to one request. */
export function journey(row: RouteRow): JourneyStep[] {
  const e = row.entry;
  const b = row.backend;
  const h = rowHealth(row);
  const steps: JourneyStep[] = [];
  steps.push({
    title: "Request",
    lines: [`${entryUrl(e)}`, `matches ${matchWords(e)}`, ...(e.host === "*" ? ["for any host name"] : []), ...(e.conditions ?? []).map((c) => `and ${c}`)],
    health: "ok",
  });
  const via = e.source.via;
  steps.push({
    title: "Enters",
    lines: [
      e.source.address ? `at ${e.source.address}` : "at the controller's load balancer",
      via ? (via.startsWith("gateway ") ? `Gateway ${via.slice(8)}` : `IngressClass ${via}`) : "the default IngressClass",
      ...(e.tls ? ["TLS ends here"] : []),
    ],
    health: "ok",
  });
  steps.push({
    title: e.source.kind,
    lines: [`${e.source.namespace}/${e.source.name}`, ...(e.filters ?? [])],
    health: "ok",
  });
  if (!b) return steps;
  const share = b.weight !== undefined ? `${b.weight}% of the requests · ` : "";
  steps.push({
    title: "Service",
    lines: [
      `${share}${b.namespace}/${b.service}`,
      b.externalName ? `ExternalName → ${b.externalName}` : b.targetPort ? `port ${b.port} → pod port ${b.targetPort}` : `port ${b.port}`,
      ...(h.service === "error" && b.problem ? [b.problem] : []),
    ],
    health: h.service === "none" ? "error" : h.service,
  });
  if (b.externalName) {
    steps.push({ title: "Outside", lines: [b.externalName, "DNS name outside the cluster: kns cannot see what answers"], health: "none" });
  } else if (h.pods !== "none" || b.total > 0) {
    steps.push({
      title: "Pods",
      lines: [`${b.ready} of ${b.total} ready`, ...(b.workload ? [b.workload] : []), ...(h.service !== "error" && b.problem ? [b.problem] : [])],
      health: h.pods === "none" ? "error" : h.pods,
    });
  }
  return steps;
}

/** The header counts: `14 routes · 6 hosts · 3 with problems`. */
export function summary(groups: readonly HostGroup[]): { routes: number; hosts: number; problems: number } {
  const entries = new Set<RouteEntry>();
  let problems = 0;
  for (const g of groups) for (const r of g.rows) {
    entries.add(r.entry);
    if (hasProblem(r)) problems++;
  }
  return { routes: entries.size, hosts: groups.length, problems };
}
