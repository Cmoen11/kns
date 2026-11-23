// Pure logic of the Tools hub (docs/plan-features.md §3 I): the grouped rows and their filter,
// what "Try it" runs on, the mouse paths derived from the pointer registries, and the docs/tools.md
// section behind "Learn more". No stores, no DOM: the view and the actions feed it.
import type { ActionId } from "../actions";
import type { CurrentObject } from "../store/current";
import type { ObjectRef, PaneId, ViewKind, ViewState } from "../types";
import type { IconName } from "../ui/Glyph";
import { TOOL_GROUPS, type ToolEntry, type ToolGroup, type ToolId } from "./catalog";
import { guideForTool } from "./guides";

// ── rows ───────────────────────────────────────────────────────────────────

const GROUP_ICON: Record<ToolGroup, IconName> = {
  Basics: "tools", Debug: "bug", Logs: "logs", Diff: "diff", "Local dev": "env", Agents: "agent",
};
const ICON: Partial<Record<ToolId, IconName>> = {
  palette: "search", panes: "split-right", logs: "logs", shell: "shell", "describe-edit": "describe",
  "port-forward": "plug", favourites: "star", filter: "filter",
  why: "why", crash: "fault", timeline: "timeline", journal: "history", trap: "trap", sparklines: "clock",
  reach: "reach", relations: "relations", rollout: "restart", debug: "bug", snippets: "play", kubectl: "copy",
  "logs-merged": "logs", "logs-structured": "columns", "logs-patterns": "pattern",
  diff: "diff", owners: "edit",
  devsets: "env", env: "env", names: "link", "conn-string": "link", mirrord: "external",
  pack: "pack", mcp: "agent", proposals: "agent",
};
export const toolIcon = (t: ToolEntry): IconName => t.icon ?? ICON[t.id] ?? GROUP_ICON[t.group];

export type HubRow = { type: "group"; key: string; label: ToolGroup } | { type: "item"; key: ToolId; tool: ToolEntry };

/** What `/` matches: title, summary, id, group, commands and the help text. */
export const toolSearch = (t: ToolEntry): string => {
  const g = guideForTool(t.id);
  return [t.title, t.summary, t.id, t.group, ...t.commands, t.help.answers, t.help.notFor ?? "", g ? `${g.title} ${g.summary} getting started guide` : ""].join(" ").toLowerCase();
};

/** Tools in group order (TOOL_GROUPS, then any group a registration added), each group under its label; filtered by every word of `filter`. */
export function hubRows(tools: readonly ToolEntry[], filter = ""): HubRow[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = [...TOOL_GROUPS, ...new Set(tools.map((t) => t.group).filter((g) => !TOOL_GROUPS.includes(g)))];
  const out: HubRow[] = [];
  for (const g of groups) {
    const items = tools.filter((t) => t.group === g && terms.every((w) => toolSearch(t).includes(w)));
    if (items.length === 0) continue;
    out.push({ type: "group", key: `g:${g}`, label: g });
    for (const t of items) out.push({ type: "item", key: t.id, tool: t });
  }
  return out;
}

/** Index of the item row of `id`, else the first item row; -1 when there is none. */
export function rowIndex(rows: readonly HubRow[], id: ToolId | undefined): number {
  const i = id ? rows.findIndex((r) => r.type === "item" && r.key === id) : -1;
  return i >= 0 ? i : rows.findIndex((r) => r.type === "item");
}

/** The item `delta` items away from `from` (clamped); group rows are skipped. */
export function stepRow(rows: readonly HubRow[], from: number, delta: number): number {
  const items = rows.map((r, i) => (r.type === "item" ? i : -1)).filter((i) => i >= 0);
  if (items.length === 0) return -1;
  const at = Math.max(0, items.indexOf(from));
  return items[Math.min(items.length - 1, Math.max(0, at + delta))];
}

// ── try it ─────────────────────────────────────────────────────────────────

/** Needs a pane of a certain view open (TryNeeds ending in "Pane"). */
export type PaneNeed = "logsPane" | "yamlPane" | "envPane" | "pfPane";
export const PANE_NEEDS: readonly PaneNeed[] = ["logsPane", "yamlPane", "envPane", "pfPane"];

/** The pane needs a view meets: logs, a YAML doc being read, the env view, the port-forwards list. */
export function viewFits(v: ViewState | null | undefined): PaneNeed[] {
  if (!v) return [];
  switch (v.kind) {
    case "logs":
      return ["logsPane"];
    case "doc":
      return v.format === "yaml" && v.mode === "view" ? ["yamlPane"] : [];
    case "env":
      return ["envPane"];
    case "portforwards":
      return ["pfPane"];
    default:
      return [];
  }
}

const PANE_WORDS: Record<PaneNeed, { these: string; the: string; missing: string }> = {
  logsPane: { these: "these logs", the: "the logs", missing: "open logs first (l on a row)" },
  yamlPane: { these: "this YAML", the: "the YAML", missing: "open YAML first (y on a row)" },
  envPane: { these: "this env", the: "the env view", missing: "open the env of a workload first (E on its row)" },
  pfPane: { these: "these forwards", the: "the forwards", missing: "open the port-forwards first (:pf), with a forward running" },
};

/** What the resolution reads about the window; injected so it is tested without stores. */
export interface TryEnv {
  focused: PaneId | null;
  focusedKind: ViewKind | null;
  /** kind of the focused pane's previous history entry (the view the hub was opened over in place) */
  previousKind: ViewKind | null;
  /** pane needs the focused view and that previous entry meet (viewFits) */
  focusedFits?: readonly PaneNeed[];
  previousFits?: readonly PaneNeed[];
  /** src/store/current.ts currentObject() */
  current: CurrentObject | null;
  /** panes meeting each need right now, most relevant first */
  panes?: Partial<Record<PaneNeed, readonly PaneId[]>>;
  /** registry label of an action ("why") */
  label: (id: ActionId) => string;
}

export type TryPlan =
  | {
      ok: true;
      /** button text: "Try: why → pod/crashy" */
      label: string;
      action: ActionId;
      /** the pane to run it from; null = where the hub is */
      pane: PaneId | null;
      /** go back in that pane first (the hub was opened in place over the source) */
      back: boolean;
      /** after going back, wait until the source's cursor is on this object */
      waitFor?: ObjectRef;
      writes: boolean;
    }
  | { ok: false; label: string; reason: string };

const WORKLOADS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"]);
const CORE_GROUPS = new Set(["", "apps", "batch"]);
const isPod = (r: ObjectRef) => r.gvr.resource === "pods" && r.gvr.group === "";
const isWorkload = (r: ObjectRef) => WORKLOADS.has(r.gvr.resource) && CORE_GROUPS.has(r.gvr.group);
const TABLE_LIKE = new Set<ViewKind>(["table", "containers"]);

/** "pod/crashy": the resource's singular-ish short form and the name. */
export function refLabel(r: ObjectRef): string {
  const res = r.gvr.resource;
  const singular = res.endsWith("ies") ? `${res.slice(0, -3)}y` : res.endsWith("sses") ? res.slice(0, -2) : res.endsWith("s") ? res.slice(0, -1) : res;
  return `${singular}/${r.name}`;
}

/** What "Try it" does for `tool` right now, or why it cannot. */
export function resolveTry(tool: ToolEntry, env: TryEnv): TryPlan {
  const t = tool.try;
  if (!tool.built()) return { ok: false, label: "Try", reason: "not built yet" };
  if (!t) return { ok: false, label: "Try", reason: "nothing to try here: start it with its keys" };
  const verb = t.label ?? (env.label(t.action) || t.action);
  const writes = !!t.writes;
  const fail = (reason: string): TryPlan => ({ ok: false, label: `Try: ${verb}`, reason });

  if (t.needs === "none") return { ok: true, label: `Try: ${verb}`, action: t.action, pane: null, back: false, writes };

  if ((PANE_NEEDS as readonly string[]).includes(t.needs)) {
    const need = t.needs as PaneNeed;
    const w = PANE_WORDS[need];
    if (env.focusedFits?.includes(need)) return { ok: true, label: `Try: ${verb} → ${w.these}`, action: t.action, pane: env.focused, back: false, writes };
    if (env.focusedKind === "hub" && env.previousFits?.includes(need))
      return { ok: true, label: `Try: ${verb} → ${w.the}`, action: t.action, pane: env.focused, back: true, writes };
    const p = env.panes?.[need]?.[0];
    return p ? { ok: true, label: `Try: ${verb} → ${w.the}`, action: t.action, pane: p, back: false, writes } : fail(w.missing);
  }

  const cur = env.current;
  if (!cur) return fail(t.needs === "pod" ? "select a pod first" : t.needs === "podRow" ? "select a pod in the pods table first" : t.needs === "workload" ? "select a workload first" : t.needs === "twoMarks" ? "mark two rows first (Space)" : "select a row in a table first");
  if (t.needs === "pod" && !isPod(cur.ref)) return fail("select a pod first");
  if (t.needs === "podRow" && (!isPod(cur.ref) || cur.kind !== "table")) return fail("select a pod in the pods table first");
  if (t.needs === "workload" && !isWorkload(cur.ref)) return fail("select a workload first (pod, deployment, statefulset, job …)");
  if (t.needs === "twoMarks" && cur.marked.length < 2) return fail("mark two rows first (Space)");
  // the hub sits in place over the source table: go back to it, then run there
  const back = cur.paneId === env.focused && env.focusedKind !== null && !TABLE_LIKE.has(env.focusedKind);
  // a table drops its marks when it is left, so they would be gone after going back
  if (back && t.needs === "twoMarks") return fail("marks are dropped when the table is left: open the hub beside the table (+ Ctrl+Shift+H)");
  const target = t.needs === "twoMarks" ? `${cur.marked.length} marked` : cur.container ? `${refLabel(cur.ref)} · ${cur.container}` : refLabel(cur.ref);
  return { ok: true, label: `Try: ${verb} → ${target}`, action: t.action, pane: cur.paneId, back, waitFor: back ? cur.ref : undefined, writes };
}

// ── mouse paths ────────────────────────────────────────────────────────────

/** Membership of the pointer registries (ROW_ACTIONS, ROW_MENU, BULK_ACTIONS, the window menu, the titlebar). */
export interface PointerLists {
  rowBar: ReadonlySet<string>;
  rowMenu: ReadonlySet<string>;
  bulk: ReadonlySet<string>;
  windowMenu: ReadonlySet<string>;
  /** titlebar buttons: action → what the button is called */
  titlebar: ReadonlyMap<string, string>;
}

/** "How to start it with the mouse", one line per path, derived from where its actions are. */
export function mousePaths(actions: readonly ActionId[], lists: PointerLists, label: (id: ActionId) => string): string[] {
  const buttons: string[] = [];
  const menu: string[] = [];
  const bar: string[] = [];
  const rowMenu: string[] = [];
  const bulk: string[] = [];
  for (const id of actions) {
    const l = label(id) || id;
    const button = lists.titlebar.get(id);
    if (button) buttons.push(button);
    if (lists.windowMenu.has(id)) menu.push(l);
    if (lists.rowBar.has(id)) bar.push(l);
    if (lists.rowMenu.has(id)) rowMenu.push(l);
    if (lists.bulk.has(id)) bulk.push(l);
  }
  const out: string[] = [];
  const list = (xs: string[]) => [...new Set(xs)].join(", ");
  if (buttons.length) out.push(`Titlebar: the ${list(buttons)} button${buttons.length > 1 ? "s" : ""}`);
  if (menu.length) out.push(`Titlebar ⋯ menu → ${list(menu)}`);
  if (bar.length) out.push(`Hover a table row → ${list(bar)}`);
  if (rowMenu.length) out.push(`Right-click a row → ${list(rowMenu)}`);
  if (bulk.length) out.push(`Mark rows → bulk bar → ${list(bulk)}`);
  return out;
}

// ── docs/tools.md sections ─────────────────────────────────────────────────

export interface DocSection {
  id: string;
  title: string;
  body: string;
}

const ANCHOR = /^\s*<a id="([a-z0-9-]+)"><\/a>\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const COMMENT = /^\s*<!--.*-->\s*$/;

/** Every anchor id in the markdown (`<a id="why"></a>` on the line before a heading). */
export function docAnchors(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = ANCHOR.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Drops anchor and comment lines (the text view would show them as text). */
const cleanLines = (lines: string[]): string => lines.filter((l) => !ANCHOR.test(l) && !COMMENT.test(l)).join("\n").trim();

/**
 * The section under `<a id="anchor"></a>`: its heading as the title, and everything up to the next
 * heading of the same or a higher level as the body (sub-headings stay in). Null when absent.
 */
export function docSection(md: string, anchor: string): DocSection | null {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => ANCHOR.exec(l)?.[1] === anchor);
  if (at < 0) return null;
  let h = at + 1;
  while (h < lines.length && !lines[h].trim()) h++;
  const head = HEADING.exec(lines[h] ?? "");
  if (!head) return null;
  const level = head[1].length;
  let end = h + 1;
  for (; end < lines.length; end++) {
    const m = HEADING.exec(lines[end]);
    if (m && m[1].length <= level) break;
  }
  // an anchor line right before the next heading belongs to that heading
  while (end - 1 > h && (ANCHOR.test(lines[end - 1]) || !lines[end - 1].trim())) end--;
  return { id: anchor, title: head[2], body: cleanLines(lines.slice(h + 1, end)) };
}

/** The whole document as sections, one per `##` heading (the text before the first is the intro). */
export function docSections(md: string): DocSection[] {
  const lines = md.split(/\r?\n/);
  const out: DocSection[] = [];
  let title = "";
  let id = "intro";
  let buf: string[] = [];
  const flush = () => {
    const body = cleanLines(buf);
    if (body || title) out.push({ id, title, body });
  };
  let pendingAnchor: string | null = null;
  for (const line of lines) {
    const a = ANCHOR.exec(line);
    if (a) {
      pendingAnchor = a[1];
      continue;
    }
    const m = HEADING.exec(line);
    if (m && m[1].length <= 2) {
      flush();
      title = m[2];
      id = pendingAnchor ?? m[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      buf = [];
    } else buf.push(line);
    pendingAnchor = null;
  }
  flush();
  return out.filter((s) => s.title || s.body);
}

/** The anchor of a catalog `doc` link ("docs/tools.md#why" → "why"). */
export const docAnchor = (doc: string): string => doc.split("#")[1] ?? "";
