// What a write applies to: the focused pane's marked rows, else its cursor row (docs/ux.md §12.4).
// Snapshot it before the first await or dialog: the selection can move while the user decides.
import type { ApiResource, Gvr, ObjRef } from "../../ipc/types";
import {
  connOf, focusedContext, focusedPane, getCluster, getSelection, isFluxGroup, kindOf, paneView, resourceFor, sameGvr, selectionTargets, toObjRef,
} from "../../foundation";
import { contextFlags } from "../../store/settings";
import { isArgoGroup } from "./argo";
import type { FluxRef } from "./flux";

export interface Targets {
  context: string;
  gvr: Gvr;
  /** plural, e.g. "deployments" */
  resource: string;
  /** "Deployment" */
  kind: string;
  /** "deployment" */
  noun: string;
  items: ObjRef[];
  /** the context is protected: every write is tier 2 */
  protected: boolean;
}

export const nameOf = (ref: ObjRef): string => ref.name;
export const pathOf = (ref: ObjRef): string => (ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name);

/** The GVR the focused pane's selection is about; cheap enough for `when` and `enabled`. */
export function focusedGvr(): Gvr | null {
  const pane = focusedPane();
  if (!pane) return null;
  const sel = getSelection(pane);
  const first = sel.marked[0] ?? sel.focused;
  if (first) return first.gvr;
  const view = paneView(pane);
  return view?.kind === "table" ? view.gvr : null;
}

/** The first target, for RBAC checks. */
export function firstTarget(): { gvr: Gvr; namespace?: string } | null {
  const pane = focusedPane();
  if (!pane) return null;
  const sel = getSelection(pane);
  return sel.marked[0] ?? sel.focused;
}

export function currentTargets(): Targets | null {
  const pane = focusedPane();
  // the focused pane's context (§8.3): it decides the protected tier and where the write goes
  const context = focusedContext();
  if (!pane || !context) return null;
  const refs = selectionTargets(pane);
  if (refs.length === 0) return null;
  const gvr = refs[0].gvr;
  const kind = kindOf(gvr);
  return {
    context,
    gvr,
    resource: gvr.resource,
    kind,
    noun: kind.toLowerCase(),
    // marks never span kinds in one table; anything else is ignored rather than guessed at
    items: refs.filter((r) => sameGvr(r.gvr, gvr)).map((r) => toObjRef(r, context)),
    protected: contextFlags(context).protected,
  };
}

/** Targets for one explicit object (undo closures, the Flux suspend offer). */
export function targetsFor(ref: ObjRef): Targets {
  const kind = kindOf(ref.gvr);
  return {
    context: ref.context, gvr: ref.gvr, resource: ref.gvr.resource, kind, noun: kind.toLowerCase(),
    items: [ref], protected: contextFlags(ref.context).protected,
  };
}

// ── `when` predicates: `:` commands and engine.run skip the scope check, so handlers guard too ──

const tableGvr = (): Gvr | null => {
  const view = paneView();
  return view?.kind === "table" ? view.gvr : null;
};

export const onTable = (): boolean => tableGvr() !== null;
export const onResource = (...resources: string[]): boolean => {
  const gvr = tableGvr();
  return !!gvr && resources.includes(gvr.resource);
};
export const onFlux = (): boolean => {
  const gvr = tableGvr();
  return !!gvr && isFluxGroup(gvr.group);
};
/** An Argo CD Application or ApplicationSet table. */
export const onArgo = (): boolean => {
  const gvr = tableGvr();
  return !!gvr && isArgoGroup(gvr.group) && (gvr.resource === "applications" || gvr.resource === "applicationsets");
};
export const onArgoApp = (): boolean => {
  const gvr = tableGvr();
  return !!gvr && isArgoGroup(gvr.group) && gvr.resource === "applications";
};
/** Kinds with the scale subresource, per discovery (deployments and statefulsets until it arrives). */
export const onScalable = (): boolean => {
  const gvr = tableGvr();
  if (!gvr) return false;
  const r = resourceFor(gvr);
  return r ? r.subresources.includes("scale") : gvr.resource === "deployments" || gvr.resource === "statefulsets";
};

// ── discovery lookups ──

/** The discovered resource of a kind, optionally in one API group. */
/** Discovery of a context, the window's until that context's arrives. */
const resourcesOf = (context: string): readonly ApiResource[] => {
  const c = connOf(context);
  return c.discovered ? c.resources : getCluster().resources;
};

export function resourceOfKind(kind: string, group?: string, context: string = focusedContext()): ApiResource | undefined {
  const all = resourcesOf(context);
  return all.find((r) => r.kind === kind && (group === undefined || r.gvr.group === group));
}

/** A Flux object reference resolved through discovery; null when the kind is not served or the namespace is unknown. */
export function resolveFlux(ref: FluxRef, context: string): ObjRef | null {
  const res = resourcesOf(context).find((r) => r.kind === ref.kind && (ref.group ? r.gvr.group === ref.group : isFluxGroup(r.gvr.group)));
  if (!res) return null;
  if (res.namespaced && !ref.namespace) return null;
  return { context, gvr: res.gvr, namespace: res.namespaced ? ref.namespace : undefined, name: ref.name };
}
