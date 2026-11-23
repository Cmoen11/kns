// Rollout watch (docs/plan-features.md §3 C3): after `workload.restart`, `workload.scale` or
// `flux.reconcile` succeeds, the activity panel follows each target for 5 minutes ("2/3 updated ·
// 1 unavailable · waiting 40s"), says when it is done, and warns when nothing moved for 2 minutes
// (Enter opens `:why`). The engine's `run` event fires before the confirm dialog resolves, so the
// targets are snapshotted then and rows start only when the matching operation ends ok.
// A timer runs only while a watch is active; idle, nothing is polled.
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, focusedContext, engine, focusedPane, openInContext, selectionTargets, toObjRef } from "../foundation";
import type { ObjRef, Json } from "../ipc/types";
import type { PanelRow } from "../sidepanels/model";
import { operationsStore, type Operation } from "../store/operations";
import type { ObjectRef } from "../types";
import { cleanUntrusted } from "../ui/untrusted";
import { POLL_MS, progressOf, requestedAtOf, ROLLOUT_ACTIONS, rowLine, WATCH_MS, watchable, type Progress, type RolloutAction } from "./rollout-model";

export interface Watch {
  id: string;
  ref: ObjRef;
  action: RolloutAction;
  startedAt: number;
  progress: Progress | null;
  lastText: string;
  lastChange: number;
  endedAt?: number;
  requestedAt?: string;
  error?: string;
}

interface State {
  watches: readonly Watch[];
  /** bumps on every poll so ages and "waiting Ns" re-render */
  tick: number;
}

export const rolloutStore = createStore<State>(() => ({ watches: [], tick: 0 }));
export const useRollouts = <T,>(sel: (s: State) => T): T => useStore(rolloutStore, sel);

const PENDING_MS = 3 * 60_000;
let pending: { action: RolloutAction; refs: ObjRef[]; at: number; seen: Set<number> } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

const label = (r: ObjRef) => `${r.gvr.resource.replace(/s$/, "")}/${r.name}`;

/** Start watching (also used by tests and the mock): replaces a watch of the same object. */
export function startWatches(action: RolloutAction, refs: readonly ObjRef[], now = Date.now()): void {
  if (!refs.length) return;
  const keep = rolloutStore.getState().watches.filter((w) => !refs.some((r) => same(r, w.ref)));
  const fresh = refs.map((ref): Watch => ({ id: `r${++seq}`, ref, action, startedAt: now, progress: null, lastText: "", lastChange: now }));
  rolloutStore.setState({ watches: [...keep, ...fresh] });
  schedule(0);
}

const same = (a: ObjRef, b: ObjRef) => a.context === b.context && a.gvr.group === b.gvr.group && a.gvr.resource === b.gvr.resource && a.namespace === b.namespace && a.name === b.name;

export function dismissWatch(id: string): void {
  rolloutStore.setState((s) => ({ watches: s.watches.filter((w) => w.id !== id) }));
}

export function clearFinishedWatches(): void {
  rolloutStore.setState((s) => ({ watches: s.watches.filter((w) => !w.progress?.done) }));
}

function schedule(ms: number): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void poll();
  }, ms);
}

async function poll(): Promise<void> {
  const now = Date.now();
  const live = rolloutStore.getState().watches.filter((w) => now - w.startedAt < WATCH_MS);
  if (live.length !== rolloutStore.getState().watches.length) rolloutStore.setState({ watches: live });
  if (!live.length) return;
  const updates = await Promise.all(
    live.map(async (w): Promise<Watch> => {
      if (w.progress?.done) return w;
      try {
        const o: Json = await backend.getJson(w.ref);
        const requestedAt = w.requestedAt ?? requestedAtOf(o);
        const p = progressOf(w.ref.gvr, o, w.action === "flux.reconcile" ? requestedAt : undefined);
        const t = Date.now();
        const changed = p.text !== w.lastText;
        return { ...w, requestedAt, progress: p, lastText: p.text, lastChange: changed ? t : w.lastChange, endedAt: p.done ? t : undefined, error: undefined };
      } catch (e) {
        return { ...w, error: e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e) };
      }
    }),
  );
  const byId = new Map(updates.map((w) => [w.id, w]));
  // watches dismissed or replaced while the reads ran stay gone
  const watches = rolloutStore.getState().watches.map((w) => byId.get(w.id) ?? w).filter((w) => byId.has(w.id) || Date.now() - w.startedAt < WATCH_MS);
  rolloutStore.setState((s) => ({ watches, tick: s.tick + 1 }));
  if (watches.length) schedule(POLL_MS);
}

// ── wiring: action run → operation ok → watch ─────────────────────────────────

function onOperations(list: readonly Operation[]): void {
  const p = pending;
  if (!p) return;
  if (Date.now() - p.at > PENDING_MS) {
    pending = null;
    return;
  }
  for (const op of list) {
    if (op.startedAt < p.at - 1000 || p.seen.has(op.id) || op.state === "running") continue;
    p.seen.add(op.id);
    pending = null;
    if (op.state === "ok" || op.failed < op.total) startWatches(p.action, p.refs);
    return;
  }
}

let installed = false;

/** Called once from register(): listens for the three actions and for their operations. */
export function installRolloutWatch(): void {
  if (installed) return;
  installed = true;
  engine.on((e) => {
    if (e.type !== "run" || !(ROLLOUT_ACTIONS as readonly string[]).includes(e.id)) return;
    const pane = focusedPane();
    const context = focusedContext();
    if (!pane || !context) return;
    const refs = selectionTargets(pane)
      .filter((r: ObjectRef) => watchable(r.gvr))
      .map((r: ObjectRef) => toObjRef(r, context));
    pending = refs.length ? { action: e.id as RolloutAction, refs, at: Date.now(), seen: new Set(operationsStore.getState().list.map((o) => o.id)) } : null;
  });
  operationsStore.subscribe((s) => onOperations(s.list));
}

// ── activity panel rows and tool status ──────────────────────────────────────

const VERB: Record<RolloutAction, string> = { "workload.restart": "restart", "workload.scale": "scale", "flux.reconcile": "reconcile" };
const GLYPH = { progress: "progress", ok: "ok", warn: "warn", error: "error" } as const;

export function useRolloutRows(): { rows: PanelRow[]; clear?: () => void } {
  const watches = useRollouts((s) => s.watches);
  const tick = useRollouts((s) => s.tick);
  return useMemo(() => {
    void tick;
    const now = Date.now();
    const rows = watches.map((w): PanelRow => {
      const line = w.error ? { text: `cannot read: ${w.error}`, state: "warn" as const } : rowLine(w.progress, w.startedAt, w.lastChange, w.endedAt, now);
      const name = cleanUntrusted(label(w.ref));
      return {
        key: `rollout:${w.id}`,
        section: "rollouts",
        label: `${VERB[w.action]} ${name}`,
        detail: cleanUntrusted(line.text),
        glyph: GLYPH[line.state],
        since: w.startedAt,
        activate: () => {
          openInContext({ kind: "why", ref: { gvr: w.ref.gvr, namespace: w.ref.namespace, name: w.ref.name } }, w.ref.context);
          return true;
        },
        stop: () => dismissWatch(w.id),
      };
    });
    return { rows, clear: watches.some((w) => w.progress?.done) ? clearFinishedWatches : undefined };
  }, [watches, tick]);
}

export function rolloutStatus(watches: readonly Watch[]): { text: string; state: "active" | "warn" | "ok" } | null {
  if (!watches.length) return null;
  const running = watches.filter((w) => !w.progress?.done).length;
  const failed = watches.filter((w) => w.progress?.failed).length;
  if (failed) return { text: `${failed} failed`, state: "warn" };
  if (running) return { text: `${running} running`, state: "active" };
  return { text: `${watches.length} done`, state: "ok" };
}
