// Handlers for the palette, command line, pickers, favourites, namespace slots and the menu
// (docs/ux.md §5.4). Small and eager: the overlays themselves load lazily. No key is named here.
// The `/` filter bar is the table's and the `?` overlay is src/views/tools': they own those ids.
import { LAYERS } from "../actions";
import {
  focusedContext, flash, getCluster, openPaneInContext, setPaneContext, focusedPane, isOverlayOpen, paneOrder, paneView, registerActions, resourceFor, setNamespace,
  setNamespaceAllPanes, switchContext, closeTab, closeOtherTabs, stepTab, openTabs, type ActionContext,
} from "../foundation";
import { contextFlags } from "../store/settings";
import { takeMenuRequest } from "../ui";
import { setProtected } from "./context";
import { nameAndSlot, saveLayoutDirect, saveViewDirect } from "./favourites/save";
import { parseSlot } from "./favourites/slots";
import { favouriteInSlot, layoutInSlot, namespaceInSlot, noteNamespaceUsed, recallFavourite, recallLayout } from "./favourites/store";
import { anyOpen, dismiss, open, openCommandBar, topController } from "./session";

const listOpen = () => topController() !== undefined;
const extra = (name: string) => ({
  when: () => topController()?.extra?.[name] !== undefined,
  run: () => topController()?.extra?.[name]?.(),
});

/** Opens the palette with a prefix; the same key again closes it. */
function palette(text: string, ctx: ActionContext): void {
  if (isOverlayOpen("palette") && ctx.source === "key") return dismiss();
  open("palette", text === "'" ? LAYERS.pickerFavourites : LAYERS.palette, { text, newPane: ctx.newPane });
}

function tableNamespaceState(): true | string {
  const v = paneView();
  if (v?.kind !== "table") return "this view has no namespace";
  if (resourceFor(v.gvr)?.namespaced === false) return `${v.gvr.resource} are cluster-scoped`;
  return true;
}
const anyTablePane = () => paneOrder().some((p) => paneView(p)?.kind === "table") || "no table pane";
const nsArg = (a: string) => (a === "all" || a === "-A" ? "*" : a);

const slotOf = (ctx: ActionContext): number | undefined => ctx.digit ?? parseSlot(ctx.args[0]);

function onOff(ctx: ActionContext, current: boolean, usage: string): boolean | null {
  const arg = ctx.args[0];
  if (arg === undefined) return !current;
  if (arg === "on" || arg === "off") return arg === "on";
  flash(`usage: ${usage}`, "warn");
  return null;
}

registerActions({
  // ── palette, command line, lists ──
  "palette.open": (ctx) => palette(ctx.args[0] ?? "", ctx),
  "fav.picker": (ctx) => palette("'", ctx),
  "command.open": (ctx) => void openCommandBar(LAYERS.command, ctx.newPane),
  "list.down": { when: listOpen, run: () => topController()?.down() },
  "list.up": { when: listOpen, run: () => topController()?.up() },
  "list.accept": { when: listOpen, run: (ctx) => topController()?.accept(ctx.newPane) },
  // also before the lazy overlay has mounted: Esc must always get out
  "list.close": { when: () => listOpen() || anyOpen(), run: () => (topController() ?? { close: dismiss }).close() },
  // Tab is ours in every completion input, also when there is nothing to complete (§5.2)
  "palette.complete": { when: listOpen, run: () => topController()?.complete?.() },
  "picker.rename": extra("rename"),
  "picker.delete": extra("delete"),
  "picker.moveSlotUp": extra("slotUp"),
  "picker.moveSlotDown": extra("slotDown"),
  "picker.toggleNsFavourite": extra("pin"),
  "picker.toggleProtected": extra("protect"),
  "menu.open": () => {
    // a pointer request (right-click, a "more" button) says where and what; it always opens
    const request = takeMenuRequest();
    if (!request && isOverlayOpen("palette.menu")) return dismiss();
    open("palette.menu", LAYERS.menu, request);
  },

  // ── context (§8.2) ──
  "context.pick": async (ctx) => {
    const name = ctx.args[0];
    if (name === undefined) return open("palette.picker", LAYERS.pickerContext, { kind: "ctx", pane: false });
    dismiss();
    if (!(await switchContext(name)) && focusedContext() !== name) flash(`no context "${name}"`, "warn");
  },
  // context tabs (§8.2): every switch opens or goes to a tab; the tab left behind stays warm
  "tab.next": { enabled: () => openTabs().length > 1 || "only one tab is open", run: () => void stepTab(1) },
  "tab.previous": { enabled: () => openTabs().length > 1 || "only one tab is open", run: () => void stepTab(-1) },
  "tab.close": {
    enabled: () => openTabs().length > 1 || "the last tab stays open",
    run: async (ctx) => {
      const name = ctx.args[0];
      if (name !== undefined && !openTabs().includes(name)) return flash(`no tab "${name}"`, "warn");
      await closeTab(name);
    },
  },
  "tab.closeOthers": {
    enabled: () => openTabs().length > 1 || "only one tab is open",
    run: async (ctx) => {
      const name = ctx.args[0];
      if (name !== undefined && !openTabs().includes(name)) return flash(`no tab "${name}"`, "warn");
      await closeOtherTabs(name);
    },
  },
  // §8.3: the focused pane only; `:pane ctx staging` restarts the pane there
  "context.pickPane": {
    enabled: () => getCluster().contexts.length > 1 || "only one context in the kubeconfig",
    run: (ctx) => {
      const name = ctx.args[0];
      if (name === undefined) return open("palette.picker", LAYERS.pickerContext, { kind: "ctx", pane: true });
      dismiss();
      if (!getCluster().contexts.some((c) => c.name === name)) return flash(`no context "${name}"`, "warn");
      if (ctx.newPane) openPaneInContext(name, ctx.newPane);
      else setPaneContext(name);
    },
  },
  "context.protect": {
    enabled: () => focusedContext() !== "" || "no context is connected",
    run: async (ctx) => {
      const context = focusedContext();
      const on = onOff(ctx, contextFlags(context).protected, ":protect on|off");
      if (on !== null) await setProtected(context, on);
    },
  },

  // ── namespace (§8.1) ──
  "namespace.pick": {
    enabled: tableNamespaceState,
    run: (ctx) => {
      const name = ctx.args[0];
      if (name === undefined) return open("palette.picker", LAYERS.pickerNamespace, { kind: "ns", allPanes: false });
      // `:ns x`: the typed name is accepted as it is, listing may be forbidden
      setNamespace(nsArg(name));
      noteNamespaceUsed(nsArg(name));
    },
  },
  "namespace.pickAllPanes": {
    enabled: anyTablePane,
    run: (ctx) => {
      const name = ctx.args[0];
      if (name === undefined) return open("palette.picker", LAYERS.pickerNamespace, { kind: "ns", allPanes: true });
      setNamespaceAllPanes(nsArg(name));
      noteNamespaceUsed(nsArg(name));
    },
  },
  // digits 1..9 on a namespaced table: the slots live in this feature's store
  "namespace.favN": {
    enabled: (ctx) => ctx.digit === undefined || namespaceInSlot(ctx.digit) !== undefined || `no namespace in slot ${ctx.digit}`,
    run: (ctx) => {
      const name = ctx.digit === undefined ? undefined : namespaceInSlot(ctx.digit);
      if (name) setNamespace(name);
    },
  },

  // ── favourites (§7) ──
  "fav.viewN": {
    enabled: (ctx) => {
      const n = slotOf(ctx);
      return n === undefined || favouriteInSlot(n) !== undefined || `no favourite view in slot ${n}`;
    },
    run: (ctx) => {
      const n = slotOf(ctx);
      const fav = n === undefined ? undefined : favouriteInSlot(n);
      if (fav) recallFavourite(fav, { newPane: ctx.newPane });
    },
  },
  "fav.layoutN": {
    enabled: (ctx) => {
      const n = slotOf(ctx);
      return n === undefined || layoutInSlot(n) !== undefined || `no layout in slot ${n}`;
    },
    run: async (ctx) => {
      const n = slotOf(ctx);
      const layout = n === undefined ? undefined : layoutInSlot(n);
      if (layout) await recallLayout(layout);
    },
  },
  "fav.saveView": {
    enabled: () => paneView()?.kind === "table" || "only table views can be saved as favourites",
    run: (ctx) => {
      if (nameAndSlot(ctx.args).name !== "") return saveViewDirect(focusedPane() ?? undefined, ctx.args);
      open("palette.save", LAYERS.dialog, { kind: "view" });
    },
  },
  "fav.saveLayout": (ctx) => {
    if (nameAndSlot(ctx.args).name !== "") return saveLayoutDirect(ctx.args);
    open("palette.save", LAYERS.dialog, { kind: "layout" });
  },
});
