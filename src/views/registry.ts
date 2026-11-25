// The view registry: ViewState.kind -> a lazily loaded component plus the metadata the pane
// chrome needs (crumbs, title, key scopes). Feature directories register their kinds from their
// index.ts `register()`; src/features.ts calls them all before the first render.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { baseMode, viewScopes, type ModeBadge, type ScopeId, type TableKind, type ViewScopeInfo } from "../actions/scopes";
import { getCluster, kindOf, resourceFor } from "../store/cluster";
import { isArgoGroup, isFluxGroup } from "../store/aliases";
import type { ObjectRef, PaneId, ViewKind, ViewState } from "../types";
import { tableView } from "../store/workspace";
import type { ActionId } from "../actions/registry";
import type { ToolbarItem } from "../ui/Toolbar";

export type ViewOf<K extends ViewKind> = Extract<ViewState, { kind: K }>;

/** Props of every view component. */
export interface ViewProps<K extends ViewKind = ViewKind> {
  pane: PaneId;
  /** the pane's current history entry; a new object whenever it is edited */
  view: ViewOf<K>;
  /** this pane has keyboard focus */
  focused: boolean;
  /** false while the pane is folded away or zoomed out: pause rendering work, keep sessions */
  visible: boolean;
}

/**
 * One breadcrumb segment (§4.3). `view` makes it clickable and is what Backspace goes to;
 * `action` makes a click run that action for the pane instead (a picker: namespace, resource).
 */
export interface Crumb {
  /** untrusted text; rendered as text */
  label: string;
  view?: ViewState;
  action?: ActionId;
  /** words passed to the action as ctx.args */
  args?: readonly string[];
}

export interface ViewDef<K extends ViewKind = ViewKind> {
  kinds: readonly K[];
  /** `() => import("./TableView")`: the chunk loads when the first pane of this kind shows */
  component: () => Promise<{ default: ComponentType<ViewProps<K>> | ComponentType<ViewProps> }>;
  /** `namespace / resource / object / view`; default: the kind name */
  crumbs?: (view: ViewOf<K>) => Crumb[];
  /** what the key engine needs beyond the kind (doc mode and format, ...). Tables are derived from discovery. */
  scope?: (view: ViewOf<K>) => Partial<ViewScopeInfo>;
  /**
   * The view's buttons in the pane header, as action ids ("|" separates groups); see docs/frontend.md §17.
   * Called per render of the header, so it may read the ViewState for toggle states.
   */
  toolbar?: (view: ViewOf<K>) => readonly ToolbarItem[];
}

interface Entry {
  def: ViewDef;
  lazy: LazyExoticComponent<ComponentType<ViewProps>>;
}

const defs = new Map<ViewKind, Entry>();
const subs = new Set<() => void>();
let version = 0;

/** Registers the component and metadata for one or more view kinds. Re-registering replaces (HMR safe). */
export function registerView<K extends ViewKind>(def: ViewDef<K>): () => void {
  const entry: Entry = {
    def: def as unknown as ViewDef,
    lazy: lazy(def.component as unknown as () => Promise<{ default: ComponentType<ViewProps> }>),
  };
  for (const k of def.kinds) defs.set(k, entry);
  version++;
  for (const fn of [...subs]) fn();
  return () => {
    for (const k of def.kinds) if (defs.get(k) === entry) defs.delete(k);
    version++;
    for (const fn of [...subs]) fn();
  };
}

export const viewDef = (kind: ViewKind): ViewDef | undefined => defs.get(kind)?.def;
export const viewComponent = (kind: ViewKind): LazyExoticComponent<ComponentType<ViewProps>> | undefined => defs.get(kind)?.lazy;
export const viewRegistryVersion = (): number => version;
export const subscribeViews = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

// ── crumbs ─────────────────────────────────────────────────────────────────

const refCrumbs = (ref: ObjectRef): Crumb[] => [
  ...(ref.namespace ? [{ label: ref.namespace, view: tableView(ref.gvr, ref.namespace) }] : []),
  { label: ref.gvr.resource, view: tableView(ref.gvr, ref.namespace ?? "*", { cursorUid: ref.uid }) },
  { label: ref.name },
];

/** Crumbs used when a feature registers none; also exported as building blocks for features. */
export function defaultCrumbs(view: ViewState): Crumb[] {
  switch (view.kind) {
    case "table": {
      const out: Crumb[] = [];
      // the table's own crumbs are pickers: namespace, and the palette for another resource
      if (resourceFor(view.gvr)?.namespaced !== false) out.push({ label: view.namespace, action: "namespace.pick" });
      out.push({ label: view.gvr.resource, action: "palette.open" });
      if (view.scope?.by === "owner") out.push({ label: view.scope.ref.name });
      else if (view.scope?.by === "node") out.push({ label: view.scope.name });
      else if (view.scope?.by === "selector") out.push({ label: view.scope.selector });
      return out;
    }
    case "containers":
      return [...refCrumbs(view.pod), { label: "containers" }];
    case "doc":
      return [...refCrumbs(view.ref), { label: view.mode === "view" ? view.format : view.mode }];
    case "logs":
    case "shell":
    case "attach": {
      const t = view.target;
      const head: Crumb[] = t.by === "object" ? refCrumbs(t.ref) : t.by === "selector" ? [{ label: t.namespace }, { label: t.selector }] : [{ label: "selection" }];
      return [...head, { label: view.kind }];
    }
    case "portforwards":
      return [{ label: "port-forwards" }];
    case "messages":
      return [{ label: "errors" }];
    default:
      return [{ label: view.kind }];
  }
}

/** The toolbar a view kind declared for this view, or none. */
export function toolbarOf(view: ViewState): readonly ToolbarItem[] {
  return viewDef(view.kind)?.toolbar?.(view) ?? [];
}

export function crumbsOf(view: ViewState): Crumb[] {
  const fn = viewDef(view.kind)?.crumbs;
  const out = fn ? fn(view) : defaultCrumbs(view);
  return out.length > 0 ? out : [{ label: view.kind }];
}

/** The last crumb: tab strip label and the pane's short name. */
export function titleOf(view: ViewState): string {
  const c = crumbsOf(view);
  return c[c.length - 1].label;
}

/** The view Backspace goes to (§4.3): the nearest crumb before the last that has a view. */
export function parentCrumb(view: ViewState): ViewState | null {
  const c = crumbsOf(view);
  for (let i = c.length - 2; i >= 0; i--) if (c[i].view) return c[i].view ?? null;
  return null;
}

// ── key scopes ─────────────────────────────────────────────────────────────

const overrides = new Map<PaneId, Partial<ViewScopeInfo>>();
const scopeSubs = new Set<() => void>();

/**
 * Live facts about a pane that change its key scopes and are not in the ViewState: a shell is
 * live, a review has a conflict, the cursor row is Flux-managed. Pass null to clear.
 *
 *   setPaneScope(pane, { live: true });                 // shell connected  -> TERM
 *   setPaneScope(pane, { table: { fluxManaged: true } }) // merged into the derived table kind
 */
export function setPaneScope(pane: PaneId, info: (Omit<Partial<ViewScopeInfo>, "table"> & { table?: Partial<TableKind> }) | null): void {
  if (info === null) {
    if (!overrides.delete(pane)) return;
  } else {
    overrides.set(pane, info as Partial<ViewScopeInfo>);
  }
  for (const fn of [...scopeSubs]) fn();
}
export const subscribePaneScopes = (fn: () => void): (() => void) => {
  scopeSubs.add(fn);
  return () => scopeSubs.delete(fn);
};

/** What discovery says about a table's kind. */
export function tableKindOf(view: ViewOf<"table">): TableKind {
  const r = resourceFor(view.gvr);
  const namespaced = r?.namespaced ?? true;
  return {
    resource: view.gvr.resource,
    namespaced,
    allNamespaces: namespaced && view.namespace === "*",
    scalable: r ? r.subresources.includes("scale") : undefined,
    flux: isFluxGroup(view.gvr.group),
    argo: isArgoGroup(view.gvr.group),
  };
}

export function scopeInfoOf(pane: PaneId, view: ViewState): ViewScopeInfo {
  const def = viewDef(view.kind);
  const base: ViewScopeInfo = { kind: view.kind };
  if (view.kind === "table") base.table = tableKindOf(view);
  if (view.kind === "doc") {
    base.format = view.format;
    base.mode = view.mode;
  }
  const own = def?.scope ? def.scope(view) : {};
  const over = overrides.get(pane) ?? {};
  const table = base.table ? { ...base.table, ...own.table, ...over.table } : undefined;
  return { ...base, ...own, ...over, table };
}

export function scopesOf(pane: PaneId, view: ViewState): { scopes: ScopeId[]; mode: ModeBadge } {
  const info = scopeInfoOf(pane, view);
  return { scopes: viewScopes(info), mode: baseMode(info) };
}

/** Kind name for a reference, e.g. "Deployment" (falls back to the plural until discovery arrives). */
export const kindName = (ref: ObjectRef): string => kindOf(ref.gvr);
export const discovered = (): boolean => getCluster().discovered;
