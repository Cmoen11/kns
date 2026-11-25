// Column specs and the width-fitting arithmetic of docs/ux.md §12.2. Pure: server Table columns
// plus the kind give `{tier, min, ideal, delta}` per column; `fitColumns` picks what a pane of a
// given width shows.
import type { Column } from "../ipc/types";
import type { SortKind } from "./sort";

/** where a column's text comes from */
export type ColSource =
  | { by: "cell"; index: number }
  | { by: "namespace" }
  | { by: "age" }
  | { by: "status" }
  | { by: "cpu" }
  | { by: "mem" }
  /** pods: memory sparkline of the last minutes (C2, src/diag/spark.ts) */
  | { by: "spark" };

export type ColRole = "name" | "status" | "age" | "cell";

export interface ColSpec {
  /** stable id: the lowercased server column name, or `@ns`, `@status`, `@cpu`, `@mem`, `@spark` */
  id: string;
  title: string;
  /** header used when the full title does not fit (`RST`, `NS`) */
  short?: string;
  source: ColSource;
  /** index of the server cell behind this column, -1 when it has none */
  index: number;
  role: ColRole;
  /** 0 always; 1..4 by pane width; 5 only with wide on */
  tier: number;
  min: number;
  ideal: number;
  numeric: boolean;
  /** false: never shows the changed-cell state (metrics, age) */
  delta: boolean;
  sort: SortKind;
  /** takes the spare width (NAME; MESSAGE on events once shown) */
  grow: boolean;
  /** age and counts render in --k-text-muted */
  quiet: boolean;
}

export const GUTTER = 12;
export const RIGHT_INSET = 8;
export const STATUS_GLYPH_ONLY = 20;
export const HYSTERESIS = 24;
export const WIDTH_STEP = 8;
export const MIN_USER_WIDTH = 24;
const MAX_IDEAL = 320;
/** NAME width that must fit before tier 4 columns are added (or NAME's content width, when that is less) */
export const NAME_COMFORT = 220;

const SHORT: Record<string, string> = {
  restarts: "RST", ready: "RDY", "@ns": "NS", namespace: "NS", "up-to-date": "UPD", available: "AVL", "last schedule": "LAST", "nominated node": "NOMINATED",
  "readiness gates": "GATES", completions: "COMPL",
};

const MIN_WIDTH: Record<string, number> = {
  name: 120, object: 120, "@status": 88, status: 88, state: 88, ready: 44, restarts: 40, age: 44, "@cpu": 48, "@mem": 56, "@spark": 176,
  node: 120, ip: 104, "@ns": 96, type: 72, "last seen": 64, reason: 96, message: 160, schedule: 88, "port(s)": 88, "cluster-ip": 104,
  "external-ip": 104, image: 160, images: 160, roles: 96, version: 96,
};

const DURATION_COLS = new Set(["age", "duration", "last seen", "first seen", "last schedule", "lived", "died"]);
const RATIO_COLS = new Set(["ready", "completions"]);
const NUM_COLS = new Set(["restarts", "count", "data", "desired", "current", "up-to-date", "available", "active", "pods"]);
const QUIET_COLS = new Set(["age", "restarts", "count", "data", "duration", "last seen", "first seen", "last schedule", "lived", "died"]);

/** Per-kind tiers by lowercased column name (§12.2). Columns not listed: priority 0 -> 3, else 5. */
const TIERS: Record<string, Record<string, number>> = {
  pods: { ready: 1, restarts: 2, age: 2, "@cpu": 3, "@mem": 3, node: 4, ip: 4 },
  deployments: { ready: 1, "up-to-date": 2, age: 2, available: 3, images: 4, containers: 5, selector: 5, labels: 5 },
  statefulsets: { ready: 1, age: 2, service: 3, images: 4, containers: 5, selector: 5 },
  daemonsets: { ready: 1, age: 2, "up-to-date": 2, available: 3, "node selector": 4, images: 5, containers: 5, selector: 5 },
  replicasets: { ready: 1, age: 2, desired: 3, current: 3, owner: 4, images: 5, containers: 5, selector: 5 },
  jobs: { completions: 1, duration: 2, age: 2, images: 4, containers: 5, selector: 5 },
  cronjobs: { schedule: 1, "last schedule": 2, age: 2, active: 3, timezone: 4, suspend: 5, images: 5, containers: 5, selector: 5 },
  services: { type: 1, "port(s)": 1, "cluster-ip": 2, age: 2, "external-ip": 3, selector: 5 },
  nodes: { roles: 2, age: 2, version: 4 },
  namespaces: { age: 2 },
  events: { reason: 1, "last seen": 1, message: 2, count: 3, name: 5 },
  configmaps: { data: 1, age: 2 },
  secrets: { type: 1, data: 2, age: 2 },
  persistentvolumeclaims: { capacity: 1, age: 2, volume: 3, storageclass: 3 },
  persistentvolumes: { capacity: 1, claim: 2, age: 2, storageclass: 3, "reclaim policy": 4 },
  ingresses: { hosts: 1, class: 2, age: 2, address: 3, ports: 4 },
  // crash card (plan-features §3 C1): LAST next to RESTARTS, LIVED / DIED when there is room
  containers: { ready: 1, restarts: 2, last: 2, type: 2, lived: 3, died: 3, image: 4, ports: 4 },
};
const FLUX_TIERS: Record<string, number> = { status: 1, revision: 2, age: 2, suspended: 3 };

/** Kinds whose status is derived from other cells and gets a synthetic STATUS column. */
const DERIVED_STATUS = new Set(["deployments", "statefulsets", "daemonsets", "replicasets", "cronjobs", "jobs"]);

export interface SpecInput {
  /** plural resource; "containers" for the containers view */
  resource: string;
  flux: boolean;
  columns: readonly Column[];
  /** add the NAMESPACE column (all namespaces, namespaced kind) */
  namespaceColumn: boolean;
  /** add CPU and MEM (pods, cluster has metrics) */
  metrics: boolean;
}

const headerWidth = (title: string): number => Math.ceil(title.length * 8) + 12;

function base(id: string, title: string, source: ColSource, tier: number, over: Partial<ColSpec> = {}): ColSpec {
  const numeric = over.numeric ?? false;
  const min = MIN_WIDTH[id] ?? Math.max(numeric ? 48 : 56, Math.min(headerWidth(SHORT[id] ?? title), 120));
  return {
    id, title, short: SHORT[id], source, index: source.by === "cell" ? source.index : -1, role: "cell", tier, min, ideal: min, numeric, delta: true,
    sort: DURATION_COLS.has(id) ? "duration" : RATIO_COLS.has(id) ? "ratio" : numeric || NUM_COLS.has(id) ? "num" : "text",
    grow: false, quiet: QUIET_COLS.has(id), ...over,
  };
}

/** The id of the server column that carries the status word, if the kind has one. */
export function statusColumnId(resource: string, flux: boolean, ids: readonly string[]): string | null {
  if (flux) return ids.includes("ready") ? "ready" : null;
  if (resource === "events") return ids.includes("type") ? "type" : null;
  if (resource === "containers") return ids.includes("state") ? "state" : null;
  if (DERIVED_STATUS.has(resource) && !ids.includes("status")) return null;
  // Argo CD Applications print SYNC STATUS and HEALTH STATUS: the status cell combines both
  if (ids.includes("health status") && ids.includes("sync status")) return "health status";
  for (const c of ["status", "phase", "state"]) if (ids.includes(c)) return c;
  return null;
}

/** Builds the full column set of a table, in natural order. */
export function buildSpecs(i: SpecInput): ColSpec[] {
  const ids = i.columns.map((c) => c.name.trim().toLowerCase());
  const nameId = i.resource === "events" && ids.includes("object") ? "object" : "name";
  const statusId = statusColumnId(i.resource, i.flux, ids);
  const synthStatus = statusId === null && DERIVED_STATUS.has(i.resource);
  const known = i.flux ? FLUX_TIERS : TIERS[i.resource];
  const out: ColSpec[] = [];
  let generic = 0;
  const seen = new Set<string>();

  i.columns.forEach((c, index) => {
    let id = ids[index];
    if (seen.has(id)) id = `${id}#${index}`;
    seen.add(id);
    const source: ColSource = { by: "cell", index };
    const numeric = c.type === "integer" || c.type === "number" || NUM_COLS.has(id);
    if (id === nameId) {
      out.unshift(base(id, c.name, source, 0, { role: "name", grow: true, ideal: MAX_IDEAL, min: MIN_WIDTH.name }));
      if (i.namespaceColumn) out.splice(1, 0, base("@ns", "Namespace", { by: "namespace" }, 1));
      if (synthStatus) out.splice(1, 0, base("@status", "Status", { by: "status" }, 1, { role: "status" }));
      return;
    }
    if (id === statusId) {
      out.push(base(id, c.name, { by: "status" }, 1, { role: "status", index, min: MIN_WIDTH.status, sort: "text", numeric: false }));
      return;
    }
    let tier: number;
    if (known) tier = known[id] ?? (c.priority > 0 ? 5 : 3);
    else if (c.priority > 0) tier = 5;
    else if (id === "age") tier = 2;
    else tier = generic++ < 2 ? 1 : 3;
    if (id === "age") {
      out.push(base(id, c.name, { by: "age" }, tier, { role: "age", index, numeric: true, delta: false }));
      return;
    }
    out.push(base(id, c.name, source, tier, { numeric, grow: i.resource === "events" && id === "message" }));
  });

  // a server table without a name column still needs the anchor column
  if (!out.some((c) => c.role === "name")) {
    out.unshift(base("name", "Name", { by: "cell", index: -1 }, 0, { role: "name", grow: true, ideal: MAX_IDEAL, min: MIN_WIDTH.name }));
    if (i.namespaceColumn) out.splice(1, 0, base("@ns", "Namespace", { by: "namespace" }, 1));
  }
  if (i.metrics) {
    const after = out.findIndex((c) => c.role === "age");
    const at = after >= 0 ? after + 1 : out.length;
    out.splice(
      at, 0,
      base("@cpu", "CPU", { by: "cpu" }, known?.["@cpu"] ?? 3, { numeric: true, delta: false, sort: "num", quiet: true }),
      base("@mem", "MEM", { by: "mem" }, known?.["@mem"] ?? 3, { numeric: true, delta: false, sort: "num", quiet: true }),
    );
    // C2 sparklines: the pods SPARK column, only in the wide view (tier 5)
    if (i.resource === "pods") {
      out.splice(at + 2, 0, base("@spark", "Spark", { by: "spark" }, 5, { numeric: false, delta: false, sort: "num", quiet: true }));
    }
  }
  return out;
}

/**
 * Width a column needs to show its full header title: Etikett S (10px uppercase, 0.16em tracking)
 * plus the cell padding and room for the sort arrow. Narrower columns show the short title.
 */
export const titleWidth = (title: string): number => Math.ceil(title.length * 8.2) + 18;

/** Ideal width for a column whose longest text has `chars` characters (12px UI font, 6px padding each side). */
export function idealWidth(spec: ColSpec, chars: number): number {
  if (spec.role === "status") return Math.max(spec.min, Math.min(MAX_IDEAL, Math.ceil(chars * 7.4) + 12 + 14));
  return Math.max(spec.min, Math.min(MAX_IDEAL, Math.ceil(chars * 7.4) + 12));
}

export interface ColumnOverrides {
  order: readonly string[];
  hidden: readonly string[];
  pinned: readonly string[];
  widths: Readonly<Record<string, number>>;
}
export const NO_OVERRIDES: ColumnOverrides = { order: [], hidden: [], pinned: [], widths: {} };

/** Applies the user's order: listed ids first in that order, the rest in natural order. NAME stays first. */
export function orderSpecs(specs: readonly ColSpec[], order: readonly string[]): ColSpec[] {
  if (order.length === 0) return [...specs];
  const rank = new Map(order.map((id, i) => [id, i]));
  const indexed = specs.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    if (a.s.role === "name") return -1;
    if (b.s.role === "name") return 1;
    const ra = rank.get(a.s.id);
    const rb = rank.get(b.s.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.i - b.i;
  });
  return indexed.map((x) => x.s);
}

export interface FitCol {
  spec: ColSpec;
  width: number;
  /** status column shown as the 20px glyph only */
  glyphOnly: boolean;
}

export interface Fit {
  cols: FitCol[];
  /** how many prioritized (non tier-0) columns are shown; feed back as `prevCount` for hysteresis */
  count: number;
  /** content width including gutter and right inset; larger than the pane only with wide on */
  total: number;
}

export interface FitInput {
  /** in display order */
  specs: readonly ColSpec[];
  /** pane body width in CSS px */
  width: number;
  wide: boolean;
  /** `count` of the previous fit, or -1 for the first one (no hysteresis) */
  prevCount: number;
  overrides?: ColumnOverrides;
}

/**
 * §12.2: add columns by tier (rightmost of a tier hides first) while the sum of minimums fits,
 * grow them toward `ideal` (the status word and NAME first), give the rest to NAME. A column that was not shown needs 24px more
 * than its threshold to appear (hysteresis). With wide on every column shows and the table
 * scrolls horizontally.
 */
export function fitColumns({ specs, width, wide, prevCount, overrides = NO_OVERRIDES }: FitInput): Fit {
  const hidden = new Set(overrides.hidden);
  const pinned = new Set(overrides.pinned);
  const userWidth = (s: ColSpec): number | undefined => {
    const w = overrides.widths[s.id];
    return typeof w === "number" && w >= MIN_USER_WIDTH ? w : undefined;
  };
  const tierOf = (s: ColSpec) => (s.role === "name" || pinned.has(s.id) ? 0 : s.tier);
  const minOf = (s: ColSpec) => userWidth(s) ?? s.min;

  const shown = new Map<ColSpec, FitCol>();
  let used = GUTTER + RIGHT_INSET;
  const queue: ColSpec[] = [];
  for (const s of specs) {
    if (hidden.has(s.id) && s.role !== "name") continue;
    const t = tierOf(s);
    if (t === 0) {
      shown.set(s, { spec: s, width: minOf(s), glyphOnly: false });
      used += minOf(s);
    } else if (s.role === "status") {
      // tier 0 carries the glyph alone; the word joins at the column's own tier
      shown.set(s, { spec: s, width: STATUS_GLYPH_ONLY, glyphOnly: true });
      used += STATUS_GLYPH_ONLY;
      queue.push(s);
    } else if (t < 5 || wide) queue.push(s);
  }
  // stable: by tier, the status word first within its tier, then left to right
  const statusFirst = (s: ColSpec) => (s.role === "status" ? 0 : 1);
  const ranked = queue
    .map((s, i) => ({ s, i }))
    .sort((a, b) => tierOf(a.s) - tierOf(b.s) || statusFirst(a.s) - statusFirst(b.s) || a.i - b.i)
    .map((x) => x.s);

  // The extra columns (tier 4: NODE, IP, IMAGES ...) only join once NAME can also be read: its
  // content width, up to NAME_COMFORT. Without this a pane just past the threshold shows the node
  // of every pod next to names cut to a dozen characters.
  const nameSpec = specs.find((s) => s.role === "name");
  const comfort = nameSpec && userWidth(nameSpec) === undefined ? Math.max(0, Math.min(nameSpec.ideal, NAME_COMFORT) - nameSpec.min) : 0;

  let count = 0;
  for (const s of ranked) {
    const cost = s.role === "status" ? minOf(s) - STATUS_GLYPH_ONLY : minOf(s);
    if (!wide) {
      const need = used + cost + (tierOf(s) >= 4 ? comfort : 0) + (prevCount >= 0 && count >= prevCount ? HYSTERESIS : 0);
      if (need > width) break;
    }
    used += cost;
    shown.set(s, { spec: s, width: minOf(s), glyphOnly: false });
    count++;
  }

  // spare width: the status word and NAME reach their content width first (what a row is, and
  // how it is doing), then the other columns in priority order, and a grow column takes the rest
  let spare = width - used;
  const growTo = (col: FitCol | undefined, target: number): void => {
    if (!col || col.glyphOnly || userWidth(col.spec) !== undefined) return;
    const add = wide ? target - col.width : Math.min(target - col.width, spare);
    if (add <= 0) return;
    col.width += add;
    spare -= add;
    used += add;
  };
  const targetOf = (s: ColSpec) => (s.role === "name" ? Math.max(s.min, Math.min(s.ideal, MAX_IDEAL)) : s.ideal);
  if (wide) {
    // every column at its content width; the table scrolls sideways
    for (const col of shown.values()) growTo(col, targetOf(col.spec));
  } else {
    const first = [...shown.values()].filter((c) => c.spec.role === "status" || c.spec.role === "name");
    first.sort((x, y) => (x.spec.role === "status" ? 0 : 1) - (y.spec.role === "status" ? 0 : 1));
    for (const col of first) if (spare > 0) growTo(col, targetOf(col.spec));
    for (const s of ranked) {
      if (spare <= 0) break;
      if (!s.grow && s.role !== "status") growTo(shown.get(s), s.ideal);
    }
  }
  // What is left goes to the grow column (NAME; MESSAGE on events once shown), so the table always
  // fills the pane. A width the user set on that column is its floor, not a cap: there is nothing
  // else the space could be used for.
  if (spare > 0) {
    let grow: FitCol | undefined;
    for (const col of shown.values()) if (col.spec.grow && !col.glyphOnly) grow = col;
    if (grow) {
      grow.width += spare;
      used += spare;
    }
  }

  const cols: FitCol[] = [];
  for (const s of specs) {
    const c = shown.get(s);
    if (c) cols.push(c);
  }
  return { cols, count, total: used };
}

/** Pane width from which the first `n` prioritized columns show (for tests and docs). */
export function threshold(specs: readonly ColSpec[], n: number): number {
  let lo = 0;
  let hi = 4000;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fitColumns({ specs, width: mid, wide: false, prevCount: -1 }).count >= n) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
