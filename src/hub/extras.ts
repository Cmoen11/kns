// What the hub says about a tool beyond the catalog entry (docs/plan-features.md §3 I, final pass):
// where a key works (derived from the keymap row's scopes), how tools without an action of their
// own start, mouse paths the pointer registries cannot see (pane toolbars, gutters, the bottom row,
// Settings, the activity panel), and why a tool has no "Try it". Kept beside the catalog, keyed by
// ToolId, so a feature's registerTool refinement cannot drop it. Each mouse line was checked against
// the code that registers the control (toolbars, row buttons, shell items, activity groups); the
// ones the final pass clicked in the mock are listed in its report. docs/tools.md says the same.
import type { ToolId } from "./catalog";

/** "where" a key or command of this scope works, from the first scope segment that says something. */
const WHERE: Record<string, string> = {
  global: "anywhere",
  pane: "in any pane",
  table: "on a table row",
  containers: "in a containers view",
  "k.pods": "on a pod row",
  "can.env": "on a workload row",
  "can.logs": "on a row",
  "can.shell": "on a pod row",
  "can.forward": "on a row",
  logs: "in a logs pane",
  "doc.yaml": "in a YAML view",
  doc: "in a describe or YAML view",
  portforwards: "in the port-forwards view (:pf)",
  agents: "in the agents view (:agents)",
  devsets: "in the dev sets view",
  env: "in the env view",
  diff: "in a diff",
  why: "in a why view",
  timeline: "in a timeline",
  traps: "in the traps view",
  patterns: "in a patterns view",
  relations: "in a relations view",
  text: "in a text view",
  hub: "in the Tools hub",
  list: "in a list",
  "picker.dev": "in the dev sets picker",
};

/** Where an action with these scopes runs ("on a table row"); "" when nothing fits. */
export function whereLabel(scopes: readonly string[]): string {
  if (scopes.includes("global")) return WHERE.global;
  // "table containers": a row of either; "table doc": a row, or the open YAML
  if (scopes.includes("table") && scopes.includes("containers")) return "on a row";
  if (scopes.includes("table") && scopes.includes("doc")) return "on a row, or in its YAML";
  if (scopes.includes("k.pods") && scopes.includes("containers")) return "on a pod or container row";
  for (const s of scopes) if (WHERE[s]) return WHERE[s];
  return "";
}

export interface ToolExtra {
  /** how it starts when the actions do not say it (flag-built tools) */
  how?: string;
  /** mouse paths outside the row bar, row menu, bulk bar, window menu and titlebar */
  mouse?: readonly string[];
  /** why there is no "Try it" */
  noTry?: string;
}

export const TOOL_EXTRAS: Readonly<Partial<Record<ToolId, ToolExtra>>> = {
  panes: { mouse: ["Pane header: the split, zoom and close buttons", "Drag the line between two panes to resize them"] },
  "port-forward": { mouse: ["Activity panel (titlebar toggle) → Port-forwards: open, copy and stop on each row", "Bottom row: the forwards count opens the port-forwards view"] },
  favourites: { mouse: ["Titlebar: the favourites button"] },
  filter: { mouse: ["Table toolbar: the filter and faults buttons; click a filter chip to remove it"] },
  why: { mouse: ["Why view toolbar: copy findings, follow the cursor"] },
  crash: {
    how: "`Enter` (or a double-click) on a pod row opens its containers view; the last exit code, reason and restarts are columns there.",
    mouse: ["Double-click a pod row"],
  },
  timeline: { mouse: ["Timeline toolbar: refresh, logs at this time; double-click a row describes its object"] },
  journal: {
    how: "`:journal` turns it on or off for the current context (`:journal on`, `:journal off`).",
    mouse: ["Activity panel → Journal: one row per context it is on for; its stop button turns it off"],
    noTry: "it starts a watch that stays on: turn it on with :journal",
  },
  trap: { mouse: ["Traps view: the open and disarm buttons on each row", "Activity panel → Traps", "Home → Traps"] },
  sparklines: {
    how: "`*` (wide) on the pods table shows the SPARK column.",
    mouse: ["Table toolbar: the wide button"],
  },
  rollout: {
    how: "Starts by itself after a restart, scale or Flux reconcile you run in kns; the rows are in the activity panel under Rollouts.",
    noTry: "it starts by itself after a restart, scale or reconcile",
  },
  debug: { mouse: ["Activity panel → Debug pods: open a shell, delete a copy"] },
  "logs-merged": { how: "Mark rows with `Space`, then `l`: one logs pane over all of them." },
  "logs-structured": { mouse: ["Logs toolbar: the structured toggle"] },
  "logs-patterns": { mouse: ["Logs toolbar: the patterns button", "Patterns view: double-click a pattern filters the logs"] },
  diff: { mouse: ["Diff toolbar: split/unified, managed fields, next and previous change"] },
  owners: { mouse: ["YAML view toolbar: the owners toggle"] },
  reach: { mouse: ["Reach view: Enter or a double-click on the probe row asks, then probes"] },
  relations: { mouse: ["Relations toolbar: collapse, expand, refresh; double-click a node describes it"] },
  devsets: { mouse: ["Home → Dev sets", "Bottom row: the active set's name opens the dev sets", "Dev sets view toolbar: start, stop, edit, delete, new from running forwards"] },
  env: { mouse: ["Env view toolbar: include, reveal, save as dev set, export, copy as"] },
  names: {
    how: "`:dev names on` starts the name proxy; `:dev names off` stops it.",
    mouse: ["Port-forwards view toolbar: “names on one port”", "Settings → Local dev: the names toggle and the port"],
  },
  "conn-string": { mouse: ["Port-forwards view: the link button on a forward's row"] },
  pack: { mouse: ["Pack preview: copy and save in the pane header, the remove button on each section"] },
  mcp: { mouse: ["Agents view toolbar: connect, revoke, stop server", "This entry: the Connect an agent… button below"] },
  proposals: {
    mouse: ["Bottom row: the “agent 1” item while a request waits", "Activity panel → Agent requests: click a row"],
  },
};
