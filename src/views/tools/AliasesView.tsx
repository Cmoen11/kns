// The aliases view (`:alias`, docs/ux.md §11.10): every name that `:` accepts, from discovery.
import { useMemo } from "react";
import { gvrKey, useCluster, type ViewProps } from "../../foundation";
import { EmptyState } from "../../ui";
import { ListPane } from "./ListPane";
import type { ListRow } from "./list-model";
import { openResource } from "./open";

const HEAD = ["Alias", "Resource", "Group"] as const;

export default function AliasesView({ pane, focused }: ViewProps<"aliases">) {
  const aliases = useCluster((s) => s.aliases);
  const discovered = useCluster((s) => s.discovered);

  const rows = useMemo<ListRow[]>(
    () =>
      [...aliases.list]
        .sort((a, b) => a.alias.localeCompare(b.alias) || a.resource.gvr.group.localeCompare(b.resource.gvr.group))
        .map(({ alias, resource }) => ({
          type: "item" as const,
          key: `${alias}|${gvrKey(resource.gvr)}`,
          cells: [alias, resource.gvr.resource, resource.gvr.group || "core"],
          open: (newPane: "right" | "down" | null) => openResource(resource, newPane),
        })),
    [aliases],
  );

  return (
    <ListPane
      pane={pane}
      focused={focused}
      name="aliases"
      head={HEAD}
      rows={rows}
      empty={<EmptyState compact>{discovered ? "The cluster serves no resources" : "syncing"}</EmptyState>}
    />
  );
}
