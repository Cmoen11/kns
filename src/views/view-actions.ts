// Per-view-kind handlers for actions that several features share (nav.down, nav.open, filter.open,
// search.next, select.clear ...). The registry holds one handler per action id, so features that
// only edit their own directory cannot each register `nav.down`. Instead each registers its handler
// for its own view kinds here; one dispatcher per id delegates to the handler of the focused pane's
// kind, and is absent (`when` false) for kinds that have none.
import type { ActionContext, ActionHandler, ActionId, HandlerMap, Registry } from "../actions/registry";
import { registry as appRegistry } from "../actions/registry";
import { paneView } from "../store/layout";
import type { ViewKind } from "../types";

export interface ViewActions {
  /**
   * Registers handlers that apply only while the focused pane shows one of `kinds`.
   * Returns the function that removes exactly these.
   */
  register(kinds: readonly ViewKind[], handlers: HandlerMap): () => void;
}

export function createViewActions(registry: Registry, currentKind: () => ViewKind | undefined): ViewActions {
  const byId = new Map<ActionId, Map<ViewKind, ActionHandler>>();
  const unregister = new Map<ActionId, () => void>();

  const pick = (id: ActionId): ActionHandler | undefined => {
    const kind = currentKind();
    return kind ? byId.get(id)?.get(kind) : undefined;
  };

  function dispatcher(id: ActionId): ActionHandler {
    return {
      when: (ctx: ActionContext) => {
        const h = pick(id);
        return !!h && (!h.when || h.when(ctx));
      },
      enabled: (ctx: ActionContext) => {
        const h = pick(id);
        return h?.enabled ? h.enabled(ctx) : true;
      },
      run: (ctx: ActionContext) => pick(id)?.run(ctx),
    };
  }

  return {
    register(kinds, handlers) {
      const mine: [ActionId, ViewKind, ActionHandler][] = [];
      for (const [key, h] of Object.entries(handlers)) {
        if (!h) continue;
        const id = key as ActionId;
        const handler: ActionHandler = typeof h === "function" ? { run: h } : h;
        let kindsOf = byId.get(id);
        if (!kindsOf) {
          byId.set(id, (kindsOf = new Map()));
          // throws on an unknown or alias id, like registerActions
          try {
            unregister.set(id, registry.register({ [id]: dispatcher(id) } as HandlerMap));
          } catch (e) {
            byId.delete(id);
            throw e;
          }
        }
        for (const k of kinds) {
          kindsOf.set(k, handler);
          mine.push([id, k, handler]);
        }
      }
      return () => {
        for (const [id, k, h] of mine) {
          const kindsOf = byId.get(id);
          if (!kindsOf || kindsOf.get(k) !== h) continue;
          kindsOf.delete(k);
          if (kindsOf.size === 0) {
            byId.delete(id);
            unregister.get(id)?.();
            unregister.delete(id);
          }
        }
      };
    },
  };
}

const app = createViewActions(appRegistry, () => paneView()?.kind);

/**
 * registerActions for one feature's view kinds. Use it for every action id that another feature
 * also implements in its own views:
 *
 *   registerViewActions(["table", "containers"], {
 *     "nav.down": { run: () => moveCursor(1) },
 *     "nav.open": { run: (ctx) => drill(ctx.newPane), enabled: () => hasRow() || "no row selected" },
 *   });
 *
 * The handler only runs, and the action only shows in hints and the palette, while the focused
 * pane shows one of `kinds`. Ids that only your feature implements can use registerActions.
 */
export function registerViewActions(kinds: readonly ViewKind[], handlers: HandlerMap): () => void {
  return app.register(kinds, handlers);
}
