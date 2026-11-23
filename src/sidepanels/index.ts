// Feature: the two side panels of the window shell (docs/requirements.md "Side panels and editor
// additions"): the context sidebar (left) and the activity panel (right), in one shared frame.
// No view kinds and no overlays: App.tsx mounts <SidePanel side> on each side of the pane tree.
//
// Eager (this file's imports): actions, the prefs/runtime store, the activity tracker, the titlebar
// toggles and the bottom-row count. Lazy chunks: the two panel bodies.
// Call register() after the shell feature: the bottom-row count replaces its "pf" indicator.
import { registerShellItem, unregisterShellItem } from "../shell/slots";
import "./actions";
import { initActivity } from "./activity";
import { ActivityIndicator, ActivityToggle, SidebarToggle } from "./Indicators";
import { initSidePanels } from "./store";
import "./sidepanels.css";

export function register(): void {
  registerShellItem({ id: "sidebar", area: "titlebar-left", component: SidebarToggle });
  registerShellItem({ id: "activity", area: "titlebar", order: 100, component: ActivityToggle });
  // one count of the forwards, not two: the shell feature's `pf N` goes, and this one has an id
  // of its own, because "pf" is hidden under 760px, where the panel is an overlay and this count
  // is the only sign of what is live
  unregisterShellItem("pf");
  registerShellItem({ id: "live", area: "status", order: 10, component: ActivityIndicator });
  initSidePanels();
  initActivity();
}

export { SidePanel } from "./Frame";
