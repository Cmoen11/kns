// The approval executor (docs/plan-features.md §2.6, §5.5): claim → dialog → approve → run each
// step through the same backend call the manual action makes, passing `proposalId`.
//
// Rust semantics (proposals.rs): `proposal_approve` stores the human's choices and the step list;
// every gated command takes owner and ticked secret keys from that record, never from its own
// arguments, and records its step. The last step (or the first failing one) ends the proposal, and
// Rust builds `result.data` itself. So this file never calls `proposalResolve(done, ok: true)`; it
// calls `proposalResolve(done, ok: false)` only for a failure before any step ran.
import { backend, contextFlags, getSettings, showOverlay, toast, toasts } from "../foundation";
import type { BackendError, DevSet, EnvReport, Gvr, Proposal } from "../ipc/types";
import { isRequestedKind, requestedSpec, runRequested } from "../actions/ops/requested";
import { refreshDevSets } from "../dev/store";
import { refreshForwards } from "../views/shell/forwards";
import { openAgentDraft, draftBlockedReason } from "./drafts";
import type { Decision, ReviewProps } from "./ProposalDialog";
import { draftOfProposed, exportSecretKeys, requestedBy, resultText, titleText } from "./proposal-model";
import { proposalById, quietOutcome, refreshProposals } from "./proposals";
import { getMcpStatus } from "./store";

export const REVIEW_OVERLAY = "agents.review";

const message = (e: unknown): string => (e as Partial<BackendError>)?.message ?? String(e);
const asError = (e: unknown): BackendError =>
  typeof e === "object" && e !== null && "message" in e ? (e as BackendError) : { code: 0, reason: "Error", message: String(e) };

let reviewing: string | null = null;
/** A dialog of this window is open for a proposal (one at a time). */
export const reviewingId = (): string | null => reviewing;

async function setOf(id: string): Promise<DevSet | undefined> {
  const sets = await backend.devSetsList().catch(() => [] as DevSet[]);
  return sets.find((s) => s.id === id);
}

async function envReport(context: string, w: { gvr: Gvr; namespace: string; name: string }, container?: string): Promise<EnvReport | null> {
  try {
    return await backend.envResolve({ context, gvr: w.gvr, namespace: w.namespace, name: w.name }, container);
  } catch {
    return null;
  }
}

/** Everything the dialog shows for `p`, loaded before it opens (sets, env report, ops spec). */
export async function reviewProps(p: Proposal): Promise<Omit<ReviewProps, "onDecide" | "onCancel">> {
  const flags = contextFlags(p.context);
  const client = getMcpStatus()?.clients.find((c) => c.name === p.client);
  const by = requestedBy(p.client, client?.createdAt);
  const base: Omit<ReviewProps, "onDecide" | "onCancel"> = {
    proposal: p,
    title: "",
    requestedBy: by,
    protected: flags.protected,
    readOnly: flags.readOnly,
    idleMinutes: getSettings().agentForwardIdleMinutes,
  };
  const pl = p.payload;
  let setName: string | undefined;
  if (pl.kind === "devSetUp" || pl.kind === "devSetDelete" || (pl.kind === "envExport" && pl.devSet)) {
    const id = pl.kind === "envExport" ? pl.devSet! : pl.devSet;
    base.set = await setOf(id);
    setName = base.set?.name;
  }
  if (pl.kind === "devSetUpdate") {
    base.set = pl.proposed;
    setName = pl.proposed.name;
  }
  const spec = pl.kind === "envExport" ? pl.spec : (pl.kind === "devSetUp" || pl.kind === "devSetUpdate") ? base.set?.env : undefined;
  if (spec) {
    const report = await envReport(p.context, spec.workload, spec.container);
    base.warnings = report?.warnings;
    base.workload = spec.workload.name;
    if (pl.kind === "envExport" || (pl.kind === "devSetUp" && pl.exportEnv)) base.exportSecrets = report ? exportSecretKeys(report.rows, spec) : [];
  }
  if (isRequestedKind(pl)) {
    const extraFacts = [{ label: "requested by", value: by }];
    base.ops = requestedSpec({ ...p, payload: pl }, { protected: flags.protected, extraFacts });
  }
  if (pl.kind === "apply") base.draftBlocked = await draftBlockedReason(p);
  base.title = titleText(p, () => setName);
  return base;
}

/**
 * Opens the review of `id`: claims it (pending → reviewing), shows the dialog, and acts on the
 * decision. Esc / "Later" puts it back to pending.
 */
export async function review(id: string): Promise<void> {
  if (reviewing) {
    toasts.error("an agent request is already open");
    return;
  }
  const known = proposalById(id);
  if (known && known.state !== "pending" && known.state !== "reviewing") {
    toast({ kind: "info", text: `That request is ${known.state}` });
    return;
  }
  let p: Proposal;
  try {
    // no dialog of this window has it open (a reload closed it): put it back, then claim it again
    if (known?.state === "reviewing") await backend.proposalUnclaim(id);
    p = await backend.proposalClaim(id);
  } catch (e) {
    toasts.error(`Cannot open the agent request: ${message(e)}`);
    void refreshProposals();
    return;
  }
  reviewing = id;
  let props: Omit<ReviewProps, "onDecide" | "onCancel">;
  try {
    props = await reviewProps(p);
  } catch (e) {
    reviewing = null;
    await backend.proposalUnclaim(id).catch(() => {});
    toasts.error(`Cannot show the agent request: ${message(e)}`);
    return;
  }
  showOverlay(REVIEW_OVERLAY, {
    ...props,
    onDecide: (d: Decision) => {
      reviewing = null;
      void decide(p, d, props);
    },
    onCancel: () => {
      reviewing = null;
      void backend.proposalUnclaim(id).catch(() => {}).finally(() => void refreshProposals());
    },
  } satisfies ReviewProps);
}

async function decide(p: Proposal, d: Decision, props: Omit<ReviewProps, "onDecide" | "onCancel">): Promise<void> {
  if (d.kind === "reject" || d.kind === "draft") {
    if (d.kind === "draft") {
      const opened = await openAgentDraft(p).catch((e: unknown) => {
        toasts.error(`Could not open the draft: ${message(e)}`);
        return false;
      });
      if (!opened) {
        await backend.proposalUnclaim(p.id).catch(() => {});
        void refreshProposals();
        return;
      }
    }
    const reason = d.kind === "draft" ? "the human opened your YAML as their own draft to edit; anything they apply is their own change" : d.reason;
    try {
      quietOutcome(p.id);
      await backend.proposalResolve(p.id, { kind: "rejected", reason });
      toast({ kind: "info", text: d.kind === "draft" ? "Draft opened; the agent was told you took it over" : `Rejected: ${p.client}'s request` });
    } catch (e) {
      toasts.error(`Could not reject: ${message(e)}`);
    }
    void refreshProposals();
    return;
  }
  let approved: Proposal;
  try {
    approved = await backend.proposalApprove(p.id, d.choices);
  } catch (e) {
    toasts.error(`Not approved: ${message(e)}`);
    void refreshProposals();
    return;
  }
  quietOutcome(p.id);
  const end = await execute(approved, props);
  void refreshProposals();
  void refreshForwards();
  void refreshDevSets();
  if (end) toast({ kind: end.state === "approved" ? "ok" : "warn", text: resultText(end, (id) => (id === props.set?.id ? props.set?.name : undefined)) });
}

/** Runs the steps of an approved proposal; returns its final state as Rust recorded it. */
export async function execute(p: Proposal, props?: Pick<ReviewProps, "set">): Promise<Proposal | null> {
  const pl = p.payload;
  const id = p.id;
  try {
    switch (pl.kind) {
      case "devSetUp": {
        try {
          await backend.devSetUp(pl.devSet, pl.hash, id);
        } catch (e) {
          // Rust ended the proposal `failed` and rolled the set back
          toasts.error(`Dev set did not start: ${message(e)}`);
          return finalState(id);
        }
        if (pl.exportEnv) {
          // forwards stay up whatever the export does (§2.6 partial failure)
          try {
            const r = await backend.envExport({ devSet: pl.devSet, rewrites: [], destination: "file", proposalId: id });
            if (r.cancelled) toast({ kind: "info", text: "Export cancelled; the forwards stay up" });
            for (const w of r.warnings ?? []) toast({ kind: "warn", text: w });
          } catch (e) {
            toasts.error(`Export failed (the forwards stay up): ${message(e)}`);
          }
        }
        break;
      }
      case "forward":
        await backend.startForward({ context: pl.context, target: pl.target, remotePort: pl.remotePort, localPort: pl.localPort, pin: pl.localPort !== undefined, proposalId: id });
        break;
      case "envExport": {
        const r = await backend.envExport({ devSet: pl.devSet, spec: pl.devSet ? undefined : pl.spec, rewrites: pl.rewrites, context: p.context, destination: "file", proposalId: id });
        if (r.cancelled) toast({ kind: "info", text: "Export cancelled" });
        for (const w of r.warnings ?? []) toast({ kind: "warn", text: w });
        break;
      }
      case "devSetDelete":
        await backend.devSetDelete(pl.devSet, id);
        break;
      case "devSetUpdate":
        await backend.devSetSave(draftOfProposed(props?.set ?? pl.proposed), id);
        break;
      case "apply":
        await backend.applyYaml(pl.context, pl.yaml, {}, id);
        break;
      default:
        if (isRequestedKind(pl)) await runRequested({ ...p, payload: pl });
    }
  } catch (e) {
    toasts.error(`${p.client}'s request failed: ${message(e)}`);
    // a failure before the gated step started (e.g. reading a Flux source): end it ourselves
    const now = await finalState(id);
    if (now && now.state === "executing") {
      await backend.proposalResolve(id, { kind: "done", ok: false, error: asError(e) }).catch(() => {});
      return finalState(id);
    }
    return now;
  }
  return finalState(id);
}

async function finalState(id: string): Promise<Proposal | null> {
  const list = await backend.proposalsList().catch(() => [] as Proposal[]);
  return list.find((x) => x.id === id) ?? null;
}

