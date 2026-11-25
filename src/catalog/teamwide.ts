// "All namespaces" for a user whose RBAC grants a few namespaces (a team on a shared cluster):
// once a context refused an all-namespaces list, or refuses to list namespaces at all, an
// all-namespaces table asks for the team's namespaces instead (TableQuery.namespaces, one table
// over them; multins.rs). Which namespaces: catalog/namespaces.ts `fallbackNamespaces`.
import { useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Gvr } from "../ipc/types";
import { useFav } from "../palette/favourites/store";
import { useNamespaces } from "../store/cluster";
import { useSettings } from "../store/settings";
import { fallbackNamespaces } from "./namespaces";
import { useCatalog } from "./store";

/** `<context>\u0001<group>/<resource>` that were refused across all namespaces, this session. */
const refused = createStore<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));
const keyOf = (context: string, gvr: Gvr) => `${context}\u0001${gvr.group}/${gvr.resource}`;

/**
 * Notes that `context` refused listing `gvr` across all namespaces. True when there are
 * namespaces to fall back on (the table then asks for them), false when there are none.
 */
export function noteAllForbidden(context: string, gvr: Gvr): boolean {
  const key = keyOf(context, gvr);
  const keys = refused.getState().keys;
  if (!keys.has(key)) refused.setState({ keys: new Set([...keys, key]) });
  return fallbackNamespaces(context).length > 0;
}

/**
 * The namespaces an all-namespaces table of `gvr` in `context` asks for instead, or null for a
 * normal all-namespaces list. `wantAll`: the view is an all-namespaces table of a namespaced kind.
 */
export function useTeamWide(context: string, wantAll: boolean, gvr: Gvr): string[] | null {
  const wasRefused = useStore(refused, (s) => s.keys.has(keyOf(context, gvr)));
  const nsForbidden = useNamespaces(context || undefined).forbidden;
  // what fallbackNamespaces reads
  const catalog = useCatalog((s) => s.catalog);
  const me = useSettings((s) => s.catalogUser);
  const teams = useSettings((s) => s.catalogTeams);
  const recent = useFav((s) => s.nsRecent[context]);
  const slots = useFav((s) => s.nsSlots[context]);
  const contexts = useStore(refused, (s) => s.keys.size);
  return useMemo(() => {
    if (!context || !wantAll || !(wasRefused || nsForbidden)) return null;
    const list = fallbackNamespaces(context);
    return list.length > 0 ? list : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, wantAll, wasRefused, nsForbidden, catalog, me, teams, recent, slots, contexts]);
}
