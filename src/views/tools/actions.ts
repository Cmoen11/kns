// Handlers for the tool views (docs/ux.md §5.4): opening them, list navigation in the `list`
// scope, the settings rows and the keymap editor. Small and eager; the views load lazily.
import { registry } from "../../actions";
import {
  closeOverlay, engine, isOverlayOpen, openView, paneView, registerActions, registerViewActions, showOverlay, toast,
  type ActionContext,
} from "../../foundation";
import { isRebindable, keymap, platform } from "../../keys";
import { resetKeymap, setKeymapOverride } from "../../store/settings";
import type { ToolView } from "../../types";
import { confirm } from "../../ui";
import { ctl, requestKeysJump } from "./controllers";

export const HELP_OVERLAY = "tools.help";
export const REBIND_OVERLAY = "tools.rebind";

/** Opens a tool view in the focused pane (or beside it after `+`); a pane already showing it stays. */
function openTool(kind: ToolView["kind"], ctx: ActionContext): void {
  if (!ctx.newPane && paneView()?.kind === kind) return;
  openView({ kind }, { newPane: ctx.newPane });
}

const noRow = "no row selected";
const current = () => ctl()?.current();
/** The action of the keymap row under the cursor, when it may be rebound. */
const keymapRow = () => {
  const id = current()?.actionId;
  const def = id ? registry.get(id) : undefined;
  return def && isRebindable(def) ? def : undefined;
};

registerActions({
  "home.open": (ctx) => openTool("home", ctx),
  "settings.open": (ctx) => {
    if (ctx.args[0] === "keys" && (ctx.newPane || paneView()?.kind !== "settings")) requestKeysJump();
    openTool("settings", ctx);
  },
  "aliases.show": (ctx) => openTool("aliases", ctx),
  "messages.open": (ctx) => openTool("messages", ctx),

  "help.overlay": () => {
    if (isOverlayOpen(HELP_OVERLAY)) closeOverlay(HELP_OVERLAY);
    // taken before the overlay pushes its layer: the focused pane's actions and their reasons
    else showOverlay(HELP_OVERLAY, { available: engine.available() });
  },

  // settings view (its own scope: `j` `k`, Enter/Space, arrows, `/`)
  "settings.moveDown": () => ctl()?.move(1),
  "settings.moveUp": () => ctl()?.move(-1),
  "settings.change": { enabled: () => !!current()?.change || "nothing to change on this row", run: () => current()?.change?.() },
  "settings.cyclePrev": { enabled: () => !!current()?.cycle || "this row has no options", run: () => current()?.cycle?.(-1) },
  "settings.cycleNext": { enabled: () => !!current()?.cycle || "this row has no options", run: () => current()?.cycle?.(1) },
  "settings.filter": () => ctl()?.filterOpen(),

  // keymap rows of the settings view (the `settings.keymap` layer)
  "keymap.rebind": { when: () => !!keymapRow(), run: () => showOverlay(REBIND_OVERLAY, { id: keymapRow()!.id }) },
  "keymap.clear": {
    when: () => !!keymapRow(),
    enabled: () => keymap.display(keymapRow()!.id, platform).length > 0 || "already has no key",
    run: () => {
      const def = keymapRow()!;
      setKeymapOverride(def.id, { ...keymap.overrides()[def.id], [platform]: [] });
      toast({ kind: "info", text: `Unbound ${def.label}`, undo: () => setKeymapOverride(def.id, undefined), undoLabel: "reset" });
    },
  },
  "keymap.reset": {
    when: () => !!keymapRow(),
    enabled: () => !!keymap.overrides()[keymapRow()!.id] || "already the default",
    run: () => {
      const def = keymapRow()!;
      setKeymapOverride(def.id, undefined);
      toast(`${def.label}: default keys restored`);
    },
  },
  "keymap.resetAll": async () => {
    const n = Object.keys(keymap.overrides()).length;
    if (n === 0) {
      toast("Every key is already the default");
      return;
    }
    const ok = await confirm({ tier: 1, title: "Reset all keys", body: `${n} changed ${n === 1 ? "action goes" : "actions go"} back to the default keys.`, confirmLabel: "Reset" });
    if (!ok) return;
    resetKeymap();
    toast("All keys reset to the defaults");
  },
});

// Ids that other views implement too: registered per view kind (docs/frontend.md §9).
registerViewActions(["home", "aliases", "messages"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.top": () => ctl()?.top(),
  "nav.bottom": () => ctl()?.bottom(),
  "nav.pageDown": () => ctl()?.page(1),
  "nav.pageUp": () => ctl()?.page(-1),
  "nav.open": {
    // rows that open nothing (messages, the context row without a picker) leave Enter alone
    when: () => !!current()?.open,
    enabled: () => !!current() || noRow,
    run: (ctx) => current()?.open?.(ctx.newPane),
  },
  "filter.open": () => ctl()?.filterOpen(),
});
registerViewActions(["home", "aliases", "messages", "settings"], {
  "filter.apply": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterApply() },
  "filter.cancel": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterCancel() },
  // Esc ladder (§4.2): absent without a filter, so Esc falls through to nav.back
  "filter.clear": { when: () => !!ctl()?.hasFilter() && !ctl()?.isFiltering(), run: () => ctl()?.filterClear() },
});
