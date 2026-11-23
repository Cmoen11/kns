// Recovery of agent requests a previous page left `executing` (H3, docs/plan-features.md §6.6).
//
// The proposal store lives in Rust and survives a webview reload; the executor (approve.ts) does
// not. A request approved just before a reload would stay `executing` with no one to run its
// next step, and the agent's `wait_proposal` would wait for nothing. On the first list after the
// page loads, this window has executed nothing yet, so every `executing` request belongs to a page
// that is gone: it is told "this step will not run". Rust decides what that means: `failed` when
// no step ran, `approved` with `data.<step>.error` after a finished step, and `Conflict` (left
// alone) while a step's command still runs in Rust and reports its own outcome. Rust also ends a
// stalled request on its own after 10 minutes (`proposals::EXEC_STALL`).
import type { BackendError, Proposal } from "../ipc/types";
import type { AgentsBackend } from "../ipc/contract/agents";

export const INTERRUPTED: BackendError = {
  code: 0,
  reason: "Interrupted",
  message: "kns was reloaded before the approved request finished; the rest did not run",
};

/** Requests left running by an earlier page. */
export const interrupted = (list: readonly Proposal[]): Proposal[] => list.filter((p) => p.state === "executing");

/** Ends them through Rust; returns how many Rust ended (a step still in flight is left alone). */
export async function recoverInterrupted(be: Pick<AgentsBackend, "proposalResolve">, list: readonly Proposal[]): Promise<number> {
  const results = await Promise.all(
    interrupted(list).map((p) =>
      be.proposalResolve(p.id, { kind: "done", ok: false, error: INTERRUPTED }).then(
        () => true,
        () => false,
      ),
    ),
  );
  return results.filter(Boolean).length;
}
