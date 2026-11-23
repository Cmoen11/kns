// The one persisted store for PERSIST_KEYS.favorites: favourite views, saved layouts and namespace
// slots (docs/ux.md §7, §8.1), plus two fields of our own: namespace recency (the "least recently
// used" rule needs it) and palette recents. Small and eager: hotkeys must work before any overlay loads.
import { useStore } from "zustand";
import {
  confirm, focusedContext, windowContext, flash, focusedPane, getWorkspace, liveSessions, openView, paneNamespace, paneView, setWorkspace, toast,
} from "../../foundation";
import { PERSIST_KEYS, persistedStore, type PersistedSlice } from "../../store/persist";
import type { FavoriteView, NsSlot, PaneId, SavedLayout, Slot, TableView } from "../../types";
import { fromFavouriteView, fromSavedLayout, isLayoutUnedited, matchesFavourite, sanitizeFavourites, sanitizeLayouts, toFavouriteView, toSavedLayout } from "./model";
import { findByName, moveSlot, normalizeNsSlots, noteNamespace, removeItem, renameItem, togglePin, touchRecent, upsert } from "./slots";

export interface FavState extends PersistedSlice<"favorites" | "layouts" | "nsSlots"> {
  /** per context: namespaces by last use, most recent first */
  nsRecent: Record<string, string[]>;
  /** palette item keys by last use, most recent first */
  recents: string[];
}

const RECENTS_CAP = 50;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown, cap: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, cap) : []);

export function sanitizeFavState(data: unknown): FavState {
  const d = isObj(data) ? data : {};
  const nsSlots: Record<string, NsSlot[]> = {};
  if (isObj(d.nsSlots)) for (const [ctx, s] of Object.entries(d.nsSlots)) nsSlots[ctx] = normalizeNsSlots(Array.isArray(s) ? (s as NsSlot[]) : undefined);
  const nsRecent: Record<string, string[]> = {};
  if (isObj(d.nsRecent)) for (const [ctx, r] of Object.entries(d.nsRecent)) nsRecent[ctx] = strings(r, 30);
  return {
    favorites: sanitizeFavourites(d.favorites),
    layouts: sanitizeLayouts(d.layouts),
    nsSlots,
    nsRecent,
    recents: strings(d.recents, RECENTS_CAP),
  };
}

export const favStore = persistedStore<FavState>({
  key: PERSIST_KEYS.favorites,
  version: 1,
  defaults: () => ({ favorites: [], layouts: [], nsSlots: {}, nsRecent: {}, recents: [] }),
  sanitize: sanitizeFavState,
});

export const useFav = <T,>(select: (s: FavState) => T): T => useStore(favStore, select);
export const getFav = (): FavState => favStore.getState();

let counter = 0;
export const newId = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ── favourite views ──────────────────────────────────────────────────────────

/** Saves a table view. An existing favourite of the same name is replaced; a taken slot is freed (§7.1). */
export function saveFavouriteView(name: string, slot: Slot | undefined, view: TableView, currentNamespace: boolean): FavoriteView {
  const existing = findByName(getFav().favorites, name);
  const fav: FavoriteView = { id: existing?.id ?? newId(), name: name.trim(), view: toFavouriteView(view, currentNamespace) };
  if (slot !== undefined) fav.slot = slot;
  favStore.setState((s) => ({ favorites: upsert(s.favorites, fav) }));
  return fav;
}

/** Opens a favourite in the pane (or beside it). A held pane opens beside by itself (§4.6). */
export function recallFavourite(fav: FavoriteView, opts: { pane?: PaneId; newPane?: "right" | "down" | null } = {}): void {
  const pane = opts.pane ?? focusedPane() ?? undefined;
  const view = fromFavouriteView(fav.view, paneNamespace(pane));
  if (!opts.newPane) {
    const cur = paneView(pane);
    if (cur && matchesFavourite(fav.view, cur)) return;
  }
  openView(view, { pane, newPane: opts.newPane });
}

export const favouriteInSlot = (slot: number): FavoriteView | undefined => getFav().favorites.find((f) => f.slot === slot);
export const layoutInSlot = (slot: number): SavedLayout | undefined => getFav().layouts.find((l) => l.slot === slot);

/** The favourite a view matches (the pane header's `FAV n`, §7.1). */
export const favouriteFor = (view: TableView): FavoriteView | undefined => getFav().favorites.find((f) => matchesFavourite(f.view, view));

// ── saved layouts ────────────────────────────────────────────────────────────

/** Saves the workspace on screen. Saving under an existing name overwrites it (§7.2). */
export function saveLayout(name: string, slot: Slot | undefined): SavedLayout | null {
  const ws = getWorkspace();
  if (!ws) return null;
  const existing = findByName(getFav().layouts, name);
  const layout = toSavedLayout(ws, existing?.id ?? newId(), name.trim(), slot);
  favStore.setState((s) => ({ layouts: upsert(s.layouts, layout) }));
  // the workspace on screen is now this layout, unedited
  setWorkspace({ ...ws, layoutId: layout.id, dirty: false });
  return layout;
}

/**
 * Applies a saved layout. Parked workspaces are not built, so the workspace on screen is replaced:
 * live sessions end, and are confirmed first. Recalling the active, unedited layout does nothing.
 */
export async function recallLayout(layout: SavedLayout): Promise<boolean> {
  const ws = getWorkspace();
  // a layout fills the window's workspace; its panes are all in the window's context
  const context = windowContext();
  if (!ws || !context) return false;
  if (isLayoutUnedited(ws, layout)) {
    flash(`layout ${layout.name} is already active`);
    return false;
  }
  const ending = liveSessions().filter((l) => l.onClose === "ends").map((l) => l.label);
  if (ending.length > 0) {
    const ok = await confirm({ tier: 1, title: `Apply layout ${layout.name}`, body: "These sessions end.", items: ending, confirmLabel: "Apply", cancelLabel: "Keep" });
    if (!ok) return false;
  }
  if (liveSessions().some((l) => l.onClose === "kept")) toast("Drafts kept");
  setWorkspace(fromSavedLayout(layout, context, newId));
  return true;
}

// ── picker edits ─────────────────────────────────────────────────────────────

export type FavKind = "view" | "layout";
const field = (kind: FavKind) => (kind === "view" ? "favorites" : "layouts");

export function renameFavourite(kind: FavKind, id: string, name: string): void {
  favStore.setState((s) => (kind === "view" ? { favorites: renameItem(s.favorites, id, name.trim()) } : { layouts: renameItem(s.layouts, id, name.trim()) }));
}
export function deleteFavourite(kind: FavKind, id: string): void {
  favStore.setState((s) => (kind === "view" ? { favorites: removeItem(s.favorites, id) } : { layouts: removeItem(s.layouts, id) }));
}
export function moveFavouriteSlot(kind: FavKind, id: string, delta: 1 | -1): void {
  favStore.setState((s) => (kind === "view" ? { favorites: moveSlot(s.favorites, id, delta) } : { layouts: moveSlot(s.layouts, id, delta) }));
}
export const favouriteList = (kind: FavKind): readonly (FavoriteView | SavedLayout)[] => getFav()[field(kind)];

// ── namespace slots (§8.1) ───────────────────────────────────────────────────

export const nsSlots = (context: string = focusedContext()): NsSlot[] => normalizeNsSlots(getFav().nsSlots[context]);

/** The namespace in slot 1..9 of the focused pane's context (§8.3), for the table's digit keys. */
export const namespaceInSlot = (slot: number): string | undefined => nsSlots()[slot - 1]?.name;

/** Records a namespace as used: it takes a slot by the §8.1 rule and moves to the front of the recency list. */
export function noteNamespaceUsed(name: string, context: string = focusedContext()): void {
  if (!context || !name || name === "*") return;
  favStore.setState((s) => {
    const recent = s.nsRecent[context] ?? [];
    if (recent[0] === name) return s;
    return {
      nsSlots: { ...s.nsSlots, [context]: noteNamespace(s.nsSlots[context] ?? [], recent, name) },
      nsRecent: { ...s.nsRecent, [context]: touchRecent(recent, name) },
    };
  });
}

export function toggleNamespacePin(name: string, context: string = focusedContext()): void {
  if (!context) return;
  favStore.setState((s) => ({ nsSlots: { ...s.nsSlots, [context]: togglePin(s.nsSlots[context] ?? [], s.nsRecent[context] ?? [], name) } }));
}

// ── palette recents ──────────────────────────────────────────────────────────

export function noteRecent(key: string): void {
  favStore.setState((s) => (s.recents[0] === key ? s : { recents: touchRecent(s.recents, key, RECENTS_CAP) }));
}
