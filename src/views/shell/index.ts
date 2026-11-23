// Feature: shell, attach and port-forwards (docs/ux.md §13.4, §13.5). Owner: the shell team; edit only
// inside src/views/shell.
//
// Eager (this file's imports): actions, session status store, forward store, the `pf N` indicator.
// Lazy chunks: ShellView + sessions (xterm), PortForwardsView, the two dialogs.
import { defaultCrumbs, registerOverlay, registerPaneGuard, registerShellItem, registerView } from "../../foundation";
import "./actions";
import { CONTAINER_OVERLAY, PF_START_OVERLAY } from "./open";
import { PfIndicator } from "./PfIndicator";
import { getSession, initSessions, shellGuard } from "./state";

export function register(): void {
  registerView({
    kinds: ["shell", "attach"],
    component: () => import("./ShellView"),
    // namespace / pods / pod / container / shell: the header shows pod and container (§13.4)
    crumbs: (view) => {
      const base = defaultCrumbs(view);
      const container = view.container ?? getSession(view.session)?.container;
      return container ? [...base.slice(0, -1), { label: container }, base[base.length - 1]] : base;
    },
  });
  registerView({
    kinds: ["portforwards"],
    component: () => import("./PortForwardsView"),
    // the cursor row's actions, also as row buttons in the list
    toolbar: () => [
      { action: "pf.openBrowser", icon: "external" },
      { action: "pf.copyAddress", icon: "copy" },
      { action: "pf.stop", icon: "stop" },
      "|",
      "view.refresh",
      "hub.help",
    ],
  });
  registerOverlay(CONTAINER_OVERLAY, () => import("./ContainerDialog"));
  registerOverlay(PF_START_OVERLAY, () => import("./PfStartDialog"));
  registerPaneGuard(shellGuard);
  registerShellItem({ id: "pf", area: "status", order: 10, component: PfIndicator });
  initSessions();
}
