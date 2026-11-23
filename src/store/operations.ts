// Operations log: cluster writes in flight and recently finished (docs/requirements.md "Activity
// panel"). Fed by the one write gate (src/actions/ops/write.ts) where the result toasts are raised;
// read by the activity panel. Live state, never persisted.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type OperationState = "running" | "ok" | "error";

export interface Operation {
  id: number;
  /** what runs, e.g. "delete 3 pods"; replaced by the result line when the write reports */
  text: string;
  context: string;
  state: OperationState;
  total: number;
  /** items finished so far, failures included */
  done: number;
  failed: number;
  startedAt: number;
  endedAt?: number;
}

/** finished operations kept in the log */
export const OPERATIONS_CAP = 50;

interface OperationsState {
  /** oldest first */
  list: readonly Operation[];
}

export const operationsStore = createStore<OperationsState>(() => ({ list: [] }));
export const useOperations = <T,>(select: (s: OperationsState) => T): T => useStore(operationsStore, select);

let seq = 0;

function patch(id: number, fn: (op: Operation) => Operation): void {
  const list = operationsStore.getState().list;
  const i = list.findIndex((o) => o.id === id);
  if (i < 0) return;
  const next = [...list];
  next[i] = fn(list[i]);
  operationsStore.setState({ list: next });
}

/** A write started. Returns the id for the calls below. */
export function beginOperation(text: string, total: number, context: string, now = Date.now()): number {
  const id = ++seq;
  const all = [...operationsStore.getState().list, { id, text, context, state: "running" as const, total, done: 0, failed: 0, startedAt: now }];
  // drop the oldest finished ones beyond the cap; running ones always stay
  let extra = all.filter((o) => o.state !== "running").length - OPERATIONS_CAP;
  const list = extra > 0 ? all.filter((o) => o.state === "running" || extra-- <= 0) : all;
  operationsStore.setState({ list });
  return id;
}

/** One item of the operation finished. */
export function stepOperation(id: number, ok: boolean): void {
  patch(id, (o) => ({ ...o, done: o.done + 1, failed: o.failed + (ok ? 0 : 1) }));
}

/** Every item finished. The state follows the failures until the write reports its result line. */
export function endOperation(id: number, now = Date.now()): void {
  patch(id, (o) => (o.state === "running" ? { ...o, state: o.failed > 0 ? "error" : "ok", endedAt: now } : o));
}

/** The result line of a finished write (the same text as its toast). */
export function describeOperation(id: number, result: { state: Exclude<OperationState, "running">; text: string }, now = Date.now()): void {
  patch(id, (o) => ({ ...o, state: result.state, text: result.text, endedAt: o.endedAt ?? now }));
}

/** Clears the finished operations; the ones in flight stay. */
export function clearFinishedOperations(): void {
  const list = operationsStore.getState().list;
  const running = list.filter((o) => o.state === "running");
  if (running.length !== list.length) operationsStore.setState({ list: running });
}
