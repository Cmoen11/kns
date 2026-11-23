// Rollout watch, pure part (docs/plan-features.md §3 C3): which objects can be followed and how far
// a rollout is, from the object's status. No DOM, no stores: tested in c3-model.test.ts.
import type { Json } from "../ipc/types";
import type { Gvr } from "../types";

/** How long a row stays after the action, and when a rollout with no progress counts as stalled. */
export const WATCH_MS = 5 * 60_000;
export const STALL_MS = 120_000;
export const POLL_MS = 2500;

export type RolloutAction = "workload.restart" | "workload.scale" | "flux.reconcile";
export const ROLLOUT_ACTIONS: readonly RolloutAction[] = ["workload.restart", "workload.scale", "flux.reconcile"];

const WORKLOADS = new Set(["deployments", "statefulsets", "daemonsets"]);

export const isFluxGvr = (g: Gvr): boolean => g.group.endsWith(".toolkit.fluxcd.io");

/** Objects whose rollout kns can follow: Deployments, StatefulSets, DaemonSets, Flux objects. */
export const watchable = (g: Gvr): boolean => (g.group === "apps" && WORKLOADS.has(g.resource)) || isFluxGvr(g);

export interface Progress {
  done: boolean;
  /** "2/3 updated · 1 unavailable" */
  text: string;
  /** the rollout failed by the controller's own account (ProgressDeadlineExceeded, Ready=False) */
  failed?: boolean;
}

type O = { [k: string]: Json };
const obj = (v: Json | undefined): O => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as O) : {});
const num = (v: Json | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const conds = (status: O): O[] => (Array.isArray(status.conditions) ? status.conditions.map(obj) : []);

/** Progress of a rollout from the object. `requestedAt`: the reconcile request a Flux object must handle. */
export function progressOf(g: Gvr, o: Json, requestedAt?: string): Progress {
  const root = obj(o);
  const meta = obj(root.metadata);
  const spec = obj(root.spec);
  const st = obj(root.status);
  const observed = (num(st.observedGeneration) ?? 0) >= (num(meta.generation) ?? 0);
  if (isFluxGvr(g)) {
    const ready = conds(st).find((c) => c.type === "Ready");
    const handled = !requestedAt || str(st.lastHandledReconcileAt) === requestedAt;
    if (ready?.status === "False" && handled) return { done: true, failed: true, text: `not Ready: ${str(ready.reason) || str(ready.message)}`.trim() };
    if (ready?.status === "True" && handled && observed) return { done: true, text: `Ready · ${str(st.lastAppliedRevision) || "applied"}` };
    return { done: false, text: handled ? "reconciling" : "waiting for the controller" };
  }
  if (g.resource === "daemonsets") {
    const desired = num(st.desiredNumberScheduled) ?? 0;
    const updated = num(st.updatedNumberScheduled) ?? 0;
    const available = num(st.numberAvailable) ?? 0;
    const unavailable = num(st.numberUnavailable) ?? Math.max(0, desired - available);
    const done = observed && updated === desired && available === desired;
    return { done, text: parts(`${updated}/${desired} updated`, unavailable) };
  }
  const desired = num(spec.replicas) ?? 1;
  const updated = num(st.updatedReplicas) ?? 0;
  const ready = num(st.readyReplicas) ?? 0;
  const total = num(st.replicas) ?? 0;
  if (g.resource === "statefulsets") {
    const sameRev = !st.updateRevision || st.currentRevision === st.updateRevision;
    const done = observed && ready === desired && updated === desired && sameRev;
    return { done, text: parts(`${updated}/${desired} updated`, Math.max(0, desired - ready)) };
  }
  const available = num(st.availableReplicas) ?? 0;
  const unavailable = num(st.unavailableReplicas) ?? Math.max(0, desired - available);
  const stuck = conds(st).find((c) => c.type === "Progressing" && c.status === "False");
  if (stuck) return { done: true, failed: true, text: `stuck: ${str(stuck.reason) || "Progressing=False"}` };
  const done = observed && updated === desired && total === desired && available === desired;
  const old = Math.max(0, total - updated);
  return { done, text: parts(`${updated}/${desired} updated`, unavailable, old) };
}

function parts(first: string, unavailable: number, old = 0): string {
  const p = [first];
  if (unavailable > 0) p.push(`${unavailable} unavailable`);
  if (old > 0) p.push(`${old} old`);
  return p.join(" · ");
}

export const secs = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
};

export type RowState = "progress" | "ok" | "warn" | "error";

/** The row line and its state; `lastChange`: when the progress text last changed. */
export function rowLine(p: Progress | null, startedAt: number, lastChange: number, endedAt: number | undefined, now: number): { text: string; state: RowState } {
  if (!p) return { text: "reading…", state: "progress" };
  if (p.done) return p.failed ? { text: p.text, state: "error" } : { text: `${p.text} · done in ${secs((endedAt ?? now) - startedAt)}`, state: "ok" };
  const idle = now - lastChange;
  if (idle > STALL_MS) return { text: `${p.text} · no progress for ${secs(idle)} · Enter: why`, state: "warn" };
  return { text: `${p.text} · waiting ${secs(now - startedAt)}`, state: "progress" };
}

/** The Flux reconcile request on the object (set by the reconcile patch). */
export const requestedAtOf = (o: Json): string | undefined => {
  const a = obj(obj(obj(o).metadata).annotations)["reconcile.fluxcd.io/requestedAt"];
  return typeof a === "string" ? a : undefined;
};
