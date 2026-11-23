// What the home view lists (docs/ux.md §11.10): discovery sorted into the fixed sections, recent
// tables from the pane histories, and favourites read from the persisted file. Pure.
import type { ApiResource, Gvr } from "../../ipc/types";

export const SECTIONS = ["Workloads", "Network", "Config", "Storage", "Cluster", "Flux", "CRDs"] as const;
export type Section = (typeof SECTIONS)[number];

// order inside a section follows these lists; anything else sorts by name after them
const WORKLOADS = ["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "horizontalpodautoscalers", "poddisruptionbudgets", "replicationcontrollers"];
const NETWORK = ["services", "ingresses", "ingressclasses", "endpoints", "endpointslices", "networkpolicies"];
const CONFIG = ["configmaps", "secrets", "serviceaccounts", "resourcequotas", "limitranges"];
const STORAGE = ["persistentvolumeclaims", "persistentvolumes", "storageclasses", "volumeattachments", "csidrivers", "csinodes", "csistoragecapacities"];
const CLUSTER = ["nodes", "namespaces", "events", "customresourcedefinitions", "roles", "rolebindings", "clusterroles", "clusterrolebindings"];

const BY_NAME = new Map<string, Section>();
for (const [section, names] of [["Workloads", WORKLOADS], ["Network", NETWORK], ["Config", CONFIG], ["Storage", STORAGE], ["Cluster", CLUSTER]] as const) {
  for (const n of names) BY_NAME.set(n, section);
}
const ORDER = [...WORKLOADS, ...NETWORK, ...CONFIG, ...STORAGE, ...CLUSTER];

const isBuiltinGroup = (group: string): boolean => group === "" || !group.includes(".") || group.endsWith(".k8s.io");
/** Groups that serve another view of objects listed elsewhere. */
const HIDDEN_GROUPS = new Set(["metrics.k8s.io", "events.k8s.io", "authentication.k8s.io", "authorization.k8s.io"]);

export function sectionOf(r: { gvr: Gvr }): Section {
  const { group, resource } = r.gvr;
  if (group.endsWith(".toolkit.fluxcd.io")) return "Flux";
  if (!isBuiltinGroup(group)) return "CRDs";
  return BY_NAME.get(resource) ?? "Cluster";
}

/** Listable resources per section, sections in spec order, empty sections dropped. */
export function groupResources(resources: readonly ApiResource[]): { section: Section; items: ApiResource[] }[] {
  const seen = new Set<string>();
  const bySection = new Map<Section, ApiResource[]>();
  for (const r of resources) {
    if (!r.verbs.includes("list") || r.gvr.resource.includes("/") || HIDDEN_GROUPS.has(r.gvr.group)) continue;
    // one row per group/resource, whatever versions are served
    const id = `${r.gvr.group}/${r.gvr.resource}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = sectionOf(r);
    const list = bySection.get(s);
    if (list) list.push(r);
    else bySection.set(s, [r]);
  }
  const rank = (r: ApiResource) => {
    const i = isBuiltinGroup(r.gvr.group) ? ORDER.indexOf(r.gvr.resource) : -1;
    return i < 0 ? ORDER.length : i;
  };
  return SECTIONS.filter((s) => bySection.has(s)).map((section) => ({
    section,
    items: bySection.get(section)!.sort(
      (a, b) => rank(a) - rank(b) || a.gvr.resource.localeCompare(b.gvr.resource) || a.gvr.group.localeCompare(b.gvr.group),
    ),
  }));
}

// ── recents ──

export interface RecentTable {
  gvr: Gvr;
  namespace: string;
}

interface HistoryLike {
  panes: Record<string, { history: readonly { kind: string; gvr?: Gvr; namespace?: string }[]; index: number } | undefined>;
  focused: string;
  mru: readonly string[];
}

export const recentKey = (r: RecentTable): string => `${r.gvr.group}/${r.gvr.version}/${r.gvr.resource}@${r.namespace}`;

/**
 * Tables the user has been in, newest first: the focused pane's history, then the other panes
 * in most-recently-used order. One row per resource and namespace.
 */
export function recentTables(ws: HistoryLike | null, max = 8): RecentTable[] {
  if (!ws) return [];
  const order = [ws.focused, ...ws.mru.filter((p) => p !== ws.focused), ...Object.keys(ws.panes)];
  const out: RecentTable[] = [];
  const seen = new Set<string>();
  const donePanes = new Set<string>();
  for (const id of order) {
    if (donePanes.has(id)) continue;
    donePanes.add(id);
    const pane = ws.panes[id];
    if (!pane) continue;
    for (let i = pane.history.length - 1; i >= 0 && out.length < max; i--) {
      const v = pane.history[i];
      if (v.kind !== "table" || !v.gvr || typeof v.namespace !== "string") continue;
      const r = { gvr: v.gvr, namespace: v.namespace };
      const key = recentKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// ── favourites (owned and written by the palette feature; read-only here) ──

export interface HomeFavorite {
  id: string;
  name: string;
  slot?: number;
  gvr: Gvr;
  /** a name, "*", or null = the target pane's current namespace */
  namespace: string | null;
  faultsOnly: boolean;
  wide: boolean;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Reads `favorites` out of the persisted favourites file (`{ schema, data }` or the bare slice). */
export function parseFavorites(raw: unknown): HomeFavorite[] {
  const root = rec(raw);
  const list = (rec(root?.data) ?? root)?.favorites;
  if (!Array.isArray(list)) return [];
  const out: HomeFavorite[] = [];
  for (const item of list) {
    const f = rec(item);
    const view = rec(f?.view);
    const gvr = rec(view?.gvr);
    if (!f || !view || !gvr) continue;
    if (typeof f.name !== "string" || typeof gvr.resource !== "string" || typeof gvr.group !== "string" || typeof gvr.version !== "string") continue;
    const ns = view.namespace;
    const namespace = typeof ns === "string" ? ns : rec(ns)?.current === true ? null : "*";
    out.push({
      id: typeof f.id === "string" ? f.id : `${out.length}`,
      name: f.name,
      slot: typeof f.slot === "number" && f.slot >= 1 && f.slot <= 9 ? f.slot : undefined,
      gvr: { group: gvr.group, version: gvr.version, resource: gvr.resource },
      namespace,
      faultsOnly: view.faultsOnly === true,
      wide: view.wide === true,
    });
  }
  return out.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.name.localeCompare(b.name));
}
