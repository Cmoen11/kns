// The action registry (docs/ux.md principle 2). One entry per action id of the keymap table;
// features make an action real by registering a handler for it. Until then `built` is false and
// the action is invisible everywhere and its key is unbound (principle 12).
import { parseBindings, type KeyEventLike } from "../keys/chord";
import type { Action, Binding, Chord } from "../types";
import { KEYMAP_ROWS, type ActionId, type Row } from "./keymap-data";
import { isScopeId, type ScopeId } from "./scopes";

export type { ActionId };

export type ActionSource = "key" | "palette" | "command" | "menu" | "pointer" | "api";

/** What a handler is told about the invocation. View state is read from the feature's own stores. */
export interface ActionContext {
  /** the action being run (aliases are resolved to their target) */
  id: ActionId;
  source: ActionSource;
  /** set when the action was run after the `+` prefix or should open beside (§4.4) */
  newPane: "right" | "down" | null;
  /** the last chord of the binding that fired, e.g. 'Ctrl+3' or 'Shift+Down' */
  chord?: Chord;
  /** the digit of that chord, for N-families (fav.viewN, namespace.favN, pane.focusN, logs.since) */
  digit?: number;
  /** words after the `:` command */
  args: readonly string[];
  /** true on key auto-repeat (only actions declared with repeat:true get these) */
  repeat: boolean;
  event?: KeyEventLike;
}

export interface ActionHandler {
  run(ctx: ActionContext): void | Promise<void>;
  /**
   * Applicability. When it returns false the action is treated as absent: hidden from hints and
   * the palette, and the key falls through to the next action bound to it (the Esc ladder, §4.2).
   */
  when?(ctx: ActionContext): boolean;
  /**
   * Permission. false or a reason string disables the action: it stays visible (disabled, with
   * the reason), the key is consumed and nothing runs. Use for RBAC and state such as "no row".
   */
  enabled?(ctx: ActionContext): boolean | string;
}

/** A registry entry: the spec's Action plus what the UI needs to show and run it. */
export interface ActionDef extends Action {
  id: ActionId;
  scopes: readonly ScopeId[];
  /** short lowercase label for hints, palette and help */
  label: string;
  /** help overlay section */
  group: string;
  /** `:` command words, e.g. 'pf' or 'split r' */
  command?: string;
  /** runs on key auto-repeat */
  repeat: boolean;
  /** this entry only contributes bindings (in its own scope) to another action */
  alias?: ActionId;
  /** declaration order; breaks ties between actions bound to the same key */
  order: number;
}

export type HandlerMap = Partial<Record<ActionId, ActionHandler | ActionHandler["run"]>>;

export interface Registry {
  /** all entries in declaration order (alias rows included) */
  list(): readonly ActionDef[];
  get(id: string): ActionDef | undefined;
  /** the entry whose handler runs for `id` (follows alias) */
  target(id: string): ActionDef | undefined;
  handler(id: string): ActionHandler | undefined;
  /**
   * Registers handlers and flips `built` to true for those ids. Throws on an unknown id or an
   * alias id. Re-registering an id replaces the handler (StrictMode / HMR safe).
   * Returns a function that unregisters exactly what this call registered.
   */
  register(handlers: HandlerMap): () => void;
  /** bumped on every register/unregister */
  version(): number;
  subscribe(fn: () => void): () => void;
}

function toDef(row: Row, order: number, ids: Set<string>): ActionDef {
  const scopes = row.scope.split(/\s+/).filter(Boolean);
  for (const s of scopes) if (!isScopeId(s)) throw new Error(`action ${row.id}: unknown scope "${s}"`);
  if (row.alias && !ids.has(row.alias)) throw new Error(`action ${row.id}: unknown alias target "${row.alias}"`);
  const win: Binding[] = parseBindings(row.keys, "win");
  const mac: Binding[] = parseBindings(row.mac ?? row.keys, "mac");
  return {
    id: row.id as ActionId,
    scope: row.scope,
    scopes: scopes as ScopeId[],
    tier: row.tier ?? "P0",
    built: false,
    opens: row.opens ?? "none",
    write: row.write ?? false,
    hint: row.hint ?? null,
    menu: row.menu,
    win,
    mac,
    when: row.when,
    label: row.label,
    group: row.group,
    command: row.command,
    repeat: row.repeat ?? false,
    alias: row.alias as ActionId | undefined,
    order,
  };
}

export function createRegistry(rows: readonly Row[] = KEYMAP_ROWS): Registry {
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) {
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.id)) throw new Error(`duplicate action id "${r.id}"`);
      seen.add(r.id);
    }
  }
  const defs = rows.map((r, i) => toDef(r, i, ids));
  const byId = new Map<string, ActionDef>(defs.map((d) => [d.id, d]));
  const handlers = new Map<string, ActionHandler>();
  const subs = new Set<() => void>();
  let version = 0;

  const target = (id: string) => {
    const d = byId.get(id);
    return d?.alias ? byId.get(d.alias) : d;
  };
  const changed = () => {
    version++;
    for (const d of defs) d.built = handlers.has(d.alias ?? d.id);
    for (const fn of subs) fn();
  };

  return {
    list: () => defs,
    get: (id) => byId.get(id),
    target,
    handler: (id) => handlers.get(target(id)?.id ?? ""),
    register(map) {
      const mine: [string, ActionHandler][] = [];
      for (const [id, h] of Object.entries(map)) {
        if (!h) continue;
        const def = byId.get(id);
        if (!def) throw new Error(`registerActions: unknown action id "${id}"`);
        if (def.alias) throw new Error(`registerActions: "${id}" is an alias, register "${def.alias}"`);
        const handler: ActionHandler = typeof h === "function" ? { run: h } : h;
        handlers.set(id, handler);
        mine.push([id, handler]);
      }
      changed();
      return () => {
        for (const [id, h] of mine) if (handlers.get(id) === h) handlers.delete(id);
        changed();
      };
    },
    version: () => version,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** The app's registry. */
export const registry = createRegistry();

/**
 * The call every feature makes, at module level in a small eagerly imported file, so keys work
 * before any lazy chunk has loaded (lazy-load heavy views inside `run`).
 *
 *   registerActions({
 *     "res.describe": { run: (ctx) => openDescribe(ctx.newPane), enabled: () => hasCursorRow() || "no row" },
 *     "hints.toggle": () => toggleHints(),
 *   });
 */
export function registerActions(handlers: HandlerMap): () => void {
  return registry.register(handlers);
}
