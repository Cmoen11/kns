// What a pointer control needs to know about an action, and the one way to run it from a click
// (docs/frontend.md §17). Buttons, toolbars, crumbs and menu rows all go through here, so a
// control is shown, disabled and explained exactly as the registry says.
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { registry, type ActionContext, type ActionId, type ActionSource } from "../actions/registry";
import { bindingText, isSingleKey } from "../keys/chord";
import { useEngineValue } from "../keys/hooks";
import { engine, keymap, platform } from "../keys/instance";
import type { Binding } from "../types";
import { focusedPane, focusPane, paneView } from "../store/layout";
import type { PaneId } from "../types";
import { scopesOf } from "../views/registry";

/** The pane a control lives in. Provided by the pane frame; null in the window chrome. */
export const PaneContext = createContext<PaneId | null>(null);
export const usePaneId = (): PaneId | null => useContext(PaneContext);

export interface ActionState {
  /** built, and applicable in the pane's scopes (`when` holds). False = render nothing. */
  present: boolean;
  enabled: boolean;
  /** why it is disabled */
  reason?: string;
  /** the registry's label */
  label: string;
  /** the first live binding as text ("Ctrl+. r"), "" when the action has no key */
  keys: string;
}

export interface ActionTarget {
  /** the pane the control acts on; default: the focused pane */
  pane?: PaneId | null;
  args?: readonly string[];
  newPane?: "right" | "down" | null;
}

const ABSENT: ActionState = { present: false, enabled: false, label: "", keys: "" };

// The key a tooltip teaches, as text. Cached per keymap version: every mounted control asks on
// every engine notification, and `keymap.display` scans the whole registry.
let keysVersion = -1;
let keysSingle = true;
const keysCache = new Map<string, { binding: Binding | undefined; text: string }>();

function shown(id: ActionId): { binding: Binding | undefined; text: string } {
  const single = engine.env().singleKeys;
  if (keysVersion !== keymap.version() || keysSingle !== single) {
    keysVersion = keymap.version();
    keysSingle = single;
    keysCache.clear();
  }
  let hit = keysCache.get(id);
  if (!hit) {
    const all = engine.bindingsFor(id);
    // with the single-keys setting off those keys are dead (engine.available drops them too)
    const binding = single ? all[0] : all.find((b) => !isSingleKey(b[0]));
    hit = { binding, text: binding ? bindingText(binding, platform) : "" };
    keysCache.set(id, hit);
  }
  return hit;
}

/** The binding a control shows for an action: the first one that works right now (none = no chip). */
export const shownBinding = (id: ActionId): Binding | undefined => shown(id).binding;
/** The same as text ("Ctrl+. r"), "" without a key. */
export const shownKeys = (id: ActionId): string => shown(id).text;
/** Live `shownBinding`. */
export const useShownBinding = (id: ActionId): Binding | undefined => useEngineValue(() => shownBinding(id));
/** Tooltip of a hand-made control: `label  key` from the live keymap. */
export function useTip(id: ActionId, label?: string): string {
  const keys = useEngineValue(() => shownKeys(id));
  const text = label ?? registry.target(id)?.label ?? id;
  return keys ? `${text}  ${keys}` : text;
}

/**
 * The state of an action for a control in `pane` (default: the focused pane).
 *
 * Handlers read the focused pane, so `when` / `enabled` are only evaluated when the control's
 * pane has focus. For another pane the answer is neutral (present by scope, enabled): the click
 * focuses that pane first, and an action that turns out to be blocked says why in the bottom row.
 */
export function actionState(id: ActionId, target: ActionTarget = {}): ActionState {
  const def = registry.target(id);
  const h = def && registry.handler(def.id);
  if (!def || !h) return ABSENT;
  const focused = focusedPane();
  const pane = target.pane ?? focused;
  const view = pane ? paneView(pane) : undefined;
  // the pane's own chain, whatever overlay or input is on top (a click is not a key), plus what
  // is live right now for the focused pane (the layer of an open input or mode)
  const scopes = pane && view ? scopesOf(pane, view).scopes : [];
  const live = pane === focused ? engine.snapshot().scopes : [];
  if (!def.scopes.some((s) => s === "global" || scopes.includes(s) || live.includes(s))) return ABSENT;
  const base = { label: def.label, keys: shownKeys(id) };
  if (pane !== focused) return { present: true, enabled: true, ...base };
  const ctx: ActionContext = { id: def.id, source: "pointer", newPane: target.newPane ?? null, args: target.args ?? [], repeat: false };
  if (h.when && !h.when(ctx)) return ABSENT;
  if (def.write && engine.env().readOnly) return { present: true, enabled: false, reason: "read-only mode", ...base };
  const r = h.enabled ? h.enabled(ctx) : true;
  if (r === true) return { present: true, enabled: true, ...base };
  return { present: true, enabled: false, reason: typeof r === "string" ? r : "not available", ...base };
}

const same = (a: ActionState, b: ActionState) =>
  a.present === b.present && a.enabled === b.enabled && a.reason === b.reason && a.label === b.label && a.keys === b.keys;

/** Live `actionState`: re-renders only when the answer changes (the engine notifies on every focus, view and invalidate). */
export function useActionState(id: ActionId, target: ActionTarget = {}): ActionState {
  const last = useRef<ActionState>(ABSENT);
  const get = () => {
    const next = actionState(id, target);
    return same(last.current, next) ? last.current : (last.current = next);
  };
  return useSyncExternalStore(engine.subscribe, get, get);
}

/** Tooltip text: `label  key`, and the reason when disabled. Teaches the key (bindings are live). */
export function actionTitle(s: Pick<ActionState, "label" | "keys" | "reason">, label?: string): string {
  const head = s.keys ? `${label ?? s.label}  ${s.keys}` : (label ?? s.label);
  return s.reason ? `${head} (${s.reason})` : head;
}

/**
 * Runs an action from a click. The control's pane becomes the focused pane first (and gets DOM
 * focus when focus sat outside the panes, e.g. in a side panel), then `before` runs (move the
 * cursor to the clicked row), then the action runs through the engine. Returns false when it did
 * not run; a disabled action flashes its reason.
 */
export function runAction(id: ActionId, target: ActionTarget & { before?: () => void; source?: ActionSource } = {}): boolean {
  const pane = target.pane ?? null;
  if (pane) {
    if (focusedPane() !== pane) focusPane(pane);
    const a = document.activeElement;
    // not for an action of a layer outside the panes (a side panel's): its `when` reads that focus
    const view = paneView(pane);
    const chain = view ? scopesOf(pane, view).scopes : [];
    const paneAction = registry.target(id)?.scopes.some((s) => s === "global" || chain.includes(s)) ?? true;
    if (paneAction && a instanceof HTMLElement && a !== document.body && !a.closest(".pane")) {
      document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane)}"] > .pane`)?.focus({ preventScroll: true });
    }
  }
  target.before?.();
  const state = actionState(id, { ...target, pane: pane ?? undefined });
  if (!state.present) return false;
  return engine.run(id, { source: target.source ?? "pointer", newPane: target.newPane ?? null, args: target.args });
}

/** `onMouseDown` of every pointer control: the click must not take keyboard focus from the pane. */
export const keepFocus = (e: { preventDefault(): void }): void => e.preventDefault();
