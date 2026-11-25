// The deploys view (`:deploys`, docs/catalog.md): for the catalog system of a namespace, the
// image tag each environment of each app runs, read from the system's ops repository through
// GitHub (github.rs), and the live version in the pane's context, from the version label of its
// deployments (the catalog cluster's `kns.dev/version-label`). Enter on a row opens the commits
// and pull requests between production and that environment (`changes`); `o` opens the compare
// on github.com.
import { useEffect, useMemo } from "react";
import { openView, useTable, usePaneContext, type ViewProps } from "../foundation";
import type { TableQuery } from "../ipc/types";
import { EmptyState } from "../ui";
import { ListPane } from "../views/tools/ListPane";
import type { ListRow } from "../views/tools/list-model";
import { deployGroups, rowGlyph, rowStatus, type CompareTarget } from "./deploys-model";
import { loadImages, setCompareTargets, useImages } from "./deploys";
import { gitopsOf } from "./model";
import { useCatalogScope } from "./store";

const DEPLOYMENTS = { group: "apps", version: "v1", resource: "deployments" };

export default function DeploysView({ pane, view, focused, visible }: ViewProps<"deploys">) {
  const context = usePaneContext(pane);
  const scope = useCatalogScope(context);
  const system = scope.catalog?.systems.find((s) => s.name === view.system);
  const ops = gitopsOf(system);
  const repo = ops?.repo;
  const imageFile = ops?.gitops?.imageFile;
  const load = useImages(repo, imageFile);
  useEffect(() => {
    if (repo && imageFile) loadImages(repo, imageFile);
  }, [repo, imageFile]);

  // the live workloads of the namespace, when the pane's context is one of the environments
  const versionLabel = scope.cluster?.labels.version;
  const query = useMemo<TableQuery | null>(() => (context && scope.env ? { context, gvr: DEPLOYMENTS, namespace: view.namespace } : null), [context, scope.env, view.namespace]);
  const table = useTable(query, { live: visible, pane });
  const live = useMemo(() => {
    if (!query || !table.synced || table.state === "forbidden" || table.state === "error") return null;
    return new Map(table.rows.map((r) => [r.name, versionLabel ? (r.labels?.[versionLabel] ?? "") : ""]));
  }, [query, table.rows, table.synced, table.state, versionLabel]);

  const groups = useMemo(
    () =>
      system && load?.state === "ready"
        ? deployGroups({ catalog: scope.catalog, system, images: load.data.images, appPrefix: ops?.gitops?.appPrefix, paneEnv: scope.env, live })
        : [],
    [system, load, scope.catalog, scope.env, ops, live],
  );

  const { rows, targets } = useMemo(() => {
    const out: ListRow[] = [];
    const byKey = new Map<string, CompareTarget>();
    if (load?.state === "ready" && load.data.truncated) out.push({ type: "group", key: "truncated", label: "GitHub cut the file list short: apps may be missing" });
    for (const g of groups) {
      out.push({ type: "group", key: `g:${g.app}`, label: [g.app, g.workload !== g.app ? g.workload : "", g.component?.repo ?? "no app repository in the catalog"].filter(Boolean).join(" · ") });
      for (const r of g.rows) {
        const key = `${g.app}/${r.env}`;
        const compare = r.compare;
        if (compare) byKey.set(key, compare);
        out.push({
          type: "item",
          key,
          glyph: rowGlyph(r),
          cells: [r.env, r.tag ?? "—", rowStatus(r, versionLabel)],
          value: r.here ? "this context" : undefined,
          search: `${g.app} ${g.workload} ${r.env} ${r.tag ?? ""} ${r.live ?? ""} ${g.component?.name ?? ""}`,
          title: [r.path, r.imageName && `image ${r.imageName}:${r.tag ?? "?"}`, compare && `Enter: changes ${compare.label}`].filter(Boolean).join("\n"),
          open: compare
            ? (newPane) => openView({ kind: "text", title: `changes · ${g.app} · ${compare.label}`, source: { by: "changes", repo: compare.repo, base: compare.base, head: compare.head } }, { newPane })
            : undefined,
        });
      }
    }
    return { rows: out, targets: byKey };
  }, [groups, versionLabel, load]);
  useEffect(() => setCompareTargets(pane, targets), [pane, targets]);

  if (!scope.catalog) return <EmptyState compact>No catalog: :catalog choose</EmptyState>;
  if (!system) return <EmptyState compact>No system “{view.system}” in the catalog</EmptyState>;
  if (!repo || !imageFile) return <EmptyState compact>{system.title} has no ops repository with kns.dev/gitops-image-file in the catalog</EmptyState>;
  if (!load || load.state === "loading") return <EmptyState compact>reading {repo} through GitHub</EmptyState>;
  if (load.state === "error") {
    return (
      <EmptyState compact title="Could not read the ops repository">
        {load.message}
      </EmptyState>
    );
  }
  const empty = (
    <EmptyState compact>
      No file in {repo} matches {imageFile}
    </EmptyState>
  );
  return <ListPane pane={pane} focused={focused} name="deploys" rows={rows} empty={empty} />;
}
