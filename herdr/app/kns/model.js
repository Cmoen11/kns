// Resources, the live table and health: the same rules as kns-tui (src-tauri/src/tui/model.rs),
// so a row is red in the panel exactly when it is red in the terminal.

/** The tabs of the panel, in order. `label` is what the tab says. */
export const TABS = [
  { label: "Pods", group: "", version: "v1", resource: "pods", kind: "Pod", namespaced: true },
  { label: "Deploy", group: "apps", version: "v1", resource: "deployments", kind: "Deployment", namespaced: true },
  { label: "StatefulSets", group: "apps", version: "v1", resource: "statefulsets", kind: "StatefulSet", namespaced: true },
  { label: "DaemonSets", group: "apps", version: "v1", resource: "daemonsets", kind: "DaemonSet", namespaced: true },
  { label: "Services", group: "", version: "v1", resource: "services", kind: "Service", namespaced: true },
  { label: "Ingresses", group: "networking.k8s.io", version: "v1", resource: "ingresses", kind: "Ingress", namespaced: true },
  { label: "Jobs", group: "batch", version: "v1", resource: "jobs", kind: "Job", namespaced: true },
  { label: "CronJobs", group: "batch", version: "v1", resource: "cronjobs", kind: "CronJob", namespaced: true },
  { label: "ConfigMaps", group: "", version: "v1", resource: "configmaps", kind: "ConfigMap", namespaced: true },
  { label: "Secrets", group: "", version: "v1", resource: "secrets", kind: "Secret", namespaced: true },
  { label: "Nodes", group: "", version: "v1", resource: "nodes", kind: "Node", namespaced: false },
  { label: "Events", group: "", version: "v1", resource: "events", kind: "Event", namespaced: true },
];

export const WORKLOADS = ["deployments", "statefulsets", "daemonsets", "replicasets", "jobs"];

export const gvr = (r) => ({ group: r.group, version: r.version, resource: r.resource });
export const resKey = (r) => (r.group ? `${r.resource}.${r.group}` : r.resource);
export const is = (r, group, resource) => r?.group === group && r?.resource === resource;

/** A discovery entry (`discover`) as a resource, or null when it cannot be listed. */
export function fromDiscovery(v) {
  const g = v?.gvr ?? {};
  if (!g.resource || String(g.resource).includes("/")) return null;
  if (!(v.verbs ?? []).includes("list")) return null;
  return {
    label: v.kind || g.resource,
    group: g.group ?? "",
    version: g.version ?? "v1",
    resource: g.resource,
    kind: v.kind ?? "",
    namespaced: v.namespaced === true,
    short: v.shortNames ?? [],
  };
}

export function objRef(context, r, row) {
  return { context, gvr: gvr(r), namespace: row.namespace ?? null, name: row.name };
}

/** `deployment/web`, `pod/api-7d9f`. */
export function label(r, name) {
  return `${(r.kind || r.resource).toLowerCase()}/${name}`;
}

// ── table ───────────────────────────────────────────────────────────────────

/** Cell text as kns-tui shows it: no escape sequences or control characters. */
export function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(cellText).join(",");
  return String(v);
}

export function clean(text) {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b./g, "")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x1f\x7f]/g, "");
}

function row(v) {
  return {
    uid: v.uid ?? "",
    name: v.name ?? "",
    namespace: v.namespace ?? null,
    created: v.created ?? null,
    deleting: v.deleting !== undefined && v.deleting !== null,
    cells: (v.cells ?? []).map(cellText),
  };
}

/** A live table fed by `subscribe_table` events (snapshot, delta, state). */
export class Table {
  constructor() {
    this.columns = [];
    this.rows = [];
    this.index = new Map();
    this.state = "syncing";
    this.message = null;
    this.version = 0;
  }

  apply(ev) {
    switch (ev?.type) {
      case "snapshot":
        this.columns = (ev.columns ?? []).map((c, i) => ({ name: c.name ?? "", index: i, priority: c.priority ?? 0 })).filter((c) => c.priority === 0);
        this.rows = (ev.rows ?? []).map(row);
        this.reindex();
        this.version++;
        return true;
      case "delta": {
        for (const u of ev.upserts ?? []) {
          const r = row(u), i = this.index.get(r.uid);
          if (i === undefined) { this.index.set(r.uid, this.rows.length); this.rows.push(r); }
          else this.rows[i] = r;
        }
        const del = new Set(ev.deletes ?? []);
        if (del.size) { this.rows = this.rows.filter((r) => !del.has(r.uid)); this.reindex(); }
        this.version++;
        return true;
      }
      case "state":
        this.state = ev.state ?? "";
        this.message = ev.message ?? null;
        return false;
      case "disconnected":
        this.state = "reconnecting";
        this.message = "kns went away";
        return false;
      default:
        return false;
    }
  }

  reindex() {
    this.index = new Map(this.rows.map((r, i) => [r.uid, i]));
  }

  column(name) {
    const n = name.toLowerCase();
    return this.columns.find((c) => c.name.toLowerCase() === n)?.index ?? null;
  }

  cell(r, name) {
    const i = this.column(name);
    return i === null ? "" : r.cells[i] ?? "";
  }
}

// ── health ──────────────────────────────────────────────────────────────────

export const OK = 0, DONE = 1, WARN = 2, BAD = 3;

const BAD_WORDS = ["crashloop", "error", "imagepull", "errimage", "oomkilled", "failed", "evicted", "invalid", "backoff", "unknown", "notready", "lost"];
const WARN_WORDS = ["pending", "containercreating", "podinitializing", "init:", "terminating", "progressing", "suspended", "waiting"];
const DONE_WORDS = ["completed", "succeeded", "complete"];

export function statusHealth(status) {
  const s = (status ?? "").toLowerCase();
  if (!s) return OK;
  if (BAD_WORDS.some((w) => s.includes(w))) return BAD;
  if (WARN_WORDS.some((w) => s.includes(w))) return WARN;
  if (DONE_WORDS.some((w) => s.includes(w))) return DONE;
  return OK;
}

export function readyHealth(ready) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(ready ?? "");
  return m && m[1] !== m[2] ? WARN : OK;
}

export function health(table, r) {
  if (r.deleting) return WARN;
  let h = OK;
  if (table.column("Status") !== null) h = Math.max(h, statusHealth(table.cell(r, "Status")));
  if (h === DONE) return h;
  if (table.column("Ready") !== null) h = Math.max(h, readyHealth(table.cell(r, "Ready")));
  // events: warnings stand out
  if (table.column("Type") !== null && table.cell(r, "Type") === "Warning") h = Math.max(h, WARN);
  return h;
}

/** Compact age: 45s, 12m, 5h, 3d, 2y. */
export function age(created, now = Date.now()) {
  const t = Date.parse(created ?? "");
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 31536000) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 31536000)}y`;
}

/** Every space-separated word must appear in the name, namespace or a cell. */
export function matches(r, filter) {
  if (!filter) return true;
  const hay = `${r.name} ${r.namespace ?? ""} ${r.cells.join(" ")}`.toLowerCase();
  return filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** The label selector of a workload or service object (as `kubectl` would write it). */
export function selectorOf(obj) {
  const sel = obj?.spec?.selector;
  if (!sel || typeof sel !== "object") return null;
  const labels = sel.matchLabels ?? (sel.matchExpressions ? null : sel);
  const parts = Object.entries(labels ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    const vals = (e.values ?? []).join(",");
    if (e.operator === "In") parts.push(`${e.key} in (${vals})`);
    else if (e.operator === "NotIn") parts.push(`${e.key} notin (${vals})`);
    else if (e.operator === "Exists") parts.push(e.key);
    else if (e.operator === "DoesNotExist") parts.push(`!${e.key}`);
  }
  return parts.length ? parts.join(",") : null;
}

/** Flux or Argo CD will put its own version of this object back. */
export function gitopsOwner(obj) {
  const l = obj?.metadata?.labels ?? {}, a = obj?.metadata?.annotations ?? {};
  for (const [prefix, kind] of [["kustomize.toolkit.fluxcd.io", "Flux Kustomization"], ["helm.toolkit.fluxcd.io", "Flux HelmRelease"]]) {
    if (l[`${prefix}/name`] && l[`${prefix}/namespace`]) return `${kind} ${l[`${prefix}/namespace`]}/${l[`${prefix}/name`]}`;
  }
  const track = a["argocd.argoproj.io/tracking-id"];
  if (track) return `Argo CD Application ${track.split(":")[0]}`;
  if (l["argocd.argoproj.io/instance"]) return `Argo CD Application ${l["argocd.argoproj.io/instance"]}`;
  return null;
}

export function fmtCpu(milli) {
  return milli < 1000 ? `${milli}m` : (milli / 1000).toFixed(1);
}

export function fmtMem(bytes) {
  const k = 1024;
  if (bytes >= k * k * k) return `${(bytes / (k * k * k)).toFixed(1)}Gi`;
  if (bytes >= k * k) return `${Math.round(bytes / (k * k))}Mi`;
  return `${Math.round(bytes / k)}Ki`;
}

/** The conflict class of a failed apply, as the kns window classifies it. */
export function conflictOf(err) {
  if (!err || (err.code !== 409 && err.reason !== "Conflict")) return null;
  return /conflicts? with "|Apply failed with \d+ conflict/i.test(err.message ?? "") ? "fieldManager" : "version";
}

/** `.kns.toml` lines `key = "value"`. */
export function parseProject(text) {
  const out = {};
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z_]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (m && ["context", "namespace", "resource", "selector"].includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}
