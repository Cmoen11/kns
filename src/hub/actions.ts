// The Tools hub's actions (docs/plan-features.md §2.7, §3 I): hub.open, hub.detail, hub.help, and
// the list keys of the hub view (nav.*, nav.open = Try, filter.*). Small and eager; the view and
// the docs text are lazy chunks.
import {
  actionState, engine, flash, focusedPane, focusPane, getSelection, getWorkspace, goBack, openView, paneOrder, paneView,
  registerActions, registerViewActions, registry, replaceView, sameRef, type ActionContext, type ActionId,
} from "../foundation";
import { WINDOW_MENU } from "../shell/window-menu";
import { currentObject } from "../store/current";
import { currentView } from "../store/workspace";
import { BULK_ACTIONS, ROW_ACTIONS, ROW_MENU_GROUPS } from "../table/pointer";
import type { ObjectRef, PaneId, ViewKind, ViewState } from "../types";
import { isToolId, toolById, toolForKind, toolForView, type ToolEntry, type ToolId } from "./catalog";
import { hubCtl } from "./controller";
import { guideById } from "./guides";
import { docAnchor, mousePaths, PANE_NEEDS, resolveTry, viewFits, type PaneNeed, type PointerLists, type TryEnv, type TryPlan } from "./model";

/**
 * The tool `hub.open` lands on: the named one (a guide id names the entry that shows it), else the
 * one the focused view belongs to (a kind, or the view itself so text views resolve by source).
 */
export function hubTarget(arg: string | undefined, focused: ViewState | string | undefined): { tool?: ToolId; error?: string } {
  if (arg) {
    if (isToolId(arg)) return { tool: arg };
    const g = guideById(arg);
    return g ? { tool: g.tool } : { error: `no tool "${arg}"` };
  }
  const t = typeof focused === "string" ? toolForKind(focused as ViewKind) : toolForView(focused);
  return t ? { tool: t.id } : {};
}

const label = (id: ActionId): string => registry.get(id)?.label ?? "";

// ── try it ─────────────────────────────────────────────────────────────────

/** The window as resolveTry sees it. */
export function tryEnv(): TryEnv {
  const ws = getWorkspace();
  const focused = ws?.focused ?? null;
  const p = focused ? ws?.panes[focused] : undefined;
  const prev = p && p.index > 0 ? p.history[p.index - 1] : undefined;
  const panes: Partial<Record<PaneNeed, PaneId[]>> = {};
  for (const id of paneOrder()) {
    const q = ws?.panes[id];
    if (!q) continue;
    for (const need of viewFits(currentView(q))) (panes[need] ??= []).push(id);
  }
  // the focused pane first: a tool tried from beside a logs pane prefers the one with focus
  for (const need of PANE_NEEDS) panes[need]?.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : 0));
  const view = p ? currentView(p) : null;
  return {
    focused,
    focusedKind: view ? view.kind : null,
    previousKind: prev ? prev.kind : null,
    focusedFits: viewFits(view),
    previousFits: viewFits(prev),
    current: currentObject(),
    panes,
    label,
  };
}

/** The Try plan for a tool right now (the button label and its disabled reason). */
export const tryPlan = (tool: ToolEntry): TryPlan => resolveTry(tool, tryEnv());

const WAIT_MS = 3000;
/** Waits (a frame at a time, bounded) until `ready` holds. No idle timer: it ends either way. */
function waitUntil(ready: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (ready()) return resolve(true);
      if (performance.now() - start > WAIT_MS) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Runs a tool's Try action on the current object: from the pane that holds it (going back first
 * when the hub was opened in place over it), so the action reads the same cursor its key would.
 * Writing tools only open their own dialog; nothing here confirms on their behalf.
 */
export async function runTry(id: ToolId, newPane: ActionContext["newPane"]): Promise<boolean> {
  const tool = toolById(id);
  return tool ? runToolTry(tool, newPane) : false;
}

/** runTry for any entry: a catalog tool, or a guide step as a tool (src/hub/guides.ts stepAsTool). */
export async function runToolTry(tool: ToolEntry, newPane: ActionContext["newPane"]): Promise<boolean> {
  const plan = tryPlan(tool);
  if (!plan.ok) {
    flash(plan.reason, "warn");
    return false;
  }
  const opts = { source: "pointer" as const, newPane: registry.get(plan.action)?.opens === "view" ? newPane : null };
  if (plan.pane === null) return engine.run(plan.action, opts);
  const pane: PaneId = plan.pane;
  if (plan.back) goBack(pane);
  else if (focusedPane() !== pane) focusPane(pane);
  const waitFor: ObjectRef | undefined = plan.waitFor;
  const ready = () => {
    if (waitFor && !sameRef(getSelection(pane).focused, waitFor)) return false;
    const s = actionState(plan.action, { pane });
    return s.present && s.enabled;
  };
  if (plan.back || !ready()) {
    if (!(await waitUntil(ready))) {
      const s = actionState(plan.action, { pane });
      flash(s.reason ?? `${label(plan.action) || plan.action} is not available there`, "warn");
      return false;
    }
  }
  return engine.run(plan.action, opts);
}

// ── mouse paths ────────────────────────────────────────────────────────────

const WINDOW_MENU_ACTIONS = WINDOW_MENU.filter((e): e is ActionId => typeof e === "string" && e !== "|");

let lists: PointerLists | null = null;
export function pointerLists(): PointerLists {
  return (lists ??= {
    rowBar: new Set(ROW_ACTIONS.map((a) => a.action)),
    rowMenu: new Set(ROW_MENU_GROUPS.flat()),
    bulk: new Set(BULK_ACTIONS.flatMap((a) => (typeof a === "object" && "action" in a ? [a.action] : []))),
    windowMenu: new Set(WINDOW_MENU_ACTIONS),
    titlebar: new Map([["hub.open", "tools"], ["palette.open", "“Search or run”"], ["home.open", "home"], ["help.overlay", "help"], ["settings.open", "settings"]]),
  });
}

/** Mouse paths of the tool's built actions. */
export const toolMousePaths = (tool: ToolEntry): string[] =>
  mousePaths(tool.actions.filter((a) => registry.get(a)?.built), pointerLists(), label);

// ── opening ────────────────────────────────────────────────────────────────

/** Opens the docs/tools.md section of a tool as a text view ("Learn more"). */
export function openToolDoc(id: ToolId, newPane: ActionContext["newPane"]): void {
  const tool = toolById(id);
  if (!tool) return;
  openView({ kind: "text", title: `Tools: ${tool.title}`, source: { by: "doc", anchor: docAnchor(tool.doc) } }, { newPane });
}

const onHub = () => paneView()?.kind === "hub";

registerActions({
  "hub.open": (ctx) => {
    const current = paneView();
    const { tool, error } = hubTarget(ctx.args[0], current ?? undefined);
    if (error) return flash(error, "warn");
    const view = tool ? { kind: "hub" as const, tool } : { kind: "hub" as const };
    // already on the hub: change the selected tool in place, so `back` still reaches the table it
    // was opened over (and currentObject() still finds that table's cursor)
    const pane = focusedPane();
    if (current?.kind === "hub" && pane && !ctx.newPane) replaceView(pane, tool ? view : current);
    else openView(view, { newPane: ctx.newPane });
  },
  "hub.detail": { when: onHub, run: () => hubCtl()?.toggleDetail() },
  "hub.help": {
    // on the hub: the docs section of the tool under the cursor; elsewhere: the hub at the tool this view belongs to
    when: () => {
      const v = paneView();
      return !!v && (v.kind === "hub" || !!toolForView(v));
    },
    enabled: () => !onHub() || !!hubCtl()?.current() || "no tool selected",
    run: (ctx) => {
      const v = paneView();
      if (!v) return;
      if (v.kind === "hub") {
        const id = hubCtl()?.current();
        if (id) openToolDoc(id, ctx.newPane);
        return;
      }
      const t = toolForView(v);
      if (t) openView({ kind: "hub", tool: t.id }, { newPane: ctx.newPane });
    },
  },
});

// Ids every list-like view implements: registered for the hub kind (docs/frontend.md §9).
registerViewActions(["hub"], {
  "nav.down": () => hubCtl()?.move(1),
  "nav.up": () => hubCtl()?.move(-1),
  "nav.top": () => hubCtl()?.top(),
  "nav.bottom": () => hubCtl()?.bottom(),
  "nav.pageDown": () => hubCtl()?.page(1),
  "nav.pageUp": () => hubCtl()?.page(-1),
  // Enter = try on the current object (§2.7)
  "nav.open": {
    enabled: () => {
      const id = hubCtl()?.current();
      const tool = id ? toolById(id) : undefined;
      if (!tool) return "no tool selected";
      const plan = tryPlan(tool);
      return plan.ok || plan.reason;
    },
    run: (ctx) => {
      const id = hubCtl()?.current();
      if (id) void runTry(id, ctx.newPane);
    },
  },
  "filter.open": () => hubCtl()?.filterOpen(),
  "filter.apply": { when: () => !!hubCtl()?.isFiltering(), run: () => hubCtl()?.filterApply() },
  "filter.cancel": { when: () => !!hubCtl()?.isFiltering(), run: () => hubCtl()?.filterCancel() },
  // Esc ladder (ux §4.2): absent without a filter, so Esc falls through to nav.back
  "filter.clear": { when: () => !!hubCtl()?.hasFilter() && !hubCtl()?.isFiltering(), run: () => hubCtl()?.filterClear() },
});
