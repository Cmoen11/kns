// Status derivation for the STATUS cell (docs/ux.md §9.4, §9.5): glyph state + word, from the
// row's Status / Ready cells and its deletion timestamp. Pure: only table cells cross IPC, so this
// is an approximation of research §6.5 (the "transient turns warn after 60s" rule uses the row's
// age, the only clock a table row carries).

export type StatusState = "ok" | "progress" | "warn" | "error" | "suspended" | "done" | "terminating" | "unknown" | "none";

export interface Status {
  state: StatusState;
  /** untrusted text when it comes from a cell */
  word: string;
}

export interface StatusInput {
  /** plural resource name; "containers" for the containers view */
  resource: string;
  /** a Flux kind (*.toolkit.fluxcd.io) */
  flux?: boolean;
  /** lowercased column name -> cell text */
  get: (column: string) => string | undefined;
  deleting?: boolean;
  /** seconds since creation, null when unknown */
  ageSec: number | null;
}

const TRANSIENT_WARN_AFTER = 60;
const RESTART_WARN = 5;

const OK_WORDS = new Set(["running", "ready", "active", "bound", "available", "healthy", "established", "true"]);
const DONE_WORDS = new Set(["completed", "complete", "succeeded"]);
const PROGRESS_WORDS = new Set([
  "pending", "containercreating", "podinitializing", "creating", "progressing", "reconciling", "waiting", "provisioning",
  "starting", "updating", "installing", "upgrading",
]);
const WARN_WORDS = new Set(["released", "schedulingdisabled", "warning", "degraded"]);
const ERROR_RE = /error|backoff|failed|^err|oomkilled|evicted|invalid|lost|deadlineexceeded|notready|unavailable|^false$|containerstatusunknown|cannotrun/i;

/** Parses `2/3` -> [2, 3]. */
export function parseRatio(text: string | undefined): [number, number] | null {
  if (!text) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The leading integer of `5 (2m ago)`. */
export function leadingInt(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^\s*(-?\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

const young = (ageSec: number | null) => ageSec !== null && ageSec < TRANSIENT_WARN_AFTER;

/** Classifies a bare status word (phase, condition reason, container state). */
export function classifyWord(word: string, ageSec: number | null = null): StatusState {
  const w = word.trim().toLowerCase();
  if (!w || w === "<none>" || w === "<unknown>" || w === "unknown") return "unknown";
  if (w === "terminating") return "terminating";
  if (w === "suspended") return "suspended";
  if (DONE_WORDS.has(w)) return "done";
  if (WARN_WORDS.has(w)) return "warn";
  if (ERROR_RE.test(w)) return "error";
  if (OK_WORDS.has(w)) return "ok";
  // Init:1/2, PodInitializing, ContainerCreating ...: in transit, a warning once it drags on
  if (PROGRESS_WORDS.has(w) || w.startsWith("init:") || w.startsWith("signal:")) return young(ageSec) || ageSec === null ? "progress" : "warn";
  return "unknown";
}

function replicas(ready: number, desired: number, ageSec: number | null): Status {
  if (desired === 0) return { state: "done", word: "Scaled to 0" };
  if (ready >= desired) return { state: "ok", word: "Ready" };
  if (young(ageSec)) return { state: "progress", word: "Starting" };
  return ready === 0 ? { state: "error", word: "Unavailable" } : { state: "warn", word: "Degraded" };
}

function podLike(word: string, ready: string | undefined, restarts: string | undefined, ageSec: number | null): Status {
  let state = classifyWord(word, ageSec);
  if (state === "ok") {
    const r = parseRatio(ready);
    if (r && r[0] < r[1]) state = young(ageSec) ? "progress" : r[0] === 0 ? "error" : "warn";
    else if ((leadingInt(restarts) ?? 0) >= RESTART_WARN) state = "warn";
  }
  return { state, word };
}

const truthy = (v: string | undefined) => v !== undefined && v.trim().toLowerCase() === "true";

/**
 * An Argo CD Application from its HEALTH STATUS and SYNC STATUS cells: health decides first
 * (Degraded and Missing are errors), then a healthy app that is OutOfSync (or whose comparison
 * failed, sync Unknown) is a warning. Progressing stays in progress: an app's age says nothing
 * about how long its rollout has run.
 */
export function argoStatus(health: string, sync: string): Status {
  const h = health.trim();
  const s = sync.trim();
  switch (h.toLowerCase()) {
    case "degraded":
    case "missing":
      return { state: "error", word: h };
    case "suspended":
      return { state: "suspended", word: h };
    case "progressing":
      return { state: "progress", word: h };
  }
  if (s.toLowerCase() === "outofsync") return { state: "warn", word: "OutOfSync" };
  if (s.toLowerCase() === "unknown" || s === "") return { state: "warn", word: "Sync unknown" };
  if (h.toLowerCase() === "healthy") return { state: "ok", word: "Healthy" };
  return { state: "unknown", word: h || "Unknown" };
}

/** null = the kind has no status: no glyph and no status column. */
export function deriveStatus(i: StatusInput): Status | null {
  const { get, ageSec } = i;
  if (i.deleting) return { state: "terminating", word: "Terminating" };

  if (i.flux) {
    if (truthy(get("suspended"))) return { state: "suspended", word: "Suspended" };
    const ready = get("ready");
    if (ready === undefined) return null;
    const r = ready.trim().toLowerCase();
    if (r === "true") return { state: "ok", word: "Ready" };
    if (r === "false") return { state: "error", word: "Not ready" };
    return { state: "progress", word: "Reconciling" };
  }

  switch (i.resource) {
    case "pods":
      return podLike(get("status") ?? "Unknown", get("ready"), get("restarts"), ageSec);
    case "containers":
      return podLike(get("state") ?? "Unknown", truthy(get("ready")) ? "1/1" : get("state")?.toLowerCase() === "running" ? "0/1" : undefined, get("restarts"), ageSec);
    case "deployments":
    case "statefulsets": {
      const r = parseRatio(get("ready"));
      return r ? replicas(r[0], r[1], ageSec) : null;
    }
    case "daemonsets":
    case "replicasets": {
      const desired = leadingInt(get("desired"));
      const ready = leadingInt(get("ready"));
      return desired !== null && ready !== null ? replicas(ready, desired, ageSec) : null;
    }
    case "jobs": {
      const s = get("status");
      if (s) return { state: s.trim().toLowerCase() === "running" ? "progress" : classifyWord(s), word: s };
      const c = parseRatio(get("completions"));
      if (!c) return null;
      return c[0] >= c[1] ? { state: "done", word: "Complete" } : { state: "progress", word: "Running" };
    }
    case "cronjobs":
      return truthy(get("suspend")) ? { state: "suspended", word: "Suspended" } : { state: "ok", word: "Scheduled" };
    case "events": {
      const t = get("type");
      if (t === undefined) return null;
      return { state: t.trim().toLowerCase() === "warning" ? "warn" : "none", word: t };
    }
    case "nodes": {
      const s = get("status");
      if (s === undefined) return null;
      const parts = s.toLowerCase().split(",");
      if (parts.includes("notready")) return { state: "error", word: s };
      if (parts.includes("schedulingdisabled")) return { state: "warn", word: s };
      return { state: parts.includes("ready") ? "ok" : "unknown", word: s };
    }
    default: {
      const health = get("health status");
      const sync = get("sync status");
      if (health !== undefined && sync !== undefined) return argoStatus(health, sync);
      const s = get("status") ?? get("phase") ?? get("state");
      if (s !== undefined) return { state: classifyWord(s, ageSec), word: s };
      return null;
    }
  }
}

/** FAULTS (`!`): rows that need a person. */
export const isFault = (s: Status | null): boolean => s !== null && (s.state === "warn" || s.state === "error");
