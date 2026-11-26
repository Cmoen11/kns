// kns for the Herdr app: your Kubernetes clusters in a native panel, live, next to your
// terminals and agents. Installed by kns (Settings → Herdr → Add to Herdr) or `kns-tui herdr
// install`; talks to the running kns over its loopback endpoint (client.js).
//
// One mod, several views: the panel (docked, or a tab) and the dialogs it opens with
// `openOverlay({ mod: "kns", props: { view } })`.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { DocDialog, EditDialog, ActionDialog } from "./dialogs.js";

const VIEWS = { doc: DocDialog, edit: EditDialog, action: ActionDialog };

export default class Kns extends View {
  init(_props, cx) {
    const Impl = VIEWS[props()?.view] ?? Panel;
    this.impl = new Impl();
    this.impl.init(props() ?? {}, cx);
  }

  render(cx) {
    return this.impl.render(cx);
  }

  async close() {
    this.impl.close?.();
  }
}
