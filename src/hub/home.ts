// Home's "Tools" section (docs/plan-features.md §2.10a): the hub, the getting-started paths, then a
// row per built tool group, each opening the hub there. Rows, so home walks, filters and opens them like its own.
import { useMemo, useSyncExternalStore } from "react";
import { openView, registry } from "../foundation";
import type { ItemRow } from "../views/tools/list-model";
import { registerHomeSection } from "../views/tools/home-sections";
import { subscribeToolBuilt, TOOL_GROUPS, TOOLS, type ToolId } from "./catalog";
import { GUIDES } from "./guides";

let version = 0;
const subscribe = (fn: () => void) => {
  const bump = () => {
    version++;
    fn();
  };
  const a = registry.subscribe(bump);
  const b = subscribeToolBuilt(bump);
  return () => {
    a();
    b();
  };
};

/** One row for the hub, then one per group with how many of its tools are built. */
export function toolsHomeRows(): ItemRow[] {
  const out: ItemRow[] = [
    {
      type: "item",
      key: "hub",
      cells: ["All tools", "what kns can do, with keys and try-it"],
      search: "tools hub guide help",
      open: (newPane) => void openView({ kind: "hub" }, { newPane }),
    },
    // the getting-started paths, right under the hub
    ...GUIDES.map((g): ItemRow => ({
      type: "item",
      key: `guide:${g.id}`,
      cells: [`Start: ${g.title.toLowerCase()}`, g.summary],
      search: `start getting started guide ${g.title} ${g.summary}`,
      open: (newPane) => void openView({ kind: "hub", tool: g.tool }, { newPane }),
    })),
  ];
  for (const g of TOOL_GROUPS) {
    const tools = TOOLS.filter((t) => t.group === g);
    if (tools.length === 0) continue;
    const built = tools.filter((t) => t.built());
    const first: ToolId = (built[0] ?? tools[0]).id;
    out.push({
      type: "item",
      key: `group:${g}`,
      cells: [g, built.map((t) => t.title).join(", ") || "coming"],
      value: `${built.length}/${tools.length}`,
      search: `tools ${g} ${tools.map((t) => `${t.title} ${t.id}`).join(" ")}`,
      open: (newPane) => void openView({ kind: "hub", tool: first }, { newPane }),
    });
  }
  return out;
}

function useToolsRows(): readonly ItemRow[] {
  const v = useSyncExternalStore(subscribe, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(toolsHomeRows, [v]);
}

export function registerToolsHome(): void {
  registerHomeSection({ id: "tools", label: "Tools", order: 10, useRows: useToolsRows });
}
