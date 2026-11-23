// Pure logic of agent proposals (docs/plan-features.md §2.6, §5.5): what a proposal asks for in one
// line, the typed confirmation Rust expects, the tier, the result line an approval reports, and
// the bottom-row / hub status. No stores, no DOM. Agent text is cleaned where it is shown.
import type { DevSet, EnvRow, EnvSpec, Proposal, ProposalPayload, ProposalState } from "../ipc/types";
import { cleanUntrusted } from "../ui/untrusted";
import { targetText } from "../dev/model";

/** Waiting for the human: the dialog can open (pending) or is open (reviewing). */
export const isWaiting = (p: Proposal): boolean => p.state === "pending" || p.state === "reviewing";
/** Still in flight: waiting, or approved and running its steps. */
export const isOpen = (p: Proposal): boolean => isWaiting(p) || p.state === "executing";
export const isFinal = (s: ProposalState): boolean => !["pending", "reviewing", "executing"].includes(s);

/** Well-known default ports of data services: forwarding them in a protected context is tier 2 (§5.5). */
export const WELL_KNOWN_PORTS: readonly number[] = [5432, 3306, 6379, 9092, 27017, 5672, 11211];

/** Kinds Rust treats as tier 2 by themselves (`proposals::tier2_kind`). */
export function tier2Kind(payload: ProposalPayload): boolean {
  return payload.kind === "apply" && ["roles", "rolebindings", "secrets", "serviceaccounts"].includes(payload.parsed.gvr.resource);
}

const refText = (r: { gvr: { resource: string }; namespace?: string; name: string }): string =>
  `${r.gvr.resource}/${r.namespace ? `${r.namespace}/` : ""}${r.name}`;

/** What the agent asks for, as the rest of a sentence: `start dev set orders-dev`. */
export function askText(payload: ProposalPayload, setName?: (id: string) => string | undefined): string {
  const set = (id: string) => cleanUntrusted(setName?.(id) ?? id, 60);
  switch (payload.kind) {
    case "devSetUp":
      return `start dev set ${set(payload.devSet)}${payload.exportEnv ? " and export its env" : ""}`;
    case "forward":
      return `forward ${targetText(payload.target)}:${payload.remotePort}`;
    case "envExport":
      return `export the env of ${payload.spec.workload.gvr.resource}/${payload.spec.workload.name}`;
    case "devSetDelete":
      return `delete dev set ${set(payload.devSet)}`;
    case "devSetUpdate":
      return `change dev set ${set(payload.devSet)}`;
    case "scale":
      return `scale ${refText(payload.ref)} to ${payload.replicas}`;
    case "restart":
      return `restart ${refText(payload.ref)}`;
    case "delete":
      return `delete ${refText(payload.ref)}`;
    case "reconcile":
      return `reconcile ${refText(payload.ref)}${payload.withSource ? " with its source" : ""}`;
    case "apply":
      return `apply ${payload.parsed.gvr.resource}/${payload.parsed.namespace}/${payload.parsed.name}`;
  }
}

/** The dialog title: `claude-code asks to start dev set orders-dev`. */
export function titleText(p: Proposal, setName?: (id: string) => string | undefined): string {
  return `${cleanUntrusted(p.client, 40)} asks to ${askText(p.payload, setName)}`;
}

export interface TypedInput {
  /** the effective context is protected */
  protected: boolean;
  /** secret-sourced keys the human ticked */
  includeSecrets: readonly string[];
  /** the workload the env of a devSetUp comes from */
  workload?: string;
}

/**
 * The text the human types to approve, or null: the workload name when secret keys are included,
 * else the context name when the context is protected or the kind is tier 2. The same rule as
 * Rust's `proposals::expected_typed`, which checks it again.
 */
export function expectedTyped(p: Proposal, input: TypedInput): string | null {
  if (input.includeSecrets.length > 0) {
    const workload = p.payload.kind === "envExport" ? p.payload.spec.workload.name : input.workload;
    return workload ?? p.context;
  }
  return input.protected || tier2Kind(p.payload) ? p.context : null;
}

/** Tier of the approval (agent proposals are at least tier 1, §5.5). */
export function approvalTier(p: Proposal, input: TypedInput): 1 | 2 {
  if (expectedTyped(p, input) !== null) return 2;
  if (p.payload.kind === "forward" && input.protected) {
    const port = typeof p.payload.remotePort === "number" ? p.payload.remotePort : NaN;
    if (WELL_KNOWN_PORTS.includes(port)) return 2;
  }
  return 1;
}

/** Secret-sourced keys an export of `spec` could include (the human ticks them, unticked first). */
export function exportSecretKeys(rows: readonly EnvRow[], spec: Pick<EnvSpec, "include" | "exclude">): string[] {
  return rows
    .filter((r) => r.source === "secret")
    .filter((r) => (spec.include ? spec.include.includes(r.key) : true) && !(spec.exclude ?? []).includes(r.key))
    .map((r) => r.key);
}

/** The draft the executor saves for an approved devSetUpdate: exactly the proposed content. */
export function draftOfProposed(set: DevSet) {
  return {
    id: set.id,
    name: set.name,
    context: set.context,
    forwards: set.forwards,
    rewrites: set.rewrites,
    env: set.env,
    autoStart: set.autoStart,
    connSecrets: set.connSecrets,
  };
}

type Data = Record<string, unknown>;
const obj = (v: unknown): Data | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Data) : undefined);

/** One line saying how a finished proposal ended (from Rust's result; never values). */
export function resultText(p: Proposal, setName?: (id: string) => string | undefined): string {
  const what = askText(p.payload, setName);
  const msg = p.result?.message ? cleanUntrusted(p.result.message, 200) : "";
  switch (p.state) {
    case "approved": {
      const data = obj(p.result?.data) ?? {};
      const parts: string[] = [];
      const up = obj(data.up);
      const forwards = Array.isArray(up?.forwards) ? up.forwards.length : undefined;
      if (forwards !== undefined) parts.push(`${forwards} forward${forwards === 1 ? "" : "s"} up`);
      const exp = obj(data.export);
      if (exp?.cancelled) parts.push("export cancelled");
      else if (exp?.error) parts.push("export failed");
      else if (typeof exp?.keys === "number") parts.push(`${exp.keys} keys (${String(exp.secretKeys ?? 0)} secret) written`);
      return `Approved: ${what}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
    }
    case "failed":
      return `Failed: ${what}${p.result?.error ? ` · ${cleanUntrusted(p.result.error.message, 200)}` : ""}`;
    case "rejected":
      return `Rejected: ${what}${msg ? ` · ${msg}` : ""}`;
    default:
      return `${p.state[0].toUpperCase()}${p.state.slice(1)}: ${what}${msg ? ` · ${msg}` : ""}`;
  }
}

/** The oldest proposal the human can open now (pending first, then one left in review). */
export function nextToReview(list: readonly Proposal[]): Proposal | undefined {
  return list.filter((p) => p.state === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? list.find((p) => p.state === "reviewing");
}

/** Bottom row and hub: `agent 1`, `1 waiting`. Null when nothing waits. */
export function waitingCount(list: readonly Proposal[]): number {
  return list.filter(isWaiting).length;
}

/** The `requested by` fact (§5.5): the token name and when the token was made. */
export function requestedBy(client: string, createdAt?: string): string {
  const c = cleanUntrusted(client, 40);
  const day = createdAt ? createdAt.slice(0, 10) : "";
  return day ? `${c} (token "${c}", created ${day})` : `${c} (token "${c}")`;
}

/** Proposal ids whose state changed to pending since the last list (for the arrival toast). */
export function arrivals(before: readonly Proposal[], after: readonly Proposal[]): Proposal[] {
  const seen = new Set(before.map((p) => p.id));
  return after.filter((p) => p.state === "pending" && !seen.has(p.id));
}

/** Proposals that reached a final state since the last list (for the outcome toast). */
export function finished(before: readonly Proposal[], after: readonly Proposal[]): Proposal[] {
  const was = new Map(before.map((p) => [p.id, p.state]));
  return after.filter((p) => isFinal(p.state) && was.has(p.id) && !isFinal(was.get(p.id)!));
}

/** What a devSetUpdate changes in the env export, one line each (the forward/rewrite diff is B-dev's). */
export function envChanges(before: EnvSpec | undefined, after: EnvSpec | undefined): string[] {
  const w = (e: EnvSpec) => `${e.workload.gvr.resource}/${e.workload.name}`;
  if (!before && !after) return [];
  if (!before && after) return [`+ env export of ${w(after)} (${after.format})`];
  if (before && !after) return [`- env export of ${w(before)}`];
  const a = before!;
  const b = after!;
  const out: string[] = [];
  if (w(a) !== w(b) || a.workload.namespace !== b.workload.namespace) out.push(`~ workload ${w(a)} → ${w(b)}`);
  if ((a.container ?? "") !== (b.container ?? "")) out.push(`~ container ${a.container ?? "(first)"} → ${b.container ?? "(first)"}`);
  if (a.format !== b.format) out.push(`~ format ${a.format} → ${b.format}`);
  const list = (x?: string[]) => (x && x.length ? x.join(", ") : "(all)");
  if (list(a.include) !== list(b.include)) out.push(`~ only keys ${list(a.include)} → ${list(b.include)}`);
  if ((a.exclude ?? []).join() !== (b.exclude ?? []).join()) out.push(`~ left out ${(a.exclude ?? []).join(", ") || "(none)"} → ${(b.exclude ?? []).join(", ") || "(none)"}`);
  const ov = (e: EnvSpec) => new Map((e.overrides ?? []).map((o) => [o.key, o.value]));
  const oa = ov(a);
  const ob = ov(b);
  for (const [k, v] of ob) if (oa.get(k) !== v) out.push(`~ override ${cleanUntrusted(k, 80)}=${cleanUntrusted(v, 200)}${oa.has(k) ? ` (was ${cleanUntrusted(oa.get(k)!, 200)})` : ""}`);
  for (const k of oa.keys()) if (!ob.has(k)) out.push(`- override ${cleanUntrusted(k, 80)}`);
  return out;
}
