// `text` view actions (docs/plan-features.md §2.7, §3 G). Small and eager: keys work before the
// lazy view loads; handlers call the focused pane's controller (./controller).
import { engine, registerActions, registerViewActions } from "../../foundation";
import { textController } from "./controller";

const PAGE = 1;
const ctl = textController;
const loading = "loading";

registerActions({
  "text.copy": { enabled: () => ctl()?.canCopy() ?? loading, run: () => ctl()?.copy() },
  "text.dropSection": { enabled: () => ctl()?.canDrop() ?? loading, run: () => ctl()?.drop() },
});

registerViewActions(["text"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.pageDown": () => ctl()?.page(PAGE),
  "nav.pageUp": () => ctl()?.page(-PAGE),
  "nav.top": () => ctl()?.moveTo("top"),
  "nav.bottom": () => ctl()?.moveTo("bottom"),
  "nav.open": () => ctl()?.fold(),
  "view.refresh": () => ctl()?.refresh(),
  "view.saveToFile": { enabled: () => ctl()?.canSave() ?? loading, run: () => ctl()?.save() },
});

/** The view calls this when its state changes what `enabled` reads. */
export const invalidateText = (): void => engine.invalidate();
