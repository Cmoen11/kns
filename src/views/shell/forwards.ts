// Port-forward state (docs/ux.md §13.5): one shared listing, polled while somebody looks at it.
// Small and eager: the bottom-row indicator reads it. The manager view is a lazy chunk.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, engine, flash, recordAction, toast, toasts } from "../../foundation";
import type { BackendError, Forward, ForwardQuery } from "../../ipc/types";
import type { ObjectRef, PaneId } from "../../types";
import { forwardHost, forwardsChanged, forwardUrl, idleWarnings, newlyBroken, portKey, targetName } from "./ports";

interface ForwardsState {
  /** sorted: dev set, namespace, target, remote port */
  list: readonly Forward[];
  loaded: boolean;
  /** the last listing failed (shown in the manager, never toasted per tick) */
  error: string | null;
  /** cursor per manager pane: the forward id, and its index as the fallback when that id goes away */
  cursors: Record<PaneId, { id: string; index: number }>;
  /** dev set id -> name, for the dev-set headers (filled when a listing names an unknown set) */
  devSetNames: Readonly<Record<string, string>>;
}

const store = createStore<ForwardsState>(() => ({ list: [], loaded: false, error: null, cursors: {}, devSetNames: {} }));

export const useForwards = <T,>(select: (s: ForwardsState) => T): T => useStore(store, select);
export const getForwards = (): readonly Forward[] => store.getState().list;
export const subscribeForwards = (fn: () => void): (() => void) => store.subscribe(fn);

/** What only this window knows about a forward: when it first saw it and what it was started from. */
export interface ForwardMeta {
  at: number;
  /** e.g. "service/web": the row the forward was started on */
  origin?: string;
  /** the pod as an object reference (with uid when known), for the jump to the target */
  pod?: ObjectRef;
}
const meta = new Map<string, ForwardMeta>();
export const forwardMeta = (id: string): ForwardMeta | undefined => meta.get(id);

const errorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as BackendError).message) : String(e);

/** `svc/kafka:9094` style label of a forward (what it reaches, not the pod behind it). */
export const forwardName = (f: Forward): string => `${f.label ?? targetName(f.target)}:${f.remotePort}`;

const order = (a: Forward, b: Forward): number =>
  (a.devSet ?? "").localeCompare(b.devSet ?? "") ||
  a.namespace.localeCompare(b.namespace) ||
  targetName(a.target).localeCompare(targetName(b.target)) ||
  portKey(a.remotePort).localeCompare(portKey(b.remotePort)) ||
  a.id.localeCompare(b.id);

/** Idle-stop warnings already shown, per forward id. */
const warned = new Set<string>();

function apply(raw: Forward[]): void {
  const next = [...raw].sort(order);
  const s = store.getState();
  const now = Date.now();
  const ids = new Set<string>();
  for (const f of next) {
    ids.add(f.id);
    if (!meta.has(f.id)) meta.set(f.id, { at: f.startedAt || now });
  }
  for (const id of [...meta.keys()]) if (!ids.has(id)) meta.delete(id);
  for (const id of [...warned]) if (!ids.has(id) || next.find((f) => f.id === id)?.idleStopAt === undefined) warned.delete(id);
  // one toast per forward, on the transition to error
  for (const f of newlyBroken(s.list, next)) {
    toast({ kind: "warn", text: `Port-forward ${forwardName(f)} broke${f.message ? `: ${f.message}` : ""}` });
  }
  // §5.5: an agent-owned forward stops when idle; say so a minute before
  for (const f of idleWarnings(next, now, warned)) {
    warned.add(f.id);
    const who = f.owner.by === "agent" ? f.owner.client : "the agent";
    toast({ kind: "warn", text: `Port-forward ${forwardName(f)} (started by ${who}) stops in 1 min: no connection` });
  }
  if (!s.loaded || s.error !== null || forwardsChanged(s.list, next)) store.setState({ list: next, loaded: true, error: null });
  // pf.stop / pf.copyAddress / nav.open are enabled by "a row exists": refresh the hint row
  if ((s.list.length === 0) !== (next.length === 0)) engine.invalidate();
  void loadDevSetNames(next);
  retime();
}

/** Names of the dev sets the listing mentions; asked only when one is unknown. */
async function loadDevSetNames(list: readonly Forward[]): Promise<void> {
  const known = store.getState().devSetNames;
  if (!list.some((f) => f.devSet !== undefined && known[f.devSet] === undefined)) return;
  try {
    const sets = await backend.devSetsList();
    store.setState({ devSetNames: Object.fromEntries(sets.map((s) => [s.id, s.name])) });
  } catch {
    /* the header shows the id */
  }
}

let inflight: Promise<void> | null = null;

export function refreshForwards(): Promise<void> {
  inflight ??= backend
    .listForwards()
    .then(apply, (e: unknown) => {
      const error = errorText(e);
      if (store.getState().error !== error) store.setState({ error, loaded: true });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// a forward started or stopped elsewhere (dev set, agent proposal, idle stop) is a hint to re-list
let listening = false;
function listenForEvents(): void {
  if (listening) return;
  listening = true;
  try {
    backend.onEvent((e) => {
      if (e.type === "forwards" || e.type === "devSets") void refreshForwards();
    });
  } catch {
    /* tests without an event bus */
  }
}

// ── polling: 2s while a manager is visible, 5s while forwards exist (to notice a broken one), else off ──

const VIEW_MS = 2000;
const IDLE_MS = 5000;
let viewers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let period = 0;

function retime(): void {
  listenForEvents();
  const want = viewers > 0 ? VIEW_MS : store.getState().list.length > 0 ? IDLE_MS : 0;
  if (want === period) return;
  period = want;
  if (timer) clearInterval(timer);
  timer = want
    ? setInterval(() => {
        if (viewers === 0 && typeof document !== "undefined" && document.visibilityState === "hidden") return;
        void refreshForwards();
      }, want)
    : null;
}

/** Call while a manager view is visible; returns the release function. */
export function watchForwards(): () => void {
  viewers++;
  retime();
  void refreshForwards();
  return () => {
    viewers = Math.max(0, viewers - 1);
    retime();
  };
}

// ── mutations ──

export async function startForward(query: ForwardQuery, info: Omit<ForwardMeta, "at"> = {}): Promise<Forward> {
  let f: Forward;
  try {
    f = await backend.startForward(query);
  } catch (e) {
    // a start that fails before a forward exists (the tracker in sidepanels/activity.ts never sees it)
    const t = query.target;
    recordAction({ text: `forward ${t.kind === "pod" ? "pod" : t.kind === "service" ? "svc" : t.gvr.resource}/${t.name}:${query.remotePort} failed to start`, state: "error", error: errorText(e), context: query.context, namespace: t.namespace, target: { kind: "view", view: "portforwards" } });
    throw e;
  }
  meta.set(f.id, { at: Date.now(), ...info });
  void refreshForwards();
  return f;
}

/** The query that starts the same forward again (undo of a stop): same target, port and address, pinned. */
export function restartQuery(f: Forward): ForwardQuery {
  return {
    context: f.context,
    target: f.target,
    remotePort: f.remotePort,
    localPort: f.localPort,
    pin: true,
    address: f.address,
    label: f.label,
    devSet: f.devSet,
  };
}

/** Tier 0 (§13.5): local, no confirm, a toast with undo that starts the same forward again. */
export async function stopForward(f: Forward): Promise<void> {
  const info = meta.get(f.id);
  try {
    await backend.stopForward(f.id);
  } catch (e) {
    toasts.error(`Could not stop the port-forward: ${errorText(e)}`);
    return;
  }
  void refreshForwards();
  toast({
    kind: "ok",
    text: `Stopped port-forward ${forwardHost(f)} -> ${forwardName(f)}`,
    undo: async () => {
      try {
        await startForward(restartQuery(f), { origin: info?.origin, pod: info?.pod });
      } catch (e) {
        toasts.error(`Could not restart the port-forward: ${errorText(e)}`);
      }
    },
  });
}

/** Opens the forward in the system browser. Rust builds the URL from its own record and opens it. */
export async function openForward(f: Forward): Promise<void> {
  try {
    await backend.openForward(f.id);
    flash(`opened ${forwardUrl(f)}`);
  } catch (e) {
    toasts.error(`Could not open the browser: ${errorText(e)}`);
  }
}

// ── cursor (per manager pane) ──

export function cursorIndex(s: ForwardsState, pane: PaneId): number {
  if (s.list.length === 0) return -1;
  const c = s.cursors[pane];
  if (!c) return 0;
  const i = s.list.findIndex((f) => f.id === c.id);
  return i >= 0 ? i : Math.min(c.index, s.list.length - 1);
}

export function cursorForward(pane: PaneId): Forward | undefined {
  const s = store.getState();
  return s.list[cursorIndex(s, pane)];
}

export function setCursor(pane: PaneId, index: number): void {
  const s = store.getState();
  if (s.list.length === 0) return;
  const i = Math.min(s.list.length - 1, Math.max(0, index));
  const cur = s.cursors[pane];
  if (cur && cur.id === s.list[i].id && cur.index === i) return;
  store.setState({ cursors: { ...s.cursors, [pane]: { id: s.list[i].id, index: i } } });
}

export function moveCursor(pane: PaneId, delta: number): void {
  const s = store.getState();
  setCursor(pane, cursorIndex(s, pane) + delta);
}

export function forgetCursor(pane: PaneId): void {
  const s = store.getState();
  if (!s.cursors[pane]) return;
  const { [pane]: _gone, ...rest } = s.cursors;
  store.setState({ cursors: rest });
}
