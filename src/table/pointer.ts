// What the mouse can reach in a table (docs/frontend.md §17): the actions of the row bar, the
// row menu, the bulk bar and the pane toolbar. Lists of action ids only; an action that is not
// built or not in the pane's scopes (shell on a deployment, scale on a pod) drops out by itself.
import type { ActionId, IconName, MenuEntry, ToolbarAction, ToolbarItem } from "../foundation";

const i = (action: ActionId, icon?: IconName): ToolbarAction => (icon ? { action, icon } : { action });

/**
 * Row actions in priority order: a narrow pane shows the first few, the rest are in "more".
 * The hover bar runs them on the hovered row, the pane toolbar on the cursor row (or the marks).
 */
export const ROW_ACTIONS: readonly ToolbarAction[] = [
  i("res.logs"),
  i("pod.shell"),
  i("res.describe"),
  i("res.why"),
  i("workload.scale"),
  i("workload.restart", "restart"),
  i("res.yaml"),
  i("res.edit"),
  i("pf.start"),
  i("res.timeline"),
  i("dev.fromWorkload"),
  i("pod.debug"),
  i("res.pack"),
  i("cronjob.trigger", "play"),
  i("flux.reconcile", "sync"),
  i("flux.suspendResume", "pause"),
  i("namespace.use", "open"),
  i("secret.decode", "eye"),
  i("res.delete"),
];

/**
 * Right-click on a row, and the row bar's "more": everything that acts on a row, as groups.
 * Open and read first, then what runs against the object, what changes it, where it leads,
 * the clipboard and marks, and the destructive actions last.
 */
export const ROW_MENU_GROUPS: readonly (readonly ActionId[])[] = [
  ["nav.open", "res.describe", "res.yaml", "res.edit", "res.why", "res.timeline"],
  ["res.logs", "res.logsPrevious", "pod.shell", "pod.attach", "pf.start", "secret.decode", "dev.fromWorkload", "res.reach", "res.trap", "snippet.run"],
  [
    "workload.scale", "workload.restart", "cronjob.trigger", "cronjob.suspend", "flux.reconcile", "flux.reconcileWithSource",
    "flux.suspendResume", "node.cordon", "node.uncordon", "pod.debug",
  ],
  ["deploy.replicaSets", "res.owner", "pod.node", "res.relations", "namespace.use"],
  ["copy.name", "copy.namespace", "res.pack", "res.kubectl", "pod.mirrord", "mark.toggle"],
  ["res.delete", "pod.kill"],
];
/** the group that leads somewhere else: "show only this namespace" joins it */
const RELATED = 3;

/**
 * The row menu: the groups with a rule between them (a group none of whose actions applies to
 * this kind leaves no rule behind). In an all-namespaces table it has "show only this namespace"
 * (`namespace.pick <ns>`).
 */
export function rowMenu(ns: string | null): readonly MenuEntry[] {
  const out: MenuEntry[] = [];
  ROW_MENU_GROUPS.forEach((group, g) => {
    if (g > 0) out.push("|");
    out.push(...group);
    if (g === RELATED && ns !== null) out.push({ action: "namespace.pick", label: `show only namespace ${ns}`, args: [ns], binding: -1 });
  });
  return out;
}

/** The bulk bar: only actions that apply to every marked row (describe and shell take one row; logs merge the marks). */
export const BULK_ACTIONS: readonly ToolbarItem[] = [
  i("res.logs"),
  i("workload.restart", "restart"),
  i("workload.scale"),
  i("cronjob.trigger", "play"),
  i("cronjob.suspend", "pause"),
  i("flux.reconcile", "sync"),
  i("flux.suspendResume", "pause"),
  { action: "node.cordon", icon: null },
  { action: "node.uncordon", icon: null },
  i("res.diff"),
  i("res.pack"),
  i("copy.name"),
  i("res.delete"),
  "|",
  { action: "mark.all", icon: "check" },
  { action: "mark.clear", icon: "close" },
];

/** The pane header's toolbar. The filter comes first, so the overflow never hides it. */
export function paneToolbar(faultsOnly: boolean, wide: boolean): ToolbarItem[] {
  return [
    "filter.open",
    { action: "filter.faults", icon: "fault", active: faultsOnly },
    "|",
    ...ROW_ACTIONS,
    "|",
    { action: "view.wide", icon: "wide", active: wide },
    "view.columns",
    "view.refresh",
    // shown only where it applies (the containers view: crash card)
    "hub.help",
  ];
}

/** How many row-bar buttons a pane of this width shows before "more". */
export const rowBarMax = (width: number): number => (width < 320 ? 2 : width < 480 ? 3 : width < 640 ? 4 : width < 880 ? 6 : 8);

/** px from a row's left edge that count as its checkbox: the 12px gutter plus the name cell's padding */
export const CHECK_HIT = 18;
