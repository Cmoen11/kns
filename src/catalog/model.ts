// The organisation catalog, pure (docs/catalog.md): which environment a kube context is, who the
// user is and which teams they are in, the namespaces of those teams, the system behind a
// namespace and the component behind a workload. No store, no React: catalog/store.ts holds the
// loaded catalog, catalog/namespaces.ts merges it with what the cluster lists.
import type { Catalog, CatalogCluster, CatalogComponent, CatalogSystem, CatalogTeam, CatalogUser, ContextInfo } from "../ipc/types";

/** The catalog cluster a context is: one of its `contextMatch` strings is in the context's name or cluster (longest match wins). */
export function clusterOf(catalog: Catalog | null, ctx: Pick<ContextInfo, "name" | "cluster"> | undefined): CatalogCluster | null {
  if (!catalog || !ctx) return null;
  const hay = [ctx.name.toLowerCase(), ctx.cluster.toLowerCase()];
  let best: CatalogCluster | null = null;
  let bestLen = 0;
  for (const c of catalog.clusters) {
    for (const m of c.contextMatch) {
      const needle = m.toLowerCase();
      if (needle.length > bestLen && hay.some((h) => containsWord(h, needle))) {
        best = c;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

/** `needle` in `hay` with no letter or digit glued on either side: eks-test is not in eks-tester. */
function containsWord(hay: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : hay[i - 1];
    const after = hay[i + needle.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = i + 1;
  }
}

/** The catalog user `me` names: an email address or a user name (case-insensitive). */
export function userOf(catalog: Catalog | null, me: string): CatalogUser | null {
  const m = me.trim().toLowerCase();
  if (!catalog || !m) return null;
  return catalog.users.find((u) => u.email === m) ?? catalog.users.find((u) => u.name.toLowerCase() === m) ?? null;
}

/**
 * The teams kns scopes to: the explicit choice (`:team`), else the teams `me` is a member of.
 * Unknown team names in the choice are dropped.
 */
export function scopeTeams(catalog: Catalog | null, me: string, chosen: readonly string[]): string[] {
  if (!catalog) return [];
  const known = new Set(catalog.teams.map((t) => t.name));
  const picked = chosen.filter((t) => known.has(t));
  if (picked.length > 0) return picked;
  return userOf(catalog, me)?.memberOf.filter((t) => known.has(t)) ?? [];
}

export const teamOf = (catalog: Catalog | null, name: string | undefined): CatalogTeam | undefined =>
  name ? catalog?.teams.find((t) => t.name === name) : undefined;

/** Whether a system runs in `env` (no environment list, or no environment known: yes). */
export const runsIn = (s: CatalogSystem, env: string | undefined): boolean => !env || s.environments.length === 0 || s.environments.includes(env);

/** What the catalog says about one namespace. */
export interface NsInfo {
  namespace: string;
  system: CatalogSystem;
  team?: CatalogTeam;
  /** owned by one of the scoped teams */
  mine: boolean;
}

/** Every namespace the catalog knows in `env`, by name. Two systems on one namespace: the first wins. */
export function namespacesIn(catalog: Catalog | null, env: string | undefined, teams: readonly string[]): Map<string, NsInfo> {
  const out = new Map<string, NsInfo>();
  if (!catalog) return out;
  const mine = new Set(teams);
  for (const s of catalog.systems) {
    if (!s.namespace || !runsIn(s, env) || out.has(s.namespace)) continue;
    out.set(s.namespace, { namespace: s.namespace, system: s, team: teamOf(catalog, s.owner), mine: !!s.owner && mine.has(s.owner) });
  }
  return out;
}

/** The namespaces of the scoped teams in `env`, sorted. */
export function teamNamespaces(catalog: Catalog | null, env: string | undefined, teams: readonly string[]): string[] {
  return [...namespacesIn(catalog, env, teams).values()].filter((i) => i.mine).map((i) => i.namespace).sort();
}

/** The system whose namespace this is (in any environment). */
export function systemOfNamespace(catalog: Catalog | null, namespace: string | undefined): CatalogSystem | undefined {
  return namespace ? catalog?.systems.find((s) => s.namespace === namespace) : undefined;
}

/**
 * The component behind a workload of `system`: one that lists it (`kns.dev/workloads`), else the
 * one whose name is the workload's name or its longest dash-prefix (`shop-orders` for
 * `shop-orders-7f9c`), else a GitOps component's `<prefix><app>` naming.
 */
export function componentOf(system: CatalogSystem | undefined, workload: string): CatalogComponent | undefined {
  if (!system) return undefined;
  const listed = system.components.find((c) => c.workloads.includes(workload));
  if (listed) return listed;
  let best: CatalogComponent | undefined;
  for (const c of system.components) {
    if (c.type === "gitops") continue;
    if ((workload === c.name || workload.startsWith(`${c.name}-`)) && c.name.length > (best?.name.length ?? 0)) best = c;
  }
  return best;
}

/** The GitOps component (ops repository) of a system. */
export const gitopsOf = (system: CatalogSystem | undefined): CatalogComponent | undefined => system?.components.find((c) => c.gitops);

/** The kube contexts that are `env` in the catalog, in kubeconfig order. */
export function contextsFor(catalog: Catalog | null, contexts: readonly ContextInfo[], env: string): ContextInfo[] {
  return contexts.filter((c) => clusterOf(catalog, c)?.environment === env);
}

/** The environments the catalog's clusters have, in catalog order. */
export function environments(catalog: Catalog | null): string[] {
  const out: string[] = [];
  for (const c of catalog?.clusters ?? []) if (c.environment && !out.includes(c.environment)) out.push(c.environment);
  return out;
}

/** A short line for a namespace row: the system's title and the owning team. */
export function nsDetail(info: NsInfo | undefined): string | undefined {
  if (!info) return undefined;
  const title = info.system.title !== info.namespace ? info.system.title : "";
  return [title, info.team?.title ?? info.system.owner].filter(Boolean).join(" · ") || undefined;
}
