// What the palette lists (docs/ux.md §6.1): resources from discovery, the actions that were
// runnable where it was opened (with their keys), favourites, layouts, namespaces, contexts,
// panes and live undos. Each item knows how to run itself.
import { contextDetail } from "../store/context-label";
import {
  crumbsOf, focusPane, getCluster, namespaceNames, openView, paneIndex, paneNamespace, paneOrder, paneView, registry, resourceFor, setNamespace,
  switchContext, tableView, toasts, type ActionId,
} from "../foundation";
import { TOOLS } from "../hub/catalog";
import { builtCommandWords, shadowedName } from "./command/parse";
import type { Binding, FavoriteView, PaneId, SavedLayout } from "../types";
import { favouriteSummary, treeSummary } from "./favourites/model";
import { noteNamespaceUsed, recallFavourite, recallLayout, type FavKind } from "./favourites/store";
import { rank } from "./fuzzy";
import { runFromSnapshot, type NewPane, type Snapshot } from "./session";
import type { ListRow } from "./ui/ListBox";

export interface Item {
  /** stable across sessions: the recents list stores it */
  key: string;
  group: string;
  /** untrusted text; rendered as text */
  label: string;
  /** also matched: short names, ids, command words */
  keywords?: readonly string[];
  detail?: string;
  /** an object's namespace ("" = cluster-scoped): the row reads namespace/name, kind at the right */
  scope?: string;
  slot?: string;
  bindings?: readonly Binding[];
  disabled?: boolean;
  reason?: string;
  /** set on favourites and layouts: the picker's rename, delete and slot keys act on it */
  fav?: { kind: FavKind; id: string; name: string };
  run(newPane: NewPane): void | Promise<unknown>;
}

export function resourceItems(pane: PaneId | null): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  // a built-in command word wins over a resource of the same name (`:why`, `:env`); such a
  // resource is listed, and reachable after `:`, as `resource.group`
  const words = builtCommandWords(registry.list());
  for (const r of getCluster().aliases.byGvr.values()) {
    const id = `${r.gvr.group}/${r.gvr.resource}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: `res:${id}`,
      group: "Resources",
      label: shadowedName(r.gvr.resource, r.gvr.group, words),
      keywords: [...r.shortNames, r.singular, r.kind, r.gvr.group ? `${r.gvr.resource}.${r.gvr.group}` : ""].filter(Boolean),
      detail: r.gvr.group || undefined,
      run: (newPane) => {
        const target = pane ?? undefined;
        const namespace = r.namespaced ? (paneNamespace(target) ?? "*") : "*";
        openView(tableView(r.gvr, namespace), { pane: target, newPane });
      },
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** N-families need a digit, and cursor movement is noise in a list of things to run. */
const hiddenInPalette = (id: string, repeat: boolean): boolean => repeat || /N$/.test(id) || id === "palette.open" || id === "pane.leader";

export function actionItems(snapshot: Snapshot, opts: { all?: boolean } = {}): Item[] {
  const out: Item[] = [];
  for (const a of snapshot.actions) {
    const d = a.action;
    if (!opts.all && hiddenInPalette(d.id, d.repeat)) continue;
    out.push({
      key: `act:${d.id}`,
      group: opts.all ? d.group : "Actions",
      label: d.label,
      keywords: [d.id, d.group, d.command ?? ""].filter(Boolean),
      detail: opts.all ? undefined : d.group,
      bindings: a.bindings,
      disabled: !a.enabled,
      reason: a.enabled ? undefined : a.reason,
      run: (newPane) => void runFromSnapshot(d.id as ActionId, { source: "palette", newPane: d.opens === "view" ? newPane : null }),
    });
  }
  return out;
}

/**
 * The Tools hub entries (plan-features §2.10a): "Tools: Why is this broken?". Enter opens the hub at
 * that tool; the tools' own actions are palette rows already. Absent until `hub.open` is built.
 */
export function toolItems(): Item[] {
  if (!registry.get("hub.open")?.built) return [];
  return TOOLS.map((t) => ({
    key: `tool:${t.id}`,
    group: "Tools",
    label: `Tools: ${t.title}`,
    keywords: [t.id, t.group, t.summary],
    detail: t.built() ? t.group : "not built yet",
    run: (newPane) => void runFromSnapshot("hub.open", { source: "palette", newPane, args: [t.id] }),
  }));
}

export function undoItems(): Item[] {
  return toasts.store
    .getState()
    .visible.filter((t) => t.undo)
    .reverse()
    .map((t) => ({ key: `undo:${t.id}`, group: "Undo", label: `undo: ${t.text}`, keywords: ["undo"], run: () => void toasts.undo(t.id) }));
}

export function favouriteItems(favourites: readonly FavoriteView[], layouts: readonly SavedLayout[], pane: PaneId | null, picker: boolean): Item[] {
  const bySlot = <T extends { slot?: number }>(list: readonly T[]) => [...list].sort((a, b) => (a.slot ?? 10) - (b.slot ?? 10));
  const out: Item[] = [];
  for (const f of bySlot(favourites)) {
    out.push({
      key: `fav:${f.id}`,
      group: picker ? "Views" : "Favourites",
      label: f.name,
      detail: favouriteSummary(f.view),
      slot: picker ? String(f.slot ?? "") : undefined,
      fav: { kind: "view", id: f.id, name: f.name },
      run: (newPane) => recallFavourite(f, { pane: pane ?? undefined, newPane }),
    });
  }
  for (const l of bySlot(layouts)) {
    out.push({
      key: `layout:${l.id}`,
      group: "Layouts",
      label: l.name,
      detail: treeSummary(l.root, l.views),
      slot: picker ? String(l.slot ?? "") : undefined,
      fav: { kind: "layout", id: l.id, name: l.name },
      run: () => recallLayout(l),
    });
  }
  return out;
}

export function namespaceItems(pane: PaneId | null): Item[] {
  const view = pane ? paneView(pane) : undefined;
  if (!pane || view?.kind !== "table" || resourceFor(view.gvr)?.namespaced === false) return [];
  const use = (ns: string) => () => {
    setNamespace(ns, pane);
    noteNamespaceUsed(ns);
  };
  return [
    { key: "ns:*", group: "Namespaces", label: "all namespaces", keywords: ["*"], disabled: view.namespace === "*", reason: view.namespace === "*" ? "current" : undefined, run: use("*") },
    ...namespaceNames().map((ns): Item => ({ key: `ns:${ns}`, group: "Namespaces", label: ns, disabled: ns === view.namespace, reason: ns === view.namespace ? "current" : undefined, run: use(ns) })),
  ];
}

export function contextItems(): Item[] {
  const { contexts, context } = getCluster();
  // the palette switches the window (§8.2); a pane in another context is `:pods @ctx` or the picker's Ctrl/⌘+Enter (§8.3)
  return contexts.map((c) => ({
    key: `ctx:${c.name}`,
    group: "Contexts",
    label: c.name,
    detail: contextDetail(c.cluster, c.user),
    disabled: c.name === context,
    reason: c.name === context ? "current" : undefined,
    run: () => switchContext(c.name),
  }));
}

export function paneItems(): Item[] {
  const order = paneOrder();
  if (order.length < 2) return [];
  return order.map((id) => {
    const v = paneView(id);
    const crumbs = v ? crumbsOf(v).map((c) => c.label).join(" / ") : "";
    // the key is positional on purpose: pane ids do not survive a restart
    return { key: `pane:${paneIndex(id)}`, group: "Panes", label: `pane ${paneIndex(id)}`, detail: crumbs, keywords: [crumbs], run: () => focusPane(id) };
  });
}

// ── rows ─────────────────────────────────────────────────────────────────────

export interface Built {
  rows: ListRow[];
  /** parallel to rows; null for group labels */
  items: (Item | null)[];
}

const toRow = (it: Item, positions: readonly number[], tag?: string): ListRow => ({
  key: it.key, label: it.label, positions, detail: it.detail, scope: it.scope, slot: it.slot, bindings: it.bindings, disabled: it.disabled, reason: it.reason, tag,
});

const RECENT_ROWS = 6;

/**
 * Empty query: sections with group labels, with a Recent section first when `recents` is given.
 * With a query: one flat list ranked by fuzzy score plus a recency bonus, each row tagged with
 * its section.
 */
export function buildRows(items: readonly Item[], query: string, recents: readonly string[] | null, untagged?: string): Built {
  const rows: ListRow[] = [];
  const out: (Item | null)[] = [];
  const q = query.trim();
  if (q !== "") {
    const age = new Map((recents ?? []).map((k, i) => [k, i]));
    const bonus = (it: Item) => {
      const a = age.get(it.key);
      return a === undefined ? 0 : Math.max(2, 16 - a);
    };
    for (const r of rank(items, q, { text: (it) => it.label, keywords: (it) => it.keywords, bonus })) {
      // `untagged`: the section the whole list is about (">" lists actions) needs no tag per row
      rows.push(toRow(r.item, r.positions, r.item.group === untagged ? undefined : r.item.group.toLowerCase()));
      out.push(r.item);
    }
    return { rows, items: out };
  }
  const shown = new Set<string>();
  if (recents && recents.length > 0) {
    const byKey = new Map(items.map((it) => [it.key, it]));
    const recent = recents.map((k) => byKey.get(k)).filter((it): it is Item => !!it && !it.disabled).slice(0, RECENT_ROWS);
    if (recent.length > 0) {
      rows.push({ key: "group:Recent", group: true, label: "Recent" });
      out.push(null);
      for (const it of recent) {
        rows.push(toRow(it, [], it.group.toLowerCase()));
        out.push(it);
        shown.add(it.key);
      }
    }
  }
  let group = "";
  for (const it of items) {
    if (shown.has(it.key)) continue;
    if (it.group !== group) {
      group = it.group;
      rows.push({ key: `group:${group}`, group: true, label: group });
      out.push(null);
    }
    rows.push(toRow(it, []));
    out.push(it);
  }
  return { rows, items: out };
}
