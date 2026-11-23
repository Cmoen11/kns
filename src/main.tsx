// boot must stay the first import: it sets theme, mode and zoom on <html> before first paint.
import "./boot";
import "./styles/index.css";
import "./ui/ui.css";
import "./shell/shell.css";
import "./panes/panes.css";
import "./App.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerFeatures } from "./features";
import { engine, installKeys } from "./keys";
import { initScopeSync } from "./panes/scope-sync";
import { initCluster } from "./store/cluster";
import { initFollow } from "./store/follow";
import { stampCursors } from "./store/layout";
import { flushPersisted } from "./store/persist";
import { initSettings } from "./store/settings";
import { flash } from "./store/status";
import { announce } from "./ui/live";
import { openMenu } from "./ui/menu";
import { toast } from "./ui/toast";
// eager action handlers (keys must work before any lazy chunk loads)
import "./ui/actions";
import "./store/settings-actions";
import "./panes/actions";

initSettings();
installKeys();
registerFeatures();
initScopeSync();
initFollow();
// paints the persisted workspace first, then lists contexts, connects and discovers
void initCluster();

// Engine feedback: a blocked key says why in the bottom row, a failed action is never silent.
let lastMode = engine.snapshot().mode;
engine.subscribe(() => {
  const mode = engine.snapshot().mode;
  if (mode !== lastMode) {
    lastMode = mode;
    announce(`${mode} mode`);
  }
});
engine.on((e) => {
  if (e.type === "blocked") flash(e.reason, "warn");
  else if (e.type === "message") flash(e.text);
  else if (e.type === "error") {
    const err = e.error as { message?: unknown } | null;
    toast({ kind: "error", text: typeof err?.message === "string" ? err.message : String(e.error) });
  }
});

window.addEventListener("pagehide", () => {
  stampCursors();
  void flushPersisted();
});
// our own context menu only (§5.1 rule 13); text inputs keep the native one for now
window.addEventListener("contextmenu", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  // a view or the pane header that opened its own menu (openMenu) has already prevented the default
  const handled = e.defaultPrevented;
  e.preventDefault();
  // right-click in a pane opens the same menu as Shift+F10 (§11.10), at the pointer. The
  // pointerdown already moved pane focus, and a view's own onContextMenu (React handlers run
  // before this listener) has moved its cursor to the clicked row. A terminal keeps its own
  // selection behaviour.
  if (!handled && t instanceof Element && t.closest(".pane") && !t.closest(".xterm") && !engine.snapshot().scopes.includes("menu")) {
    openMenu({ at: { x: e.clientX, y: e.clientY } });
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
