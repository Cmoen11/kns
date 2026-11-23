// Shared plumbing of the palette's overlays and header bars: which one is open, the list
// controller the `list.*` actions talk to, the scope layer, focus return, and the snapshot of
// what was runnable before the overlay took the keys.
//
// Why a snapshot: an overlay's layer hides the pane's single-key actions (below: "chords"), so
// engine.available() called from inside the overlay no longer lists them. It is taken when the
// overlay opens, and only ids from it are run (engine.run does not check the scope).
//
// Why the layer is pushed here and not in the component: the component is lazy and mounts a
// moment later; keys typed in between must not reach the pane as single-key actions.
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ScopeLayer } from "../actions";
import { closeOverlay, engine, focusedPane, isOverlayOpen, showOverlay, type ActionId } from "../foundation";
import type { AvailableAction } from "../keys";
import type { PaneId } from "../types";

export type NewPane = "right" | "down" | null;

/** What the overlay on top does for the `list.*`, `palette.complete` and `picker.*` actions. */
export interface ListController {
  down(): void;
  up(): void;
  accept(newPane: NewPane): void;
  close(): void;
  complete?(): void;
  /** picker.rename, picker.delete, ... by name; absent = the action does not apply */
  extra?: Readonly<Record<string, (() => void) | undefined>>;
}

export interface Snapshot {
  /** built, applicable actions in the scopes that were active (declaration order) */
  actions: readonly AvailableAction[];
  hints: readonly AvailableAction[];
  /** the pane that had focus */
  pane: PaneId | null;
}

export const OVERLAYS = ["palette", "palette.picker", "palette.menu", "palette.save"] as const;
export type OverlayName = (typeof OVERLAYS)[number];

export interface BarState {
  command: { pane: PaneId; newPane: NewPane; key: number } | null;
}
export const barStore = createStore<BarState>(() => ({ command: null }));
export const useBars = <T,>(select: (s: BarState) => T): T => useStore(barStore, select);

const controllers: ListController[] = [];
let layer: { layer: ScopeLayer; pop: () => void } | null = null;
let opener: HTMLElement | null = null;
let snap: Snapshot = { actions: [], hints: [], pane: null };
let seq = 0;

export const topController = (): ListController | undefined => controllers[controllers.length - 1];
export const currentSnapshot = (): Snapshot => snap;

export function anyOpen(): boolean {
  const b = barStore.getState();
  return b.command !== null || OVERLAYS.some((n) => isOverlayOpen(n));
}

function setLayer(next: ScopeLayer | null): void {
  if (layer?.layer === next) return;
  layer?.pop();
  layer = next ? { layer: next, pop: engine.pushScope(next) } : null;
}

function restoreFocus(): void {
  const el = opener?.isConnected ? opener : document.querySelector<HTMLElement>(".pane[data-focused]");
  opener = null;
  el?.focus({ preventScroll: true });
}

/**
 * Closes whatever of ours is open, right now: the scope layer is popped and focus is back on
 * the opener before this returns, so an action run next sees the pane's scopes and a dialog it
 * opens does not capture a dying input as its opener.
 */
export function dismiss(): void {
  if (!anyOpen() && !layer) return;
  setLayer(null);
  controllers.length = 0;
  for (const n of OVERLAYS) if (isOverlayOpen(n)) closeOverlay(n);
  if (barStore.getState().command) barStore.setState({ command: null });
  endAhead();
  restoreFocus();
}

// Type-ahead. The palette and the pickers are lazy components: their input exists a moment after
// the key that opened them (longer on the first open). What is typed in between has no input to
// land in, so it is collected here and becomes the start of the input's text: Ctrl+K followed at
// once by a name never loses its first letters. Text only, never a shortcut: the key engine still
// sees every key first.
let ahead = "";
let endAhead: () => void = () => {};

function collectAhead(): void {
  endAhead();
  ahead = "";
  const onKey = (e: KeyboardEvent) => {
    if (!anyOpen()) return endAhead();
    if (e.isComposing || e.metaKey || ((e.ctrlKey || e.altKey) && !e.getModifierState("AltGraph"))) return;
    if (e.key === "Backspace") ahead = ahead.slice(0, -1);
    else if (e.key.length === 1) ahead += e.key;
  };
  window.addEventListener("keydown", onKey, true);
  endAhead = () => {
    window.removeEventListener("keydown", onKey, true);
    endAhead = () => {};
  };
}

/**
 * What was typed since the overlay was asked for: the initial text of its input
 * (`useState(typedAhead)`). A plain read: a render that suspends is thrown away and its state
 * initializer runs again, so collecting stops only when the component has mounted
 * (useOverlaySession).
 */
export const typedAhead = (): string => ahead;

/** Takes the snapshot, remembers the focus and takes the keys. Call with nothing of ours open. */
function begin(first: ScopeLayer): void {
  snap = { actions: engine.available(), hints: engine.hints(), pane: focusedPane() };
  const a = document.activeElement;
  opener = a instanceof HTMLElement && a !== document.body ? a : null;
  setLayer(first);
}

/** Opens one of our overlays (closing any other first) with its scope layer. */
export function open(name: OverlayName, first: ScopeLayer, props?: unknown): void {
  dismiss();
  begin(first);
  if (name === "palette" || name === "palette.picker") collectAhead();
  else ahead = "";
  showOverlay(name, props);
}

export function openCommandBar(first: ScopeLayer, newPane: NewPane): boolean {
  dismiss();
  const pane = focusedPane();
  if (!pane) return false;
  begin(first);
  barStore.setState({ command: { pane, newPane, key: ++seq } });
  return true;
}

/** True when the id was runnable where the overlay was opened from. */
export const inSnapshot = (id: string): boolean => snap.actions.some((a) => a.action.id === id);

/** Runs an action that the snapshot lists. Returns false when it is not there or did not run. */
export function runFromSnapshot(id: ActionId, opts: { source: "palette" | "command" | "menu"; newPane?: NewPane; args?: readonly string[] }): boolean {
  if (!inSnapshot(id)) return false;
  return engine.run(id, opts);
}

/**
 * Component side: keeps the scope layer in step with the component's mode (the palette changes
 * layer with its prefix) and returns focus if the overlay is closed from outside.
 */
export function useLayer(current: ScopeLayer): void {
  useEffect(() => {
    if (anyOpen()) setLayer(current);
  }, [current]);

  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (anyOpen()) return;
        setLayer(null);
        if (opener) restoreFocus();
      });
    },
    [],
  );
}

/**
 * Component side: registers the list controller while mounted. `controller` may be a new object
 * every render; the registered one forwards to the latest.
 */
export function useOverlaySession(current: ScopeLayer, controller: ListController): void {
  const ref = useRef(controller);
  ref.current = controller;

  useEffect(() => {
    // the input exists now: typing lands in it
    endAhead();
    const proxy: ListController = {
      down: () => ref.current.down(),
      up: () => ref.current.up(),
      accept: (newPane) => ref.current.accept(newPane),
      close: () => ref.current.close(),
      complete: () => ref.current.complete?.(),
      get extra() {
        return ref.current.extra;
      },
    };
    controllers.push(proxy);
    return () => {
      const i = controllers.indexOf(proxy);
      if (i >= 0) controllers.splice(i, 1);
    };
  }, []);
  useLayer(current);
}
