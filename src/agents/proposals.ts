// Live list of agent proposals (docs/plan-features.md §5.5): fetched once at boot, then again on
// every `proposals` backend event (events are hints, not state). New pending proposals raise a
// toast; nothing opens by itself and nothing takes focus. No timers.
import { useSyncExternalStore } from "react";
import { backend, recordAction, toast } from "../foundation";
import type { Proposal } from "../ipc/types";
import { devSetById } from "../dev/store";
import { cleanUntrusted } from "../ui/untrusted";
import { arrivals, askText, finished, isOpen, resultText } from "./proposal-model";
import { recoverInterrupted } from "./recover";

type Listener = () => void;
let list: readonly Proposal[] = [];
const subs = new Set<Listener>();
let started = false;
let inflight: Promise<void> | null = null;
let again = false;
let recovered = false;
/** proposals this window reviewed: their outcome is toasted (the dialog's own action already said "approved") */
const quiet = new Set<string>();

function set(next: readonly Proposal[]): void {
  list = next;
  for (const fn of [...subs]) fn();
}

const setName = (id: string): string | undefined => devSetById(id)?.name;

/** Re-lists (coalesced: one request in flight, one queued). */
export function refreshProposals(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = backend
    .proposalsList()
    .then(async (next) => {
      if (!recovered) {
        // the first list of this page: requests still `executing` were left by an earlier page
        // (recover.ts); the queued re-list shows how Rust ended them, with the usual toast
        recovered = true;
        if ((await recoverInterrupted(backend, next)) > 0) again = true;
      }
      for (const p of arrivals(list, next)) {
        toast({ kind: "warn", text: `${cleanUntrusted(p.client, 40)} asks to ${askText(p.payload, setName)} · leader y or "agent" in the bottom row to review` });
      }
      for (const p of finished(list, next)) {
        // the action log: every outcome, also the ones this window reviewed (text built from Rust's result, never values)
        recordAction({ text: `${cleanUntrusted(p.client, 40)}: ${resultText(p, setName)}`, state: p.state === "approved" ? "ok" : p.state === "failed" ? "error" : "info", context: p.context, write: p.state === "approved", target: { kind: "view", view: "agents" } });
        if (quiet.delete(p.id)) continue;
        toast({ kind: p.state === "approved" ? "ok" : "info", text: resultText(p, setName) });
      }
      set(next);
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
      if (again) {
        again = false;
        void refreshProposals();
      }
    });
  return inflight;
}

/** The outcome of `id` is reported by the executor, not by the list toast. */
export const quietOutcome = (id: string): void => void quiet.add(id);

export function startProposals(): void {
  if (started) return;
  started = true;
  backend.onEvent((e) => {
    if (e.type === "proposals") void refreshProposals();
  });
  void refreshProposals();
}

export const getProposals = (): readonly Proposal[] => list;
export const proposalById = (id: string): Proposal | undefined => list.find((p) => p.id === id);
export const subscribeProposals = (fn: Listener): (() => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useProposals = (): readonly Proposal[] => useSyncExternalStore(subscribeProposals, getProposals);
export const openProposals = (): Proposal[] => list.filter(isOpen);
