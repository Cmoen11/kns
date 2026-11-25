// The loaded organisation catalog (docs/catalog.md) and what it means for one kube context:
// its environment, the scoped teams and their namespaces. Eager and small; the catalog itself
// arrives from Rust (catalog.rs) at start, and when the user chooses, reloads or forgets it.
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend } from "../ipc";
import type { BackendError, Catalog, CatalogCluster } from "../ipc/types";
import { clusterStore, getCluster, useCluster } from "../store/cluster";
import { getSettings, setContextFlags, settingsStore, useSettings } from "../store/settings";
import { toasts } from "../ui/toast";
import { clusterOf, namespacesIn, scopeTeams, teamNamespaces, type NsInfo } from "./model";

interface CatalogState {
  catalog: Catalog | null;
  error: string | null;
  loading: boolean;
}

export const catalogStore = createStore<CatalogState>(() => ({ catalog: null, error: null, loading: false }));
export const useCatalog = <T,>(select: (s: CatalogState) => T): T => useStore(catalogStore, select);
export const getCatalog = (): Catalog | null => catalogStore.getState().catalog;

const message = (e: unknown): string => (e as Partial<BackendError> | null)?.message ?? String(e);

async function run(load: () => Promise<Catalog | null>, keepOnCancel: boolean): Promise<Catalog | null> {
  catalogStore.setState({ loading: true });
  try {
    const catalog = await load();
    if (catalog || !keepOnCancel) catalogStore.setState({ catalog, error: null });
    return catalog;
  } catch (e) {
    catalogStore.setState({ error: message(e) });
    throw e;
  } finally {
    catalogStore.setState({ loading: false });
  }
}

/** Reads the chosen catalog file again (`:catalog reload`). */
export const reloadCatalog = (): Promise<Catalog | null> => run(() => backend.catalogLoad(), false);
/** Opens the file dialog (`:catalog`, Settings > Catalog). */
export const chooseCatalog = (): Promise<Catalog | null> => run(() => backend.catalogChoose(), true);
/** Forgets the catalog file. */
export async function forgetCatalog(): Promise<void> {
  await backend.catalogForget();
  catalogStore.setState({ catalog: null, error: null });
}

/** What the catalog says about one context. */
export interface CatalogScope {
  catalog: Catalog | null;
  cluster: CatalogCluster | null;
  /** the context's environment, when the catalog knows it */
  env: string | undefined;
  /** the scoped teams (`:team`, else the user's own) */
  teams: string[];
  /** every namespace the catalog knows in this environment */
  info: ReadonlyMap<string, NsInfo>;
  /** the scoped teams' namespaces, sorted */
  mine: string[];
}

const NO_INFO: ReadonlyMap<string, NsInfo> = new Map();

export function scopeOf(context: string, catalog: Catalog | null = getCatalog()): CatalogScope {
  const s = getSettings();
  const ctx = getCluster().contexts.find((c) => c.name === context);
  const cluster = clusterOf(catalog, ctx);
  const env = cluster?.environment;
  const teams = scopeTeams(catalog, s.catalogUser, s.catalogTeams);
  return { catalog, cluster, env, teams, info: catalog ? namespacesIn(catalog, env, teams) : NO_INFO, mine: teamNamespaces(catalog, env, teams) };
}

/** scopeOf in React. */
export function useCatalogScope(context: string | null | undefined): CatalogScope {
  const catalog = useCatalog((s) => s.catalog);
  const ctx = useCluster((s) => s.contexts.find((c) => c.name === context));
  const me = useSettings((s) => s.catalogUser);
  const chosen = useSettings((s) => s.catalogTeams);
  return useMemo(() => {
    const cluster = clusterOf(catalog, ctx);
    const env = cluster?.environment;
    const teams = scopeTeams(catalog, me, chosen);
    return { catalog, cluster, env, teams, info: catalog ? namespacesIn(catalog, env, teams) : NO_INFO, mine: teamNamespaces(catalog, env, teams) };
  }, [catalog, ctx, me, chosen]);
}

/**
 * A context the catalog calls protected (production) and the user never set a flag for is
 * protected, once; the user can turn it off in settings, and kns does not turn it on again.
 */
let settingsReady = false;
function protectFromCatalog(): void {
  const catalog = getCatalog();
  // before the settings are read every context looks unflagged
  if (!catalog || !settingsReady) return;
  const flags = getSettings().contexts;
  const done: string[] = [];
  for (const c of getCluster().contexts) {
    if (flags[c.name] !== undefined) continue;
    if (clusterOf(catalog, c)?.protected) {
      setContextFlags(c.name, { protected: true });
      done.push(c.name);
    }
  }
  if (done.length > 0) toasts.show({ kind: "ok", text: `Protected (the catalog says production): ${done.join(", ")}` });
}

let started = false;
/** Loads the chosen catalog at start; called once from register(). */
export function initCatalog(): void {
  if (started) return;
  started = true;
  void settingsStore.hydrated.then(async () => {
    settingsReady = true;
    try {
      await reloadCatalog();
    } catch {
      // the error is in the store; Settings > Catalog and the sidebar show it
    }
    protectFromCatalog();
  });
  let contexts = getCluster().contexts;
  clusterStore.subscribe((s) => {
    if (s.contexts === contexts) return;
    contexts = s.contexts;
    protectFromCatalog();
  });
  let catalog = getCatalog();
  catalogStore.subscribe((s) => {
    if (s.catalog === catalog) return;
    catalog = s.catalog;
    protectFromCatalog();
  });
}
