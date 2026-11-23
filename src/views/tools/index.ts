// Feature: tool views and the help overlay (docs/ux.md §11.10).
// View kinds: home, settings, aliases, messages. Overlays: help (`?`), the rebind dialog.
// Actions: home.open, settings.open, aliases.show, messages.open, help.overlay, settings.*,
// keymap.rebind/clear/reset/resetAll, and nav.* / nav.open / filter.open|apply|cancel for these kinds.
import { registerOverlay, registerView } from "../../foundation";
import { HELP_OVERLAY, REBIND_OVERLAY } from "./actions";

export function register(): void {
  // one registration per kind: each view is its own chunk
  // toolbars (mouse parity): the filter is one click away in every list
  registerView({ kinds: ["home"], component: () => import("./HomeView"), toolbar: () => ["filter.open"] });
  registerView({
    kinds: ["settings"],
    component: () => import("./SettingsView"),
    toolbar: () => [{ action: "settings.filter", icon: "filter" }, "|", { action: "keymap.resetAll", icon: "history" }],
  });
  registerView({ kinds: ["aliases"], component: () => import("./AliasesView"), toolbar: () => ["filter.open"] });
  registerView({ kinds: ["messages"], component: () => import("./MessagesView"), toolbar: () => ["filter.open"] });
  registerOverlay(HELP_OVERLAY, () => import("./HelpOverlay"));
  registerOverlay(REBIND_OVERLAY, () => import("./RebindDialog"));
}
