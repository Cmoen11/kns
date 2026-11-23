// What the activity panel knows beyond the features' own stores: when a session or log stream was
// first seen (their stores carry no start time) and which panes stream logs. What starts, fails
// and ends goes to the action log (Recent, store/actionlog.ts), so forwards, sessions and log
// streams are logged without touching their features. Eager and event-driven (no timers): it has
// to run while the panel is closed, or the log and the bottom-row count would miss things.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Forward } from "../ipc/types";
import { getWorkspace, layoutStore } from "../store/layout";
import { leafIds } from "../store/layout-tree";
import { clearActionLog, recordAction, type LogTarget } from "../store/actionlog";
import { clearFinishedOperations, useOperations } from "../store/operations";
import { currentView } from "../store/workspace";
import type { PaneId } from "../types";
import { crumbsOf } from "../views/registry";
import { forwardName, getForwards, subscribeForwards, useForwards } from "../views/shell/forwards";
import { forwardHost } from "../views/shell/ports";
import { getSessions, isLiveStatus, subscribeSessions, useSessions, type SessionInfo } from "../views/shell/state";

export interface LogStream {
  pane: PaneId;
  /** what is streamed: the pod, workload or selector */
  title: string;
  container: string;
  since: number;
}

interface ActivityState {
  logs: readonly LogStream[];
}

export const activityStore = createStore<ActivityState>(() => ({ logs: [] }));
export const useActivity = <T,>(select: (s: ActivityState) => T): T => useStore(activityStore, select);

/** Clears Recent (the context's action log), the finished operations included. */
export function clearFinished(): void {
  clearActionLog();
  clearFinishedOperations();
}

const POD = { group: "", version: "v1", resource: "pods" };
/** forwards that started before this page (they outlived a reload) are not logged as started */
const BOOT_AT = Date.now() - 2000;
const forwardTarget = (f: Forward): LogTarget => ({ kind: "forward", id: f.id });

// ── port-forwards: one that leaves the listing has stopped ──

let forwards: readonly Forward[] = [];
function trackForwards(): void {
  const next = getForwards();
  if (next === forwards) return;
  const ids = new Set(next.map((f) => f.id));
  const before = new Map(forwards.map((f) => [f.id, f]));
  const what = (f: Forward) => `forward ${forwardName(f)} → ${forwardHost(f)}`;
  for (const f of next) {
    // a dev set's forwards: the set's own entry says it (dev/flows.ts), not one line per forward
    if (f.devSet) continue;
    const old = before.get(f.id);
    // forwards outlive a page reload: only one started after this page loaded is "started"
    if (!old && f.startedAt < BOOT_AT) continue;
    if (!old) recordAction({ text: `${what(f)} started`, state: f.status === "error" ? "error" : "ok", error: f.status === "error" ? f.message : undefined, context: f.context, namespace: f.namespace, target: forwardTarget(f) });
    else if (f.status === "error" && old.status !== "error") recordAction({ text: `${what(f)} failed`, state: "error", error: f.message, context: f.context, namespace: f.namespace, target: forwardTarget(f) });
    else if (old.status === "error" && f.status === "active") recordAction({ text: `${what(f)} reconnected`, state: "ok", context: f.context, namespace: f.namespace, target: forwardTarget(f) });
  }
  for (const f of forwards) {
    if (!ids.has(f.id) && !f.devSet) recordAction({ text: `${what(f)} stopped`, state: "info", context: f.context, namespace: f.namespace, target: { kind: "view", view: "portforwards" } });
  }
  forwards = next;
}

// ── shell / attach sessions ──

const sessionStart = new Map<string, number>();
export const sessionStartedAt = (id: string): number | undefined => sessionStart.get(id);

let sessions: Readonly<Record<string, SessionInfo>> = {};
function trackSessions(): void {
  const next = getSessions();
  if (next === sessions) return;
  const now = Date.now();
  for (const [id, s] of Object.entries(next)) {
    const before = sessions[id];
    // a reconnect starts the clock again
    const what = `${s.kind} in ${s.pod}`;
    const target: LogTarget = { kind: "object", gvr: POD, namespace: s.namespace, name: s.pod };
    if (isLiveStatus(s.status) && (!before || !isLiveStatus(before.status))) {
      sessionStart.set(id, now);
      // the first connect, not a reconnect of the same session
      if (!before) recordAction({ text: `${what} opened`, state: "info", context: s.context, namespace: s.namespace, target });
    }
    if (before && isLiveStatus(before.status) && !isLiveStatus(s.status)) {
      if (s.status === "error") recordAction({ text: `${what} failed`, state: "error", error: s.message, context: s.context, namespace: s.namespace, target });
      else recordAction({ text: `${what} ended`, state: "info", error: undefined, context: s.context, namespace: s.namespace, target });
    }
  }
  for (const [id, s] of Object.entries(sessions)) {
    if (next[id]) continue;
    sessionStart.delete(id);
    if (isLiveStatus(s.status)) recordAction({ text: `${s.kind} in ${s.pod} closed`, state: "info", context: s.context, namespace: s.namespace, target: { kind: "object", gvr: POD, namespace: s.namespace, name: s.pod } });
  }
  sessions = next;
}

// ── log streams: the panes whose current view is logs ──

function trackLogs(): void {
  const ws = getWorkspace();
  const prev = activityStore.getState().logs;
  const byPane = new Map(prev.map((l) => [l.pane, l]));
  const next: LogStream[] = [];
  let changed = false;
  if (ws) {
    for (const pane of leafIds(ws.root)) {
      const p = ws.panes[pane];
      const view = p && currentView(p);
      if (view?.kind !== "logs") continue;
      // the last crumb is the word "logs": the one before it names the pod, workload or selector
      const crumbs = crumbsOf(view);
      const title = crumbs[Math.max(0, crumbs.length - 2)].label;
      const container = view.container === "*" ? "all containers" : view.container;
      const old = byPane.get(pane);
      if (old && old.title === title && old.container === container) next.push(old);
      else {
        next.push({ pane, title, container, since: old?.since ?? Date.now() });
        changed = true;
        if (!old && primed) {
          const ref = view.target.by === "object" ? view.target.ref : null;
          recordAction({ text: `logs of ${title} opened`, state: "info", namespace: ref?.namespace, target: ref ? { kind: "logs", gvr: ref.gvr, namespace: ref.namespace, name: ref.name } : undefined });
        }
      }
    }
  }
  const panes = new Set(next.map((l) => l.pane));
  for (const l of prev) {
    if (panes.has(l.pane)) continue;
    changed = true;
  }
  if (changed || next.length !== prev.length || next.some((l, i) => l !== prev[i])) activityStore.setState({ logs: next });
}

let started = false;
/** log panes restored with the workspace are not "opened": only the ones after it loaded */
let primed = false;
/** Called once from register(). */
export function initActivity(): void {
  if (started) return;
  started = true;
  forwards = getForwards();
  sessions = getSessions();
  subscribeForwards(trackForwards);
  subscribeSessions(trackSessions);
  layoutStore.subscribe(trackLogs);
  trackLogs();
  void layoutStore.hydrated.then(() => {
    trackLogs();
    primed = true;
  });
}

// ── counts for the badge ──

export interface LiveCounts {
  forwards: number;
  sessions: number;
  logs: number;
  operations: number;
  total: number;
  /** a broken forward: the badge shows the warn glyph */
  broken: boolean;
}

const countLive = (all: Readonly<Record<string, SessionInfo>>): number => {
  let n = 0;
  for (const s of Object.values(all)) if (isLiveStatus(s.status)) n++;
  return n;
};

/** Everything live right now. Each part is a primitive selector: a re-render only when a number changes. */
export function useLiveCounts(): LiveCounts {
  const fw = useForwards((s) => s.list.length);
  const broken = useForwards((s) => s.list.some((f) => f.status === "error"));
  const sh = useSessions(countLive);
  const logs = useActivity((s) => s.logs.length);
  const operations = useOperations((s) => s.list.reduce((n, o) => n + (o.state === "running" ? 1 : 0), 0));
  return { forwards: fw, sessions: sh, logs, operations, total: fw + sh + logs + operations, broken };
}
