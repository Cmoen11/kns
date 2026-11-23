// Extension points of the window chrome: indicators in the titlebar and bottom row, and overlays
// (palette, help, pickers, the which-key panel). Features register; the shell renders.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type ShellArea =
  /** titlebar, right group (layout name ...) */
  | "titlebar"
  /** titlebar, before the context name (the sidebar toggle) */
  | "titlebar-left"
  /** bottom row, right group before the connection segment (pf, flux, cpu/mem) */
  | "status";

export interface ShellItem {
  /**
   * Unique id. The ids `metrics`, `flux` and `pf` drop in that order when the window is narrower
   * than 900px (§15); anything else stays (`live`, the activity count that replaces `pf`).
   */
  id: string;
  area: ShellArea;
  /** lower renders first (further left) */
  order?: number;
  /** a small, eagerly loaded component; render null when there is nothing to show */
  component: ComponentType;
}

export interface OverlayProps<P = unknown> {
  /** what showOverlay was called with */
  props: P;
  close: () => void;
}

interface OverlayDef {
  name: string;
  component: LazyExoticComponent<ComponentType<OverlayProps>>;
  /** always mounted; the component decides when it shows (which-key panel) */
  always: boolean;
}

interface ShellState {
  items: readonly ShellItem[];
  overlays: readonly OverlayDef[];
  /** open overlays, bottom first */
  open: readonly { name: string; props: unknown; key: number }[];
}

export const shellStore = createStore<ShellState>(() => ({ items: [], overlays: [], open: [] }));
export const useShell = <T,>(select: (s: ShellState) => T): T => useStore(shellStore, select);

/** Adds an indicator to the titlebar or the bottom row. Returns the remover. */
export function registerShellItem(item: ShellItem): () => void {
  shellStore.setState((s) => ({
    items: [...s.items.filter((i) => i.id !== item.id), item].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  }));
  return () => shellStore.setState((s) => ({ items: s.items.filter((i) => i !== item) }));
}

/** Removes an indicator by id (a feature that replaces another feature's indicator). */
export function unregisterShellItem(id: string): void {
  shellStore.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
}

/**
 * Registers an overlay component (lazy). Open it with showOverlay(name, props) from an action.
 * The component pushes its own scope layer (useScopeLayer(LAYERS.palette)) and calls close().
 */
export function registerOverlay<P = unknown>(
  name: string,
  loader: () => Promise<{ default: ComponentType<OverlayProps<P>> }>,
  opts: { always?: boolean } = {},
): () => void {
  const def: OverlayDef = {
    name,
    component: lazy(loader as unknown as () => Promise<{ default: ComponentType<OverlayProps> }>),
    always: opts.always ?? false,
  };
  shellStore.setState((s) => ({ overlays: [...s.overlays.filter((o) => o.name !== name), def] }));
  return () => shellStore.setState((s) => ({ overlays: s.overlays.filter((o) => o !== def) }));
}

let seq = 0;
/** Opens an overlay (an already open one of the same name is replaced). */
export function showOverlay(name: string, props?: unknown): void {
  shellStore.setState((s) => ({ open: [...s.open.filter((o) => o.name !== name), { name, props, key: ++seq }] }));
}
/** Closes one overlay, or the top one. */
export function closeOverlay(name?: string): void {
  shellStore.setState((s) => {
    if (s.open.length === 0) return s;
    const target = name ?? s.open[s.open.length - 1].name;
    const open = s.open.filter((o) => o.name !== target);
    return open.length === s.open.length ? s : { open };
  });
}
export const isOverlayOpen = (name?: string): boolean => {
  const open = shellStore.getState().open;
  return name ? open.some((o) => o.name === name) : open.length > 0;
};
