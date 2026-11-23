// Confirm tiers for cluster writes (docs/ux.md §14). Pure: no imports from the app.

/** 0 = no dialog, 1 = Enter confirms, 2 = type the name, 3 = type the name + dependents warning. */
export type Tier = 0 | 1 | 2 | 3;

/** Deleting these takes everything inside or of that kind with it. */
const TIER3 = new Set(["namespaces", "customresourcedefinitions"]);
/** Deleting these loses a controller, data or a node. */
const TIER2 = new Set([
  "deployments", "statefulsets", "daemonsets", "persistentvolumeclaims", "persistentvolumes", "nodes",
]);

const isFlux = (group: string): boolean => group.endsWith(".toolkit.fluxcd.io");

/** The tier of deleting one object of a kind (never 0: a delete is always confirmed). */
export function deleteTier(resource: string, group = ""): 1 | 2 | 3 {
  if (TIER3.has(resource)) return 3;
  // a Flux Kustomization or HelmRelease prunes what it manages
  if (TIER2.has(resource) || isFlux(group)) return 2;
  return 1;
}

/**
 * The tier that is actually asked. A protected context makes every write tier 2; a bulk delete
 * always needs the typed `delete N`; `minTier` raises it further (agent proposals: at least 1,
 * plan-features §5.5).
 */
export function effectiveTier(base: Tier, opts: { protected: boolean; bulkDelete?: boolean; minTier?: Tier }): Tier {
  let tier = base;
  if (opts.minTier !== undefined && tier < opts.minTier) tier = opts.minTier;
  if (opts.protected && tier < 2) tier = 2;
  if (opts.bulkDelete && tier < 2) tier = 2;
  return tier;
}

/** What the user types on tier 2 and 3: the name, or `<verb> N` for more than one object. */
export function confirmText(verb: string, names: readonly string[]): string {
  return names.length === 1 ? names[0] : `${verb} ${names.length}`;
}

/** Tier 3 has no cheap dependent count; the dialog says what goes with the object instead. */
export function dependentsNote(resource: string): string | undefined {
  if (resource === "namespaces") return "Every object in the namespace is deleted with it.";
  if (resource === "customresourcedefinitions") return "Every object of this kind, in all namespaces, is deleted with it.";
  return undefined;
}
