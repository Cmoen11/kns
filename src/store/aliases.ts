// Resource alias map built from discovery (docs/ux.md §6.2): plural, singular, short names, kind
// and `name.group`, all lowercase. Pure, so it is unit-tested without a backend.
import type { ApiResource, Gvr } from "../ipc/types";

export const gvrKey = (g: Gvr): string => `${g.group}/${g.version}/${g.resource}`;
export const sameGvr = (a: Gvr, b: Gvr): boolean => a.resource === b.resource && a.group === b.group;

/** Flux kinds get the `flux` scope (reconcile, suspend). */
export const isFluxGroup = (group: string): boolean => group.endsWith(".toolkit.fluxcd.io");

export interface AliasMap {
  /** alias -> resource; the first resource that claims a name keeps it (core and apps come first) */
  byAlias: ReadonlyMap<string, ApiResource>;
  byGvr: ReadonlyMap<string, ApiResource>;
  /** every alias of every resource, for the aliases view and completion */
  list: readonly { alias: string; resource: ApiResource }[];
}

const PREFERRED_GROUPS = ["", "apps", "batch", "networking.k8s.io", "rbac.authorization.k8s.io", "storage.k8s.io"];

export function buildAliases(resources: readonly ApiResource[]): AliasMap {
  const byAlias = new Map<string, ApiResource>();
  const byGvr = new Map<string, ApiResource>();
  const list: { alias: string; resource: ApiResource }[] = [];
  const rank = (r: ApiResource) => {
    const i = PREFERRED_GROUPS.indexOf(r.gvr.group);
    return i < 0 ? PREFERRED_GROUPS.length : i;
  };
  // stable sort: built-in groups win a short name over a CRD that reuses it
  const ordered = [...resources].sort((a, b) => rank(a) - rank(b));
  for (const r of ordered) {
    byGvr.set(gvrKey(r.gvr), r);
    const names = new Set<string>();
    const add = (n: string | undefined) => {
      if (n) names.add(n.toLowerCase());
    };
    add(r.gvr.resource);
    add(r.singular);
    add(r.kind);
    for (const s of r.shortNames) add(s);
    if (r.gvr.group) {
      add(`${r.gvr.resource}.${r.gvr.group}`);
      add(`${r.singular || r.kind}.${r.gvr.group}`);
    }
    for (const alias of names) {
      if (!byAlias.has(alias)) byAlias.set(alias, r);
      list.push({ alias, resource: r });
    }
  }
  return { byAlias, byGvr, list };
}

/** Resolves what the user typed after `:` to a resource. */
export function resolveAlias(map: AliasMap, name: string): ApiResource | undefined {
  return map.byAlias.get(name.trim().toLowerCase());
}
