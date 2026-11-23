// React bindings for the key engine. All are narrow: a component re-renders only when the value
// it selected changes.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ActionId } from "../actions/registry";
import type { ScopeLayer } from "../actions/scopes";
import type { Binding } from "../types";
import { bindingKey } from "./chord";
import type { AvailableAction, Engine, EngineSnapshot } from "./engine";
import { engine as defaultEngine } from "./instance";

/** Subscribes to a derived engine value; `isEqual` keeps the previous reference when unchanged. */
export function useEngineValue<T>(
  select: (e: Engine) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
  engine: Engine = defaultEngine,
): T {
  const last = useRef<{ value: T } | null>(null);
  const get = () => {
    const next = select(engine);
    if (last.current && isEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(engine.subscribe, get, get);
}

const sameBindings = (a: Binding[], b: Binding[]) =>
  a.length === b.length && a.every((x, i) => bindingKey(x) === bindingKey(b[i]));

/** Effective bindings of an action for key chips (leader expanded, alias rows included). */
export function useBindings(id: ActionId, engine: Engine = defaultEngine): Binding[] {
  return useEngineValue((e) => e.bindingsFor(id), sameBindings, engine);
}

/** Mode badge, pending sequence and prefix. */
export function useKeyState(engine: Engine = defaultEngine): EngineSnapshot {
  return useEngineValue((e) => e.snapshot(), Object.is, engine);
}

const sameAvailable = (a: AvailableAction[], b: AvailableAction[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.action === b[i].action &&
      x.enabled === b[i].enabled &&
      x.reason === b[i].reason &&
      sameBindings(x.bindings, b[i].bindings),
  );

/** Hint-row actions for the active scopes, in hint order. */
export function useHints(engine: Engine = defaultEngine): AvailableAction[] {
  return useEngineValue((e) => e.hints(), sameAvailable, engine);
}

/** Every built, applicable action in the active scopes (palette, help overlay, context menu). */
export function useAvailableActions(engine: Engine = defaultEngine): AvailableAction[] {
  return useEngineValue((e) => e.available(), sameAvailable, engine);
}

/** Pushes a scope layer while the component is mounted and `active` is true. Pass a stable layer object. */
export function useScopeLayer(layer: ScopeLayer, active = true, engine: Engine = defaultEngine): void {
  useEffect(() => (active ? engine.pushScope(layer) : undefined), [layer, active, engine]);
}
