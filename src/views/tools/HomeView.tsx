// The home view (docs/ux.md §11.10): context, favourites, recent tables and every listable
// resource in sections. An ordinary pane; at 240 wide it is the rail of §2.3.
import { contextDetail } from "../../store/context-label";
import { useEffect, useMemo, useState } from "react";
import { backend, engine, getWorkspace, gvrKey, openView, registry, tableView, useConn, useDiscovery, usePaneContext, useWorkspace, type ViewProps } from "../../foundation";
import { PERSIST_KEYS } from "../../store/persist";
import { EmptyState } from "../../ui";
import { ListPane } from "./ListPane";
import { groupResources, parseFavorites, recentKey, recentTables, type HomeFavorite } from "./home-model";
import { homeSections } from "./home-sections";
import type { ListRow } from "./list-model";
import { lastNamespace, openResource } from "./open";

type NewPane = "right" | "down" | null;

/** Favourites belong to the palette feature; home shows the saved file and re-reads it on focus. */
function useFavorites(focused: boolean): HomeFavorite[] {
  const [favs, setFavs] = useState<HomeFavorite[]>([]);
  useEffect(() => {
    if (!focused) return;
    let alive = true;
    backend.loadState(PERSIST_KEYS.favorites).then(
      (raw) => {
        if (!alive) return;
        const next = parseFavorites(raw);
        setFavs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [focused]);
  return favs;
}

export default function HomeView({ pane, focused }: ViewProps<"home">) {
  // the pane's context (§8.3)
  const context = usePaneContext(pane) || null;
  const info = useConn(context ?? "", (c) => c.info);
  const { resources, discovered } = useDiscovery(context ?? undefined);
  const favs = useFavorites(focused);
  // a primitive, so layout changes that do not touch the histories re-render nothing here
  const recentsKey = useWorkspace((ws) => recentTables(ws).map(recentKey).join("|"));
  const recents = useMemo(() => recentTables(getWorkspace()), [recentsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => groupResources(resources), [resources]);
  // feature sections (home-sections.ts): fixed once home has mounted, so the hook order is stable
  const extra = homeSections();
  const extraRows = extra.map((s) => s.useRows());

  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    if (context) {
      out.push({ type: "group", key: "g:context", label: "Context" });
      const detail = info ? `${contextDetail(info.cluster, info.user)} · ${info.serverVersion}` : "connecting";
      out.push({
        type: "item",
        key: "context",
        cells: [context, detail],
        // the picker belongs to the palette feature; the row opens it once it exists
        open: registry.get("context.pick")?.built ? () => void engine.run("context.pick", { source: "pointer" }) : undefined,
      });
    }
    if (favs.length > 0) {
      out.push({ type: "group", key: "g:fav", label: "Favourites" });
      for (const f of favs) {
        out.push({
          type: "item",
          key: `fav:${f.id}`,
          cells: [f.name, `${f.gvr.resource} · ${f.namespace ?? "current"}`],
          value: f.slot ? String(f.slot) : undefined,
          open: (newPane: NewPane) =>
            openView(tableView(f.gvr, f.namespace ?? lastNamespace(), { faultsOnly: f.faultsOnly, wide: f.wide }), { newPane }),
        });
      }
    }
    if (recents.length > 0) {
      out.push({ type: "group", key: "g:recent", label: "Recent" });
      for (const r of recents) {
        out.push({
          type: "item",
          key: `recent:${recentKey(r)}`,
          cells: [r.gvr.resource, r.namespace],
          open: (newPane: NewPane) => openView(tableView(r.gvr, r.namespace), { newPane }),
        });
      }
    }
    for (const s of sections) {
      out.push({ type: "group", key: `g:${s.section}`, label: s.section });
      for (const res of s.items) {
        const custom = s.section === "CRDs" || s.section === "Flux";
        out.push({
          type: "item",
          key: `res:${gvrKey(res.gvr)}`,
          cells: [res.gvr.resource, custom ? res.gvr.group : (res.shortNames[0] ?? "")],
          search: `${res.gvr.resource} ${res.kind} ${res.shortNames.join(" ")} ${res.gvr.group}`,
          open: (newPane: NewPane) => openResource(res, newPane),
        });
      }
    }
    extra.forEach((s, i) => {
      const items = extraRows[i];
      if (items.length === 0) return;
      out.push({ type: "group", key: `g:x:${s.id}`, label: s.label });
      for (const r of items) out.push({ ...r, key: `x:${s.id}:${r.key}` });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, info, favs, recents, sections, ...extraRows]);

  return (
    <ListPane
      pane={pane}
      focused={focused}
      name="home"
      rows={rows}
      openOnClick
      empty={<EmptyState compact>{discovered ? "Nothing to show" : "syncing"}</EmptyState>}
    />
  );
}
