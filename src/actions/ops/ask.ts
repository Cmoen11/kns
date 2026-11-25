// The ops dialog as a promise (docs/ux.md §14). One lazy overlay (OpDialog) renders every confirm
// of this feature: the tiers, the delete options, the replica field and the Flux suspend offer.
import type { Propagation } from "../../ipc/types";
import { showOverlay } from "../../foundation";
import type { Fact } from "../../ui/Dialog";

export const OPS_DIALOG = "ops.dialog";

export interface AskOptions {
  /** 1 = Enter confirms; 2 and 3 = type `typeToConfirm`; 3 adds the error glyph */
  tier: 1 | 2 | 3;
  title: string;
  body?: string;
  facts?: readonly { label: string; value: string }[];
  /** bulk: the affected objects, scrolling past 8 */
  items?: readonly string[];
  typeToConfirm?: string;
  confirmLabel: string;
  /** propagation radio and the Force checkbox */
  deleteOptions?: boolean;
  /** the replica count field; `current` prefills it */
  replicas?: { current: number | null };
  /** "will be reverted" notice; `offer` adds the suspend checkbox; `by` names the GitOps tool (default Flux) */
  flux?: { owner: string; effect: string; offer: boolean; by?: string };
  /**
   * Facts shown after `facts` (an agent proposal adds `requested by`, plan-features §5.5). Values
   * from an agent must already be cleaned (`cleanUntrusted`).
   */
  extraFacts?: readonly Fact[];
  /** the tier is raised to at least this (agent proposals are tier >= 1, §5.5) */
  minTier?: 1 | 2 | 3;
}

export interface AskResult {
  propagation?: Propagation;
  force?: boolean;
  replicas?: number;
  suspendFlux?: boolean;
}

export interface AskRequest {
  opts: AskOptions;
  resolve: (r: AskResult | null) => void;
}

/** Folds `extraFacts` into `facts` and `minTier` into `tier`, so the dialog reads one shape. Pure. */
export function withExtras(opts: AskOptions): AskOptions {
  const { extraFacts, minTier, ...rest } = opts;
  const out: AskOptions = { ...rest };
  if (extraFacts && extraFacts.length > 0) out.facts = [...(rest.facts ?? []), ...extraFacts];
  if (minTier && minTier > out.tier) out.tier = minTier;
  return out;
}

/** Opens the dialog. Resolves with the choices, or null when cancelled. */
export function ask(opts: AskOptions): Promise<AskResult | null> {
  return new Promise((resolve) => {
    const req: AskRequest = { opts: withExtras(opts), resolve };
    showOverlay(OPS_DIALOG, req);
  });
}
