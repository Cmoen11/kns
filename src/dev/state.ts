// Per-pane state of the env and devsets views, shared by the view components and the actions
// (keys and the pointer run the same handlers). Plain JSON-free runtime state: not persisted.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, engine, paneContext } from "../foundation";
import type { Dependency, EnvReport, EnvRow } from "../ipc/types";
import type { EnvView, PaneId } from "../types";
import { initialIncluded } from "./model";
import { devSetById, errorText } from "./store";

export interface EnvPane {
  /** what the report is of (a new view entry reloads) */
  for: string;
  context: string;
  report: EnvReport | null;
  error: string | null;
  included: ReadonlySet<string>;
  /** over env rows, then dependency rows */
  cursor: number;
  /** one revealed value; masked again when the cursor moves */
  revealed: { key: string; value: string } | null;
}

export interface DevSetsPane {
  cursor: number;
}

interface State {
  env: Record<PaneId, EnvPane>;
  sets: Record<PaneId, DevSetsPane>;
}

const store = createStore<State>(() => ({ env: {}, sets: {} }));
export const useEnvPane = (pane: PaneId): EnvPane | undefined => useStore(store, (s) => s.env[pane]);
export const useSetsPane = (pane: PaneId): DevSetsPane | undefined => useStore(store, (s) => s.sets[pane]);
export const envPane = (pane: PaneId): EnvPane | undefined => store.getState().env[pane];
export const setsPane = (pane: PaneId): DevSetsPane | undefined => store.getState().sets[pane];

const viewKey = (v: EnvView): string => `${v.ref.gvr.resource}/${v.ref.namespace ?? ""}/${v.ref.name}/${v.container ?? ""}/${v.devSet ?? ""}`;

function patchEnv(pane: PaneId, patch: Partial<EnvPane>): void {
  const cur = store.getState().env[pane];
  if (!cur) return;
  store.setState((s) => ({ env: { ...s.env, [pane]: { ...cur, ...patch } } }));
}

/** Loads (or reloads) the env of a pane's view. */
export async function loadEnv(pane: PaneId, view: EnvView, force = false): Promise<void> {
  // the key names the pane's context too: a pane put in another context (§8.3) never shows the old report
  const context = paneContext(pane);
  const key = `${context}\u0001${viewKey(view)}`;
  const cur = store.getState().env[pane];
  if (cur && cur.for === key && !force && cur.report) return;
  store.setState((s) => ({
    env: { ...s.env, [pane]: { for: key, context, report: cur?.for === key ? cur.report : null, error: null, included: cur?.for === key ? cur.included : new Set(), cursor: cur?.for === key ? cur.cursor : 0, revealed: null } },
  }));
  try {
    const report = await backend.envResolve({ context, gvr: view.ref.gvr, namespace: view.ref.namespace, name: view.ref.name }, view.container);
    if (store.getState().env[pane]?.for !== key) return;
    const spec = view.devSet ? devSetById(view.devSet)?.env : undefined;
    const keep = store.getState().env[pane];
    patchEnv(pane, { report, error: null, included: keep?.report ? keep.included : initialIncluded(report, spec) });
  } catch (e) {
    patchEnv(pane, { error: errorText(e) });
  }
  engine.invalidate();
}

export function forgetPane(pane: PaneId): void {
  store.setState((s) => {
    const { [pane]: _e, ...env } = s.env;
    const { [pane]: _s, ...sets } = s.sets;
    return { env, sets };
  });
}

export type EnvCursor = { type: "row"; row: EnvRow } | { type: "dep"; dep: Dependency } | null;

export function envCursor(pane: PaneId): EnvCursor {
  const p = envPane(pane);
  if (!p?.report) return null;
  const { rows, deps } = p.report;
  if (p.cursor < rows.length) return rows[p.cursor] ? { type: "row", row: rows[p.cursor] } : null;
  const dep = deps[p.cursor - rows.length];
  return dep ? { type: "dep", dep } : null;
}

export function envCount(pane: PaneId): number {
  const r = envPane(pane)?.report;
  return r ? r.rows.length + r.deps.length : 0;
}

export function setEnvCursor(pane: PaneId, index: number): void {
  const p = envPane(pane);
  const n = envCount(pane);
  if (!p || n === 0) return;
  const i = Math.min(n - 1, Math.max(0, index));
  if (i === p.cursor) return;
  patchEnv(pane, { cursor: i, revealed: null });
  engine.invalidate();
}

export function toggleKey(pane: PaneId, key: string): void {
  const p = envPane(pane);
  if (!p) return;
  const next = new Set(p.included);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  patchEnv(pane, { included: next });
}

export function setRevealed(pane: PaneId, revealed: EnvPane["revealed"]): void {
  patchEnv(pane, { revealed });
}

export function setSetsCursor(pane: PaneId, index: number, count: number): void {
  if (count === 0) return;
  const i = Math.min(count - 1, Math.max(0, index));
  const cur = store.getState().sets[pane];
  if (cur?.cursor === i) return;
  store.setState((s) => ({ sets: { ...s.sets, [pane]: { cursor: i } } }));
  engine.invalidate();
}
