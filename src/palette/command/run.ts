// Runs a parsed `:` command against the live app (docs/ux.md §6.2). The grammar itself is in
// parse.ts; this file only wires it to the registry, discovery and the pane API.
import { knownNamespaceNames } from "../../catalog/namespaces";
import {
  connOf, contextName, engine, ensureConnected, focusedPane, getCluster, paneContext, openView, paneNamespace, registry, resolveContext, resolveResource, tableView,
  type ActionId,
} from "../../foundation";
import type { PaneId } from "../../types";
import { getFav, recallFavourite, recallLayout, noteNamespaceUsed } from "../favourites/store";
import { findByName } from "../favourites/slots";
import { currentSnapshot, runFromSnapshot, type NewPane } from "../session";
import { parseCommand, type Command, type CommandSpec, type CompleteEnv } from "./parse";

/**
 * Command words the keymap table has no row for (§6.2). They only exist while their action is
 * built and was runnable where the command line was opened.
 */
const EXTRA: readonly (readonly [string, ActionId, string?])[] = [
  ["split", "pane.splitRight"],
  ["zoom", "pane.zoom"],
  ["equal", "pane.equalize"],
  ["reconcile", "flux.reconcile"],
  ["fav save", "fav.saveView"],
  // the keymap editor is a section of the settings view
  ["keys", "settings.open", "keys"],
];
const extraArg = new Map(EXTRA.filter((e) => e[2]).map((e) => [e[0], e[2] as string]));

/** Every command phrase that can run right now. */
export function commandSpecs(): CommandSpec[] {
  const live = new Set(currentSnapshot().actions.map((a) => a.action.id));
  const out: CommandSpec[] = [];
  for (const d of registry.list()) {
    if (d.command && !d.alias && d.built && live.has(d.id)) out.push({ words: d.command.split(" "), id: d.id });
  }
  for (const [phrase, id] of EXTRA) if (live.has(id)) out.push({ words: phrase.split(" "), id });
  return out;
}

/**
 * Resource names for completion: plurals first (alphabetical), then the other aliases. A name that
 * a command word shadows is left out (its `name.group` alias is among the rest).
 */
function resourceNames(commands: readonly CommandSpec[]): string[] {
  const { aliases } = getCluster();
  const words = new Set(commands.map((c) => c.words[0]));
  const plurals = new Set<string>();
  for (const r of aliases.byGvr.values()) if (!words.has(r.gvr.resource)) plurals.add(r.gvr.resource);
  const rest: string[] = [];
  for (const { alias } of aliases.list) if (!plurals.has(alias) && !words.has(alias) && aliases.byAlias.has(alias)) rest.push(alias);
  return [...[...plurals].sort(), ...rest.sort()];
}

/** The lookups for parse and completion, read once per keystroke batch. */
export function commandEnv(): CompleteEnv {
  const cluster = getCluster();
  const fav = getFav();
  const commands = commandSpecs();
  return {
    commands,
    isResource: (alias) => resolveResource(alias) !== undefined,
    resources: resourceNames(commands),
    namespaces: knownNamespaceNames(),
    // aliases complete too: `:ctx pr` → `prod`
    contexts: [...cluster.contexts.map((c) => contextName(c.name)), ...cluster.contexts.map((c) => c.name)],
    favourites: fav.favorites.map((f) => f.name),
    layouts: fav.layouts.map((l) => l.name),
  };
}

function waitForDiscovery(context: string, timeoutMs = 15000): Promise<boolean> {
  ensureConnected(context);
  return new Promise((resolve) => {
    const ok = () => connOf(context).discovered;
    if (ok()) return resolve(true);
    const started = Date.now();
    const tick = () => {
      if (ok()) resolve(true);
      else if (Date.now() - started > timeoutMs || connOf(context).status === "offline") resolve(false);
      else setTimeout(tick, 100);
    };
    tick();
  });
}

async function openResource(cmd: Extract<Command, { type: "resource" }>, pane: PaneId | undefined, newPane: NewPane): Promise<string | null> {
  const target = pane ?? focusedPane() ?? undefined;
  const here = paneContext(target);
  let context = here;
  // `@x` is a kubeconfig name or an alias (§8.2)
  const asked = cmd.context ? resolveContext(cmd.context) : null;
  if (cmd.context && !asked) return `no context "${cmd.context}"`;
  if (asked && asked !== here) {
    // §8.3: `@ctx` scopes to the pane: in place the pane restarts in that context, with `+` /
    // Ctrl/⌘+Enter a new pane opens there. `:ctx` switches the whole window.
    if (!(await waitForDiscovery(asked))) return `${contextName(asked)}: discovery did not finish`;
    context = asked;
  }
  const res = resolveResource(cmd.alias, context);
  if (!res) return `unknown resource "${cmd.alias}"${context !== here ? ` in ${context}` : ""}`;
  // without an argument the pane keeps its namespace, as in k9s
  const namespace = !res.namespaced ? "*" : (cmd.namespace ?? paneNamespace(target) ?? "*");
  if (res.namespaced && cmd.namespace) noteNamespaceUsed(cmd.namespace, context);
  openView(tableView(res.gvr, namespace, { filters: cmd.filters }), { pane: target, newPane, context });
  return null;
}

/**
 * Runs one command line in `pane`. Returns an error message, or null when it ran (or was
 * cancelled by the user in a confirm).
 */
export async function runCommand(input: string, opts: { pane?: PaneId; newPane?: NewPane } = {}): Promise<string | null> {
  const cmd = parseCommand(input, { commands: commandSpecs(), isResource: (a) => resolveResource(a) !== undefined });
  const newPane = opts.newPane ?? null;
  switch (cmd.type) {
    case "empty":
      return null;
    case "error":
      return cmd.message;
    case "resource":
      return openResource(cmd, opts.pane, newPane);
    case "fav": {
      if (cmd.name === "") return runFromSnapshot("fav.picker", { source: "command", newPane }) ? null : "favourites are not available here";
      const fav = findByName(getFav().favorites, cmd.name);
      if (!fav) return `no favourite "${cmd.name}"`;
      recallFavourite(fav, { pane: opts.pane, newPane });
      return null;
    }
    case "layout": {
      if (cmd.name === "") return runFromSnapshot("fav.picker", { source: "command" }) ? null : "layouts are not available here";
      const layout = findByName(getFav().layouts, cmd.name);
      if (!layout) return `no layout "${cmd.name}"`;
      await recallLayout(layout);
      return null;
    }
    case "action": {
      const words = input.replace(/^\s*:/, "").trim().split(/\s+/);
      const phrase = words.slice(0, words.length - cmd.args.length).join(" ").toLowerCase();
      const preset = extraArg.get(phrase);
      const args = preset ? [preset, ...cmd.args] : cmd.args;
      // a disabled action reports its own reason (bottom row); only a failed `when` is silent
      let reported = false;
      const off = engine.on((e) => {
        if (e.type === "blocked" || e.type === "message") reported = true;
      });
      const ran = runFromSnapshot(cmd.id as ActionId, { source: "command", newPane, args });
      off();
      return ran || reported ? null : `:${phrase} is not available here`;
    }
  }
}
