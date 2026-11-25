// The one gate every cluster write of this feature goes through (docs/ux.md §14): read-only
// refusal, the confirm tier (raised on protected contexts), bulk execution and the result toast.
// Undo closures are writes too and come back through the same gate.
import type { ObjRef } from "../../ipc/types";
import { backend, toast } from "../../foundation";
import { recordAction } from "../../store/actionlog";
import { beginOperation, describeOperation, endOperation, stepOperation } from "../../store/operations";
import { contextFlags } from "../../store/settings";
import { ask, type AskOptions, type AskResult } from "./ask";
import { errorText, plural, runBulk, summarize, type ItemResult } from "./bulk";
import { argoOwnerText, type ArgoRef } from "./argo";
import { fluxOwnerText, suspendPatch, type FluxRef } from "./flux";
import { pathOf, resolveFlux, targetsFor, type Targets } from "./targets";
import { confirmText, dependentsNote, effectiveTier, type Tier } from "./tiers";

export interface ConfirmSpec {
  /** imperative, lowercase; also the word typed for bulk: `restart 3` */
  verb: string;
  /** tier on an ordinary context */
  tier: Tier;
  confirmLabel?: string;
  body?: string;
  isDelete?: boolean;
  deleteOptions?: boolean;
  replicas?: { current: number | null };
  /** the Flux object managing the (single) target, and what Flux will do to this change */
  flux?: { owner: FluxRef; effect: string } | null;
  /** the Argo CD Application managing the (single) target (no suspend offer: it may be out of reach) */
  argo?: { owner: ArgoRef; effect: string } | null;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Asks what §14 requires for this write. Resolves {} with no dialog on tier 0, the dialog's
 * choices when confirmed, and null when cancelled or refused (read-only).
 */
export async function confirmWrite(t: Targets, spec: ConfirmSpec): Promise<AskResult | null> {
  if (contextFlags(t.context).readOnly) {
    toast({ kind: "warn", text: `${t.context} is read-only` });
    return null;
  }
  const single = t.items.length === 1;
  const fluxTarget = spec.flux ? resolveFlux(spec.flux.owner, t.context) : null;
  let tier = effectiveTier(spec.tier, { protected: t.protected, bulkDelete: !!spec.isDelete && !single });
  // the replica field and the Flux notice need a dialog even when the tier needs none
  if (tier === 0 && (spec.replicas || spec.flux || spec.argo)) tier = 1;
  if (tier === 0) return {};

  const facts: { label: string; value: string }[] = single
    ? [
        { label: "kind", value: t.kind },
        { label: "name", value: t.items[0].name },
        ...(t.items[0].namespace ? [{ label: "namespace", value: t.items[0].namespace }] : []),
      ]
    : [
        { label: "kind", value: t.kind },
        { label: "count", value: String(t.items.length) },
      ];
  facts.push({ label: "context", value: t.protected ? `${t.context}  PROTECTED` : t.context });

  const opts: AskOptions = {
    tier: tier as 1 | 2 | 3,
    title: single ? `${cap(spec.verb)} ${t.noun}` : `${cap(spec.verb)} ${t.items.length} ${plural(t.noun)}`,
    body: [spec.body, tier === 3 && single ? dependentsNote(t.resource) : undefined].filter(Boolean).join(" ") || undefined,
    facts,
    items: single ? undefined : t.items.map(pathOf),
    typeToConfirm: tier >= 2 ? confirmText(spec.verb, t.items.map((i) => i.name)) : undefined,
    confirmLabel: spec.confirmLabel ?? cap(spec.verb),
    deleteOptions: spec.deleteOptions,
    replicas: spec.replicas,
    flux: spec.flux
      ? { owner: fluxOwnerText(spec.flux.owner), effect: spec.flux.effect, offer: fluxTarget !== null }
      : spec.argo
        ? { owner: argoOwnerText(spec.argo.owner), effect: spec.argo.effect, offer: false, by: "Argo CD" }
        : undefined,
  };
  const answer = await ask(opts);
  if (!answer) return null;
  if (answer.suspendFlux && fluxTarget) {
    // the offer of research.md §5.9: without it Flux puts the old state back
    try {
      await backend.patchObject(fluxTarget, suspendPatch(true), "merge");
      toast({
        kind: "ok",
        text: `Suspended ${fluxOwnerText(spec.flux!.owner)}`,
        undo: () => setSuspended(fluxTarget, false),
        undoLabel: "resume",
      });
    } catch (e) {
      toast({ kind: "error", text: `Could not suspend ${fluxOwnerText(spec.flux!.owner)}: ${errorText(e)}. Nothing was changed.` });
      return null;
    }
  }
  return answer;
}

/** the operations-log entry of a result list, so report() can put the result line on it */
const operationOf = new WeakMap<readonly ItemResult<ObjRef, unknown>[], number>();
/** the imperative verb of a result list ("scale"), for the action log's failure line */
const verbOf = new WeakMap<readonly ItemResult<ObjRef, unknown>[], string>();

/**
 * Runs `fn` on every target (6 at a time) and returns one result per item. The run shows in the
 * operations log (activity panel) while it is in flight; `read` keeps a read-only pass out of it.
 */
export async function runOn<R>(t: Targets, fn: (ref: ObjRef) => Promise<R>, opts: { verb?: string; read?: boolean } = {}): Promise<ItemResult<ObjRef, R>[]> {
  if (opts.read) return runBulk(t.items, fn);
  const what = t.items.length === 1 ? `${t.noun} ${t.items[0].name}` : `${t.items.length} ${plural(t.noun)}`;
  const op = beginOperation(opts.verb ? `${opts.verb} ${what}` : what, t.items.length, t.context);
  const results = await runBulk(t.items, async (ref) => {
    try {
      const value = await fn(ref);
      stepOperation(op, true);
      return value;
    } catch (e) {
      stepOperation(op, false);
      throw e;
    }
  });
  endOperation(op);
  operationOf.set(results, op);
  if (opts.verb) verbOf.set(results, opts.verb);
  return results;
}

/** The result toast: one line, failures listed per item; `undo` only when something succeeded. */
export function report(
  done: string,
  t: Targets,
  results: readonly ItemResult<ObjRef, unknown>[],
  opts: { detail?: string; undo?: () => void | Promise<void>; undoLabel?: string; logText?: string } = {},
): void {
  const s = summarize(done, t.noun, results, (r) => r.name, opts.detail);
  const undo = s.done > 0 ? opts.undo : undefined;
  const op = operationOf.get(results);
  if (op !== undefined) describeOperation(op, { state: s.kind, text: s.text });
  logWrite(done, t, results, s, opts.logText);
  if (s.kind === "error") {
    toast({ kind: "error", text: s.text });
    // an error toast is sticky and has no action: the undo of the part that worked gets its own
    if (undo) toast({ kind: "info", text: `${done} ${s.done} of ${results.length}`, undo, undoLabel: opts.undoLabel });
  } else {
    toast({ kind: "ok", text: s.text, undo, undoLabel: opts.undoLabel });
  }
}

/**
 * The action log entry of a reported write (Recent, store/actionlog.ts): one line in lowercase,
 * the object as the jump target when there is one, the first failure as the error. Names and
 * verbs only, never a payload.
 */
function logWrite(done: string, t: Targets, results: readonly ItemResult<ObjRef, unknown>[], s: { kind: "ok" | "error"; done: number }, logText?: string): void {
  const single = t.items.length === 1 ? t.items[0] : null;
  const namespaces = [...new Set(t.items.map((i) => i.namespace).filter((n): n is string => !!n))];
  const failed = results.find((r) => !r.ok);
  const verb = done.charAt(0).toLowerCase() + done.slice(1);
  const text = logText ?? (single ? `${verb} ${t.noun} ${single.name}` : `${verb} ${s.kind === "error" ? `${s.done} of ${t.items.length}` : t.items.length} ${plural(t.noun)}`);
  recordAction({
    text: s.kind === "error" && single ? `${verbOf.get(results) ?? verb} ${t.noun} ${single.name} failed` : text,
    state: s.kind,
    error: failed ? errorText(failed.error) : undefined,
    namespace: namespaces.length === 1 ? namespaces[0] : undefined,
    write: true,
    context: t.context,
    target: single ? { kind: "object", gvr: single.gvr, namespace: single.namespace, name: single.name } : namespaces.length === 1 ? { kind: "namespace", namespace: namespaces[0] } : undefined,
  });
}

/**
 * An undo that is itself a confirmed write: on a protected context `Ctrl/⌘+Z` opens the same
 * tier 2 dialog (§14). `items` are the objects the first write actually changed.
 */
export function undoWrite(
  t: Targets,
  items: readonly ObjRef[],
  spec: { verb: string; done: string; detail?: string },
  fn: (ref: ObjRef) => Promise<unknown>,
): () => Promise<void> {
  return async () => {
    const back: Targets = { ...t, items: [...items], protected: contextFlags(t.context).protected };
    if (!(await confirmWrite(back, { verb: spec.verb, tier: 0 }))) return;
    report(spec.done, back, await runOn(back, fn, { verb: spec.verb }), { detail: spec.detail });
  };
}

/** Suspend or resume one object, as a gated write with a result toast (the Flux offer's undo). */
export async function setSuspended(ref: ObjRef, suspend: boolean): Promise<void> {
  const t = targetsFor(ref);
  if (!(await confirmWrite(t, { verb: suspend ? "suspend" : "resume", tier: 0 }))) return;
  report(suspend ? "Suspended" : "Resumed", t, await runOn(t, (r) => backend.patchObject(r, suspendPatch(suspend), "merge"), { verb: suspend ? "suspend" : "resume" }));
}

/** A failed read before a write (getJson): never silent, 403 named as such. */
export function reportReadError(what: string, e: unknown): void {
  toast({ kind: "error", text: `${what}: ${errorText(e)}` });
}
