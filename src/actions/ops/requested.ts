// Agent-requested writes (docs/plan-features.md §3 H2, §5.5): scale, restart, delete and reconcile
// that an agent proposed. What the human sees is the manual action's confirm with `extraFacts`
// (requested by, the agent's unverified note) and `minTier: 1`, so a tier-0 write like restart
// still gets a real dialog; the run passes `proposalId` to the same backend call the manual action
// makes, and Rust gates it against the approved payload.
//
// The typed confirmation on a protected context is the context name, what Rust checks
// (`proposals::expected_typed`); the manual dialog types the object name there.
import type { ObjRef, Proposal } from "../../ipc/types";
import { backend } from "../../foundation";
import type { Fact } from "../../ui/Dialog";
import { reconcilePatch, sourceRefOf } from "./flux";
import { resolveFlux } from "./targets";
import { deleteTier, effectiveTier, type Tier } from "./tiers";

export type RequestedKind = "scale" | "restart" | "delete" | "reconcile";
type RequestedPayload = Extract<Proposal["payload"], { kind: RequestedKind }>;

export interface RequestedSpec {
  title: string;
  body: string;
  facts: Fact[];
  tier: Tier;
  /** what to type (tier 2+): the context name, as Rust checks it */
  typeToConfirm?: string;
  confirmLabel: string;
}

export const isRequestedKind = (p: Proposal["payload"]): p is RequestedPayload =>
  p.kind === "scale" || p.kind === "restart" || p.kind === "delete" || p.kind === "reconcile";

const VERB: Record<RequestedKind, { base: Tier; label: string; body: (p: RequestedPayload) => string }> = {
  scale: { base: 0, label: "Scale", body: (p) => `Set replicas to ${(p as Extract<RequestedPayload, { kind: "scale" }>).replicas}. Flux puts it back if the count is in Git.` },
  restart: { base: 0, label: "Restart", body: () => "Rolls out new pods one by one, like kubectl rollout restart." },
  delete: { base: 1, label: "Delete", body: () => "The object is deleted; a controller may create it again." },
  reconcile: {
    base: 0,
    label: "Reconcile",
    body: (p) => ((p as Extract<RequestedPayload, { kind: "reconcile" }>).withSource ? "Flux fetches the source, then reconciles the object." : "Flux reconciles the object now."),
  },
};

/**
 * The confirm of an agent-requested write (pure). `extraFacts` come after the object facts, the
 * tier is at least 1 and 2 on a protected context.
 */
export function requestedSpec(p: Proposal & { payload: RequestedPayload }, opts: { protected: boolean; extraFacts: readonly Fact[] }): RequestedSpec {
  const v = VERB[p.payload.kind];
  const ref = p.payload.ref;
  const base = p.payload.kind === "delete" ? deleteTier(ref.gvr.resource, ref.gvr.group) : v.base;
  const tier = effectiveTier(base, { protected: opts.protected, minTier: 1 });
  const facts: Fact[] = [
    { label: "kind", value: ref.gvr.resource },
    { label: "name", value: ref.name },
    ...(ref.namespace ? [{ label: "namespace", value: ref.namespace }] : []),
    { label: "context", value: ref.context },
    ...opts.extraFacts,
  ];
  return {
    title: `${v.label} ${ref.gvr.resource}/${ref.name}`,
    body: v.body(p.payload),
    facts,
    tier,
    // Rust requires the context name on a protected context; a tier-2 delete elsewhere types the
    // object name like the manual delete (a UI guard Rust does not check)
    typeToConfirm: opts.protected ? p.context : tier >= 2 ? ref.name : undefined,
    confirmLabel: v.label,
  };
}

/** Runs the approved write with `proposalId` (Rust gates it). Reconcile with source patches the
 * source first without the id (it is not part of the gated step), then the object with it. */
export async function runRequested(p: Proposal & { payload: RequestedPayload }): Promise<void> {
  const ref: ObjRef = p.payload.ref;
  switch (p.payload.kind) {
    case "scale":
      return backend.scale(ref, p.payload.replicas, p.id);
    case "restart":
      return backend.restart(ref, p.id);
    case "delete":
      return backend.deleteObject(ref, {}, p.id);
    case "reconcile": {
      if (p.payload.withSource) {
        const src = sourceRefOf(await backend.getJson(ref));
        const srcRef = src && resolveFlux(src, ref.context);
        if (srcRef) await backend.patchObject(srcRef, reconcilePatch(new Date()), "merge");
      }
      return backend.patchObject(ref, reconcilePatch(new Date()), "merge", undefined, p.id);
    }
  }
}
