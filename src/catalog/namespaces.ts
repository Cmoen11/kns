// The namespaces kns offers for a context (pickers, the sidebar, `:ns` completion): what the
// cluster lists, plus what the catalog and the user's own history know. A team member whose RBAC
// forbids listing namespaces still gets their team's namespaces and the ones they used, instead
// of an empty list (docs/catalog.md).
import { useMemo } from "react";
import { getFav, useFav } from "../palette/favourites/store";
import { namespaceNames, useNamespaces } from "../store/cluster";
import { focusedContext } from "../store/layout";
import type { NsSlot } from "../types";
import type { NsInfo } from "./model";
import { scopeOf, useCatalogScope, type CatalogScope } from "./store";

export interface KnownNamespace {
  name: string;
  /** the cluster listed it */
  listed: boolean;
  /** one of the scoped teams owns it (catalog) */
  mine: boolean;
  /** what the catalog says about it */
  info?: NsInfo;
}

export interface KnownNamespaces {
  /** what a list shows without a query: the scoped teams' first, then the rest, alphabetically */
  shown: KnownNamespace[];
  /** `shown` plus every namespace the catalog knows in the context's environment (search only) */
  searchable: KnownNamespace[];
  synced: boolean;
  /** listing namespaces is forbidden: `shown` comes from the catalog and the history */
  forbidden: boolean;
  scope: CatalogScope;
}

export interface KnownInput {
  listed: readonly string[];
  forbidden: boolean;
  scope: Pick<CatalogScope, "info" | "mine">;
  recent: readonly string[];
  slots: readonly NsSlot[];
}

/** Pure: the merge of the listed namespaces with the catalog and the history. */
export function mergeKnown(i: KnownInput): Pick<KnownNamespaces, "shown" | "searchable"> {
  const listed = new Set(i.listed);
  const entry = (name: string): KnownNamespace => {
    const info = i.scope.info.get(name);
    return { name, listed: listed.has(name), mine: info?.mine ?? false, info };
  };
  let names: string[];
  if (i.forbidden || (i.listed.length === 0 && i.scope.mine.length > 0)) {
    // nothing listed: the team's namespaces, then the ones used here, then the slotted ones
    const used = [...i.recent, ...i.slots.flatMap((s) => (s ? [s.name] : []))];
    names = [...new Set([...i.scope.mine, ...used, ...i.listed])];
  } else {
    names = [...i.listed];
  }
  const shown = names.map(entry);
  shown.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
  const seen = new Set(names);
  const extra = [...i.scope.info.keys()].filter((n) => !seen.has(n)).sort().map(entry);
  return { shown, searchable: [...shown, ...extra] };
}

const NO_SLOTS: readonly NsSlot[] = [];
const NO_RECENT: readonly string[] = [];

/** The namespaces to offer for a context (default: the window's), in React. */
export function useKnownNamespaces(context?: string | null): KnownNamespaces {
  const { names, synced, forbidden } = useNamespaces(context || undefined);
  const scope = useCatalogScope(context);
  const recent = useFav((s) => (context ? s.nsRecent[context] : undefined)) ?? NO_RECENT;
  const slots = useFav((s) => (context ? s.nsSlots[context] : undefined)) ?? NO_SLOTS;
  return useMemo(() => {
    const merged = mergeKnown({ listed: names, forbidden, scope, recent, slots });
    return { ...merged, synced: synced || forbidden || merged.shown.length > 0, forbidden, scope };
  }, [names, synced, forbidden, scope, recent, slots]);
}

/** Namespace names for completion right now (default: the focused pane's context). */
export function knownNamespaceNames(context: string = focusedContext()): string[] {
  if (!context) return [];
  const scope = scopeOf(context);
  const fav = getFav();
  const listed = namespaceNames(context);
  const merged = mergeKnown({ listed, forbidden: listed.length === 0, scope, recent: fav.nsRecent[context] ?? [], slots: fav.nsSlots[context] ?? [] });
  return merged.searchable.map((n) => n.name);
}

/**
 * The namespaces a team member's "all namespaces" table and the namespace health cover when
 * the cluster refuses to list across all of them: the scoped teams' namespaces, else the ones
 * used in this context. Empty = nothing to fall back on.
 */
export function fallbackNamespaces(context: string): string[] {
  const mine = scopeOf(context).mine;
  if (mine.length > 0) return mine;
  const fav = getFav();
  return [...new Set([...(fav.nsRecent[context] ?? []), ...(fav.nsSlots[context] ?? []).flatMap((s) => (s ? [s.name] : []))])].sort();
}
