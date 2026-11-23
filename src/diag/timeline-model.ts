// Pure parts of the timeline view (docs/plan-features.md §3 C2): row text, what Enter and `l`
// open for a row, and the `:timeline` argument. Rust already cleaned and redacted every `what`.
import type { LogSince, LogsView, ObjectRef, ViewState } from "../types";
import type { ObjRef, TimelineRow, TimelineSource } from "../ipc/types";

export const DEFAULT_MINUTES = 60;
export const MAX_MINUTES = 7 * 24 * 60;

export const SOURCE_LABEL: Record<TimelineSource, string> = {
  event: "event",
  replicaSet: "rollout",
  container: "pod",
  hpa: "hpa",
  flux: "flux",
  journal: "journal",
};

/** Kinds `H` works on: anything namespaced with events; pods and workloads get the most. */
export const TIMELINE_KINDS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs", "services"]);

export const toObjectRef = (r: ObjRef): ObjectRef => ({ gvr: r.gvr, namespace: r.namespace, name: r.name });

/** `:timeline`, `:timeline 180`, `:timeline 3h`, `:timeline 2d` → minutes (null: not a duration). */
export function parseSince(args: readonly string[]): number | null {
  const a = args[0]?.trim().toLowerCase();
  if (!a) return DEFAULT_MINUTES;
  const m = /^(\d{1,5})(m|h|d)?$/.exec(a);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "h" ? 60 : m[2] === "d" ? 1440 : 1);
  return n >= 1 ? Math.min(n, MAX_MINUTES) : null;
}

export const sinceLabel = (min: number): string => (min % 1440 === 0 ? `${min / 1440}d` : min % 60 === 0 ? `${min / 60}h` : `${min}m`);

/** Wider windows for the toolbar's "longer" step. */
const STEPS = [15, 60, 180, 720, 1440, 4320, MAX_MINUTES];
export function nextSince(min: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > min) ?? MAX_MINUTES;
  return [...STEPS].reverse().find((s) => s < min) ?? STEPS[0];
}

/** `10:05:12` today, else `11-21 10:05`. */
export function timeLabel(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms.slice(0, 5)}`;
}

/** Enter: describe the row's object (null: the row names none). */
export function rowTarget(row: TimelineRow | undefined): ViewState | null {
  if (!row?.ref) return null;
  return { kind: "doc", ref: toObjectRef(row.ref), format: "describe", mode: "view", managedFields: false, wrap: false };
}

const SINCES: [LogSince, number][] = [["1m", 60], ["5m", 300], ["15m", 900], ["30m", 1800], ["1h", 3600]];

/**
 * `l`: the logs of the row's pod (or of the timeline's object) around the row's time: the
 * smallest window that reaches back to it, timestamps on, and a search on the row's minute so
 * `n` lands there. Older than an hour: the tail, still searched.
 */
export function logsTarget(row: TimelineRow | undefined, base: ObjectRef, nowMs = Date.now()): LogsView | null {
  if (!row) return null;
  const pod = row.ref && row.ref.gvr.group === "" && row.ref.gvr.resource === "pods" ? toObjectRef(row.ref) : null;
  const target = pod ?? (["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "services"].includes(base.gvr.resource) ? base : null);
  if (!target) return null;
  const at = Date.parse(row.at);
  const age = Number.isNaN(at) ? Infinity : (nowMs - at) / 1000 + 30;
  const since = SINCES.find(([, s]) => s >= age)?.[0] ?? "tail";
  const minute = row.at.slice(0, 16);
  const previous = /terminated/.test(row.what) && row.source === "container";
  return {
    kind: "logs",
    target: { by: "object", ref: target },
    container: "*",
    since,
    previous,
    wrap: false,
    timestamps: true,
    filterLines: false,
    ...(minute.length === 16 ? { match: { mode: "re" as const, text: minute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } } : {}),
  };
}

/** Header count: `30 rows · 4 warnings`. */
export function countLabel(rows: readonly TimelineRow[]): string {
  const warn = rows.filter((r) => r.severity === "warn" || r.severity === "error").length;
  return `${rows.length} row${rows.length === 1 ? "" : "s"}${warn ? ` · ${warn} warning${warn === 1 ? "" : "s"}` : ""}`;
}

/** Plain text of the rows (copy). */
export function rowsText(rows: readonly TimelineRow[]): string {
  return rows.map((r) => `${r.at}  ${SOURCE_LABEL[r.source].padEnd(7)}  ${r.what}`).join("\n");
}
