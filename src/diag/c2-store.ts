// Traps and the journal as the UI knows them (docs/plan-features.md §3 C2): one listing each from
// Rust, re-read on boot, after our own calls and on each `trapFired` / `journal` event. Nothing
// polls. A fired trap toasts once.
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, toast } from "../foundation";
import type { JournalStatus, Trap } from "../ipc/types";
import { cleanUntrusted } from "../ui/untrusted";
import { trapTargetLabel } from "./traps-model";

interface C2State {
  traps: readonly Trap[];
  journal: JournalStatus["contexts"];
  loaded: boolean;
}

const store = createStore<C2State>(() => ({ traps: [], journal: [], loaded: false }));
export const useC2 = <T,>(select: (s: C2State) => T): T => useStore(store, select);
export const getC2 = (): C2State => store.getState();

export const errorText = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e));

export function refreshTraps(): Promise<void> {
  return backend.trapList().then(
    (traps) => store.setState({ traps, loaded: true }),
    () => store.setState({ loaded: true }),
  );
}

export function refreshJournal(): Promise<void> {
  return backend.journalStatus().then(
    (s) => store.setState({ journal: s.contexts }),
    () => undefined,
  );
}

export const journalOn = (context: string | null): boolean => !!context && getC2().journal.some((j) => j.context === context && j.on);

let started = false;
/** Called once from register(). */
export function initC2(subscribeContext: (fn: (context: string | null) => void) => void): void {
  if (started) return;
  started = true;
  void refreshTraps();
  void refreshJournal();
  // a context kns connects: Rust starts the journal watch of contexts left on (it never builds a
  // session for it), so re-read the status then
  subscribeContext(() => void refreshJournal());
  try {
    backend.onEvent((e) => {
      if (e.type === "journal") void refreshJournal();
      if (e.type === "trapFired") {
        void refreshTraps().then(() => {
          const trap = getC2().traps.find((t) => t.id === e.trapId);
          toast({ kind: "warn", text: `Trap fired on ${trap ? cleanUntrusted(trapTargetLabel(trap)) : "a pod"}: bundle ready (:traps)` });
        });
      }
    });
  } catch {
    /* tests without an event bus */
  }
}
