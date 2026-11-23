// Ready-made handlers for the `+` new-pane prefix (docs/ux.md §4.1). The prefix state lives in
// the key engine; the panes feature registers these once "open in a new pane" works:
//
//   registerActions(newPanePrefixHandlers());
//
// `+` shows NEW →, a second `+` NEW ↓, a third cancels. The next action must have opens:'view'
// and receives ctx.newPane; anything else cancels the prefix without running.
import type { HandlerMap } from "../actions/registry";
import type { Engine } from "./engine";
import { engine as defaultEngine } from "./instance";

export function newPanePrefixHandlers(engine: Engine = defaultEngine): HandlerMap {
  return {
    "pane.newPrefixRight": () => engine.setPrefix("right"),
    "pane.newPrefixDown": () => engine.setPrefix(engine.snapshot().prefix === "right" ? "down" : null),
  };
}
