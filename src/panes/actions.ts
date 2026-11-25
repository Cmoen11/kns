// Handlers for the pane, window, history and navigation actions of docs/ux.md §5.4.
// Imported eagerly by main.tsx. No key is named here: bindings live in the keymap table.
import { registerActions, registry, type ActionContext, type ActionHandler, type ActionId } from "../actions";
import { isTauri } from "../ipc";
import { engine, newPanePrefixHandlers } from "../keys";
import { reconnect } from "../store/cluster";
import { RESIZE_FINE, RESIZE_STEP } from "../store/geometry";
import * as L from "../store/layout";
import { animateLayout } from "./animate";
import type { Edge } from "../store/layout-tree";
import { flash } from "../store/status";
import { confirm } from "../ui/confirm";
import { parentCrumb } from "../views/registry";
import { sameView } from "./crumbs";
import * as M from "./modes";

const EDGES: Record<"Left" | "Down" | "Up" | "Right", Edge> = { Left: "left", Down: "down", Up: "up", Right: "right" };
const paneCount = () => L.paneOrder().length;
const many = () => paneCount() > 1 || "only one pane";

/** One handler per direction for an id family like pane.focusLeft / Down / Up / Right. */
function byEdge<P extends string>(prefix: P, make: (edge: Edge) => ActionHandler | ActionHandler["run"]) {
  const out: Partial<Record<ActionId, ActionHandler | ActionHandler["run"]>> = {};
  for (const [suffix, edge] of Object.entries(EDGES)) out[`${prefix}${suffix}` as ActionId] = make(edge);
  return out;
}

/** Ctrl/⌘+Enter and Alt+Enter are `Enter` with a new-pane direction (§4.4), in tables and in lists. */
function besideTarget(): ActionId | null {
  const id: ActionId = engine.snapshot().scopes.includes("olist") ? "list.accept" : "nav.open";
  return registry.get(id)?.built ? id : null;
}
const openBeside = (dir: "right" | "down"): ActionHandler => ({
  when: () => besideTarget() !== null,
  run: (ctx) => {
    const id = besideTarget();
    if (id) engine.run(id, { source: ctx.source, newPane: dir, args: ctx.args });
  },
});

/** Backspace (§4.3): to the parent crumb; index − 1 when the previous entry is that parent, else a push. */
function crumbUp(): void {
  const id = L.focusedPane();
  const state = id && L.paneState(id);
  if (!id || !state) return;
  const parent = parentCrumb(state.history[state.index]);
  const prev = state.index > 0 ? state.history[state.index - 1] : null;
  if (!parent || (prev && sameView(prev, parent))) L.goBack(id);
  else L.openView(parent, { pane: id });
}

async function closeWindow(): Promise<void> {
  const ending = L.allLiveSessions().filter((s) => s.onClose === "ends").map((s) => s.label);
  if (ending.length > 0) {
    const ok = await confirm({ tier: 1, title: "Close kns", body: "These sessions end.", items: ending, confirmLabel: "Close", cancelLabel: "Stay" });
    if (!ok) return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

async function toggleFullscreen(): Promise<void> {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}

const splitArg = (ctx: ActionContext, fallback: "right" | "down") => {
  const a = ctx.args[0];
  return a === "d" || a === "down" ? "down" : a === "r" || a === "right" ? "right" : fallback;
};

export const unregisterPaneActions = registerActions({
  // `+` prefix (§4.1): openView honours ctx.newPane with the §4.4 target rule
  ...newPanePrefixHandlers(),
  "open.newPaneRight": openBeside("right"),
  "open.newPaneDown": openBeside("down"),

  "pane.splitRight": (ctx) => void L.splitPane(splitArg(ctx, "right")),
  "pane.splitDown": (ctx) => void L.splitPane(splitArg(ctx, "down")),
  ...byEdge("pane.focus", (edge) => () => void L.focusDirection(edge)),
  "pane.next": () => void L.focusNextPane(1),
  "pane.previous": () => void L.focusNextPane(-1),
  "pane.last": { enabled: many, run: () => void L.focusLastPane() },
  "pane.focusN": {
    enabled: (ctx) => ctx.digit === undefined || ctx.digit <= paneCount() || `no pane ${ctx.digit}`,
    run: (ctx) => {
      const n = ctx.digit ?? Number(ctx.args[0]);
      if (Number.isInteger(n)) L.focusPaneIndex(n);
    },
  },
  ...byEdge("pane.move", (edge) => ({ enabled: many, run: () => void animateLayout(() => L.movePane(edge)) })),
  "pane.moveMode": { enabled: many, run: M.startMove },
  ...byEdge("move.target", (edge) => () => M.moveTarget(edge)),
  ...byEdge("move.insert", (edge) => () => M.moveInsert(edge)),
  "move.swap": M.moveSwap,
  "move.cancel": M.cancelMove,
  ...byEdge("pane.resize", (edge) => ({ enabled: many, run: () => void L.resizePane(edge, RESIZE_STEP) })),
  "pane.resizeMode": { enabled: many, run: M.startResize },
  ...byEdge("resize.step", (edge) => () => void L.resizePane(edge, RESIZE_STEP)),
  ...byEdge("resize.fine", (edge) => () => void L.resizePane(edge, RESIZE_FINE)),
  "resize.done": M.endResize,
  "pane.zoom": { enabled: many, run: () => void L.toggleZoom() },
  "pane.equalize": { enabled: many, run: () => void L.equalizePanes() },
  "pane.equalizeAll": { enabled: many, run: () => void L.equalizeAllPanes() },
  "pane.flipSplit": { enabled: many, run: () => void animateLayout(() => L.flipSplit()) },
  "pane.followToggle": {
    when: () => {
      const k = L.paneView()?.kind;
      return k !== "shell" && k !== "attach";
    },
    run: () => void L.toggleFollow(),
  },
  "pane.close": () => void L.closePane(),
  "pane.closeOthers": { enabled: many, run: () => void L.closeOtherPanes() },
  "pane.reopenClosed": { enabled: () => L.canReopen() || "no closed pane to reopen", run: () => void L.reopenPane() },

  "history.back": { enabled: () => L.canGoBack() || "no earlier view", run: () => void L.goBack() },
  "history.forward": { enabled: () => L.canGoForward() || "no later view", run: () => void L.goForward() },
  "history.last": {
    enabled: () => {
      const id = L.focusedPane();
      const p = id ? L.paneState(id) : undefined;
      return (!!p && p.last !== undefined && p.last !== p.index) || "no last view";
    },
    run: () => void L.goLast(),
  },
  // Esc ladder step 9 (§4.2): the last rung; at the root Esc falls through and does nothing
  "nav.back": { when: () => L.canGoBack(), run: () => void L.goBack() },
  "nav.crumbUp": {
    when: () => {
      const v = L.paneView();
      return !!v && (parentCrumb(v) !== null || L.canGoBack());
    },
    run: crumbUp,
  },

  "conn.reconnect": () => {
    reconnect();
    flash("reconnecting");
  },
  "window.fullscreen": toggleFullscreen,
  // a single-window app: closing the window quits. Only meaningful inside Tauri.
  "window.close": { when: () => isTauri, run: closeWindow },
  "app.quit": { when: () => isTauri, run: closeWindow },
});
