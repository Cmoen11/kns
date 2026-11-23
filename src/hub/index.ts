// Feature: the Tools hub (docs/plan-features.md §3 I). Owner: I.
// View kind `hub`; actions hub.open, hub.detail, hub.help and the hub's list keys (./actions);
// the titlebar button; the `doc` text source (docs/tools.md); home's Tools section; the status
// lines the hub hosts itself (./status). Other features add or refine entries with registerTool
// and report status with registerToolStatus (./catalog).
import { createElement } from "react";
import { ActionButton, registerShellItem, registerView } from "../foundation";
import { initCurrent } from "../store/current";
import "./actions";
import { toolById } from "./catalog";
import { registerDocSource } from "./doc";
import { registerToolsHome } from "./home";

export { hubTarget, runTry } from "./actions";

function ToolsButton() {
  return createElement(ActionButton, { action: "hub.open" });
}

export function register(): void {
  registerView({
    kinds: ["hub"],
    component: () => import("./HubView"),
    crumbs: (v) => {
      const t = v.tool ? toolById(v.tool) : undefined;
      return t ? [{ label: "tools", view: { kind: "hub" } }, { label: t.title }] : [{ label: "tools" }];
    },
    toolbar: () => ["filter.open", { action: "hub.detail", icon: "describe" }, "hub.help"],
  });
  // right group of the titlebar, before the activity toggle (order 100); tooltip "Tools  Ctrl+Shift+H"
  registerShellItem({ id: "tools", area: "titlebar", order: 90, component: ToolsButton });
  registerDocSource();
  registerToolsHome();
  // the current object (Try, :pack, get_selection) caches table cursors from startup
  initCurrent();
}
