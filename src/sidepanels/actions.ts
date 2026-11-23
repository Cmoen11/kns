// Action handlers of the side panels. Small and eager; no key is named here (keymap-data.ts) and
// nothing here touches the DOM at import. The row under the cursor carries what Enter, x, c and o do.
import { registerActions, type ActionContext } from "../actions";
import { getSettings, setSettings } from "../store/settings";
import { flash } from "../store/status";
import { getHealth } from "../status/health";
import { nsCount } from "../status/health-model";
import { openFaults } from "../status/faults";
import { clearFinished } from "./activity";
import { headerKey, type PanelRow, type Side } from "./model";
import {
  activateRow, cursorOf, cursorSection, cursorTo, focusedSide, focusFilter, focusPanel, leavePanel, moveCursor, panelRows, runStop, runtimeStore,
  setCollapsed, setCursorKey, setFilter, stepWidth, togglePanel,
} from "./store";

const side = (): Side | null => focusedSide();
const inPanel = (): boolean => side() !== null;
/** Left / Right / Home / End move the caret while the filter input has the focus. */
const onRows = (): boolean => inPanel() && !(document.activeElement instanceof HTMLInputElement);
const row = (): PanelRow | undefined => {
  const s = side();
  return s ? cursorOf(s).row : undefined;
};
const on = (fn: (s: Side) => void) => () => {
  const s = side();
  if (s) fn(s);
};

/** The header of the cursor row's section (stop-all lives on it). */
const sectionHeader = (): PanelRow | undefined => {
  const s = side();
  const r = row();
  return s && r ? panelRows(s).find((x) => x.key === headerKey(r.section)) : undefined;
};

/**
 * Mouse parity: a row button names its row (`args[0]` is the row's key, or the section for a
 * header button), so it works while the keyboard focus stays in a pane. Keys act on the cursor row
 * of the focused panel, as before.
 */
const pointed = (ctx: ActionContext): boolean => ctx.source === "pointer" && ctx.args[0] !== undefined;
const targetRow = (ctx: ActionContext): PanelRow | undefined => (pointed(ctx) ? panelRows("right").find((r) => r.key === ctx.args[0]) : row());
const targetHeader = (ctx: ActionContext): PanelRow | undefined =>
  pointed(ctx) ? panelRows("right").find((r) => r.key === headerKey(ctx.args[0])) : sectionHeader();
/** The namespace a sidebar action is about: the pointer's arg, else the cursor row (`ns:<name>`). */
function sidebarNamespace(ctx: ActionContext): string | null {
  if (ctx.source === "pointer" && ctx.args[0] !== undefined) return ctx.args[0];
  const r = side() === "left" ? row() : undefined;
  return r?.health ?? null;
}
const inActivity = (ctx: ActionContext): boolean => side() === "right" || pointed(ctx);

const rowAction = (pick: (r: PanelRow) => (() => unknown) | undefined, none: string, stop = false) => ({
  when: inActivity,
  enabled: (ctx: ActionContext) => {
    const r = targetRow(ctx);
    return (!!r && pick(r) !== undefined) || none;
  },
  run: async (ctx: ActionContext) => {
    const r = targetRow(ctx);
    const fn = r && pick(r);
    if (stop) await runStop("right", fn || undefined);
    else if (fn) await fn();
  },
});

registerActions({
  // ── global: show / hide and focus ──
  "sidebar.toggle": () => togglePanel("left"),
  "sidebar.focus": () => focusPanel("left"),
  "activity.toggle": () => togglePanel("right"),
  "activity.focus": () => focusPanel("right"),

  // ── inside a panel ──
  "side.down": { when: inPanel, run: on((s) => moveCursor(s, 1)) },
  "side.up": { when: inPanel, run: on((s) => moveCursor(s, -1)) },
  "side.top": { when: onRows, run: on((s) => cursorTo(s, "top")) },
  "side.bottom": { when: onRows, run: on((s) => cursorTo(s, "bottom")) },
  "side.nextSection": { when: inPanel, run: on((s) => cursorSection(s, 1)) },
  "side.previousSection": { when: inPanel, run: on((s) => cursorSection(s, -1)) },
  "side.activate": {
    when: inPanel,
    enabled: () => row() !== undefined || "nothing selected",
    run: async () => {
      const s = side();
      const r = row();
      if (!s || !r) return;
      if (r.disabled && !r.header) return flash(r.disabled, "warn");
      await activateRow(s, r);
    },
  },
  "side.collapse": {
    when: onRows,
    run: on((s) => {
      const r = cursorOf(s).row;
      if (r) setCollapsed(s, r.section, true);
    }),
  },
  "side.expand": {
    when: onRows,
    run: on((s) => {
      const r = cursorOf(s).row;
      if (r) setCollapsed(s, r.section, false);
    }),
  },
  "side.narrower": { when: inPanel, run: on((s) => stepWidth(s, -1)) },
  "side.wider": { when: inPanel, run: on((s) => stepWidth(s, 1)) },
  // Esc: a filter is dropped first, then focus goes back to the pane it came from
  "side.leave": {
    when: inPanel,
    run: () => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (side() === "left" && (typing || runtimeStore.getState().filter !== "")) {
        setFilter("");
        // the panel element takes the focus back from the input
        runtimeStore.setState((s) => ({ focusTick: s.focusTick + 1 }));
        return;
      }
      leavePanel();
    },
  },

  // ── context sidebar ──
  "sidebar.filter": { when: () => side() === "left", run: focusFilter },
  // the namespace's faulty objects (a badge click names its namespace; the key takes the cursor row)
  "health.nsFaults": {
    when: (ctx) => side() === "left" || (ctx.source === "pointer" && ctx.args[0] !== undefined),
    enabled: (ctx) => {
      const ns = sidebarNamespace(ctx);
      if (ns === null) return "not a namespace";
      const h = getHealth();
      if (!h.known) return h.snapshot ? `namespace health is ${h.snapshot.state}` : "namespace health is off";
      return (ns === "*" ? h.totals.count : nsCount(h.byNs.get(ns))) > 0 || `nothing failing in ${ns === "*" ? "any namespace" : ns}`;
    },
    run: (ctx) => {
      const ns = sidebarNamespace(ctx);
      if (ns === null) return;
      openFaults(ns, ctx.newPane);
      if (side() === "left") leavePanel();
    },
  },
  "sidebar.problemsFirst": {
    when: () => side() === "left",
    run: () => {
      const on = !getSettings().nsProblemsFirst;
      setSettings({ nsProblemsFirst: on });
      flash(on ? "namespaces: problems first" : "namespaces: by name");
    },
  },

  // ── activity panel ──
  "activity.stop": rowAction((r) => r.stop, "nothing to stop here", true),
  "activity.copyAddress": rowAction((r) => r.copy, "nothing to copy here"),
  "activity.openBrowser": rowAction((r) => r.open, "only a port-forward opens in the browser"),
  "activity.stopAll": {
    when: inActivity,
    enabled: (ctx) => targetHeader(ctx)?.stopAll !== undefined || "nothing to stop in this group",
    run: (ctx) => runStop("right", targetHeader(ctx)?.stopAll),
  },
  "activity.clearFinished": {
    when: inActivity,
    run: (ctx) => {
      // a feature group (groups.ts) empties itself; otherwise the Finished history
      const h = targetHeader(ctx);
      if (h?.clear) {
        void h.clear();
        setCursorKey("right", h.key);
        return;
      }
      clearFinished();
      setCursorKey("right", headerKey("finished"));
    },
  },
});
