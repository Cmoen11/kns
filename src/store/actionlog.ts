// The action log (Recent in the activity panel): what the human did and what happened, per
// context, newest last, persisted across restarts. Features record through `recordAction`, one small
// call; the write gate (actions/ops/write.ts report) covers every confirmed cluster write, and the
// activity tracker covers forwards, sessions and log streams without touching their features.
import { useStore } from "zustand";
import { focusedContext } from "./layout";
import { append, capContexts, emptyLog, maxId, sanitizeLog, shouldRecord, toEntry, type LogData, type LogEntry, type RecordInput } from "./actionlog-model";
import { persistedStore } from "./persist";
import { getSettings } from "./settings";

export type { LogEntry, LogState, LogTarget, RecordInput } from "./actionlog-model";

export const actionLogStore = persistedStore<LogData>({
  key: "actionlog",
  version: 1,
  defaults: emptyLog,
  sanitize: (data) => sanitizeLog(data),
});

// ids from the clock: an entry recorded before the persisted log loaded never collides with a loaded one
let seq = Date.now();
void actionLogStore.hydrated.then(() => {
  seq = Math.max(seq, maxId(actionLogStore.getState()));
});

/**
 * Records one entry in the context's log (default: the focused pane's context, the one acted on, §8.3). Honours the
 * "Action log" setting (everything / cluster writes / off). Never pass a secret value: names and
 * verbs only; error text is cleaned here. Returns the entry, or null when not recorded.
 */
export function recordAction(input: RecordInput, now = Date.now()): LogEntry | null {
  if (!shouldRecord(getSettings().actionLog, input.write ?? false)) return null;
  const context = input.context ?? focusedContext();
  if (!context) return null;
  const e = toEntry(input, ++seq, now);
  if (!e.text) return null;
  actionLogStore.setState((d) =>
    capContexts({ byContext: { ...d.byContext, [context]: append(d.byContext[context] ?? [], e) }, touched: { ...d.touched, [context]: now } }),
  );
  return e;
}

/** Empties the context's log. */
export function clearActionLog(context = focusedContext()): void {
  actionLogStore.setState((d) => {
    if (!d.byContext[context]?.length) return d;
    return { ...d, byContext: { ...d.byContext, [context]: [] } };
  });
}

const NONE: readonly LogEntry[] = [];
/** The context's entries, oldest first (a stable reference until it changes). */
export const useActionLog = (context: string | null): readonly LogEntry[] =>
  useStore(actionLogStore, (d) => (context ? (d.byContext[context] ?? NONE) : NONE));
export const actionLogOf = (context: string): readonly LogEntry[] => actionLogStore.getState().byContext[context] ?? NONE;
