// Confirm tiers for destructive actions (docs/ux.md §14). Imperative API:
//
//   const r = await confirm({ tier: 2, title: "Delete deployment", typeToConfirm: "web",
//                             facts: objectFacts({ kind: "Deployment", name: "web", namespace: "shop", context }),
//                             delete: true });
//   if (r) await backend.deleteObject(ref, { propagation: r.propagation, gracePeriodSeconds: r.force ? 0 : undefined });
//
// Tier 0 has no dialog (toast + undo). Tier 1: Enter confirms, primary focused. Tier 2: type the
// name; the primary is disabled until it matches. Tier 3: as tier 2 plus the dependent count and
// the error glyph in the title. On a protected context the caller raises the tier (§14).
import { useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Propagation } from "../ipc/types";
import { Dialog, Facts, type Fact } from "./Dialog";
import { Checkbox, Field, Literal, RadioGroup } from "./Input";

export type ConfirmTier = 1 | 2 | 3;

export interface ConfirmOptions {
  tier: ConfirmTier;
  title: string;
  /** one or two sentences; plain text */
  body?: string;
  /** the fact block: kind, name, namespace, context (see objectFacts) */
  facts?: readonly Fact[];
  /** bulk: the affected items, scrolling past 8 */
  items?: readonly string[];
  /** tiers 2 and 3: the exact text to type (the resource name, or "delete 3" for bulk) */
  typeToConfirm?: string;
  /** tier 3: number of dependent objects that go with it */
  dependents?: number;
  /** shows the delete options: propagation radio, Force and dry-run checkboxes */
  delete?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmResult {
  /** set when `delete` was requested */
  propagation?: Propagation;
  force?: boolean;
  dryRun?: boolean;
}

interface Request {
  id: number;
  opts: ConfirmOptions;
  resolve: (r: ConfirmResult | null) => void;
}

const requests = createStore<{ list: Request[] }>(() => ({ list: [] }));
let seq = 0;

/** Opens a confirm dialog. Resolves with the chosen options, or null when cancelled. */
export function confirm(opts: ConfirmOptions): Promise<ConfirmResult | null> {
  if (opts.tier >= 2 && !opts.typeToConfirm) {
    return Promise.reject(new Error("confirm: tier 2 and 3 need typeToConfirm"));
  }
  return new Promise((resolve) => {
    requests.setState((s) => ({ list: [...s.list, { id: ++seq, opts, resolve }] }));
  });
}

function settle(req: Request, result: ConfirmResult | null) {
  requests.setState((s) => ({ list: s.list.filter((r) => r !== req) }));
  req.resolve(result);
}

/** The standard fact block of §14. Cluster-scoped objects omit the namespace. */
export function objectFacts(o: { kind: string; name: string; namespace?: string; context: string; protected?: boolean }): Fact[] {
  const out: Fact[] = [
    { label: "kind", value: o.kind },
    { label: "name", value: o.name },
  ];
  if (o.namespace) out.push({ label: "namespace", value: o.namespace });
  out.push({ label: "context", value: o.protected ? `${o.context}  PROTECTED` : o.context });
  return out;
}

const PROPAGATION: readonly { value: Propagation; label: string }[] = [
  { value: "Background", label: "Background" },
  { value: "Foreground", label: "Foreground" },
  { value: "Orphan", label: "Orphan" },
];

function ConfirmDialog({ req }: { req: Request }) {
  const { opts } = req;
  const [typed, setTyped] = useState("");
  const [propagation, setPropagation] = useState<Propagation>("Background");
  const [force, setForce] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const needsText = opts.tier >= 2 && opts.typeToConfirm !== undefined;
  const matched = !needsText || typed === opts.typeToConfirm;
  const result = (): ConfirmResult => (opts.delete ? { propagation, force, dryRun } : {});

  return (
    <Dialog
      title={opts.title}
      glyph={opts.tier === 3 ? "error" : undefined}
      confirmLabel={opts.confirmLabel}
      cancelLabel={opts.cancelLabel}
      confirmDisabled={!matched}
      confirmDisabledReason={needsText ? `type ${opts.typeToConfirm} to confirm` : undefined}
      onConfirm={() => matched && settle(req, result())}
      onCancel={() => settle(req, null)}
    >
      {opts.body && <p>{opts.body}</p>}
      {opts.facts && <Facts facts={opts.facts} />}
      {opts.items && (
        <ul className="k-items t-mono selectable">
          {opts.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
      {opts.tier === 3 && opts.dependents !== undefined && (
        <p>
          {opts.dependents} dependent {opts.dependents === 1 ? "object" : "objects"} will be deleted with it.
        </p>
      )}
      {opts.delete && (
        <>
          <RadioGroup legend="Propagation" name={`propagation-${req.id}`} value={propagation} options={PROPAGATION} onChange={setPropagation} />
          <Checkbox label="Force (grace period 0)" checked={force} onChange={(e) => setForce(e.target.checked)} />
          <Checkbox label="Dry run" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        </>
      )}
      {needsText && (
        <Field
          label={
            <>
              Type <Literal>{opts.typeToConfirm}</Literal> to confirm
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
    </Dialog>
  );
}

/** Mount once at the root: renders the newest pending confirm. */
export function DialogHost() {
  const req = useStore(requests, (s) => s.list[s.list.length - 1]);
  return req ? <ConfirmDialog key={req.id} req={req} /> : null;
}
