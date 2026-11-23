// Feature: auto-update (docs/auto-update.md). Rust checks and downloads in the background; this
// shows `update 0.2.0` in the bottom row once a newer version is ready and installs it on `:update`
// (or a click) after a confirm, because restarting ends forwards, shells and log streams.
import { createElement } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { backend, confirm, engine, flash, registerActions, registerShellItem, type ActionContext } from "../foundation";
import type { BackendError, UpdateStatus } from "../ipc/types";
import { actionTip, keepFocus } from "../ui";
import { indicatorText, parseUpdateArgs, statusText } from "./model";

const store = createStore<{ status: UpdateStatus | null }>(() => ({ status: null }));
const setStatus = (status: UpdateStatus) => store.setState({ status });
const useUpdateStatus = () => useStore(store, (s) => s.status);

const message = (e: unknown) => (e as BackendError)?.message ?? String(e);

async function install(): Promise<void> {
  const s = store.getState().status;
  if (s?.state !== "ready" || !s.version) {
    flash(statusText(s), "warn");
    return;
  }
  const ok = await confirm({
    tier: 1,
    title: `Restart to update to kns ${s.version}`,
    body: "Port-forwards, shells and log streams stop, and the MCP server restarts with kns. Your panes and dev sets are kept.",
    confirmLabel: "Restart and update",
  });
  if (!ok) return;
  await backend.updateInstall().catch((e) => flash(`update failed: ${message(e)}`, "warn"));
}

async function check(): Promise<void> {
  flash("checking for updates…");
  try {
    const s = await backend.updateCheck();
    setStatus(s);
    flash(statusText(s), s.state === "error" ? "warn" : "info");
  } catch (e) {
    flash(message(e), "warn");
  }
}

async function runUpdate(ctx: ActionContext): Promise<void> {
  const cmd = parseUpdateArgs(ctx.args);
  switch (cmd.kind) {
    case "error":
      flash(cmd.message, "warn");
      return;
    case "status":
      flash(statusText(store.getState().status));
      return;
    case "check":
      return check();
    case "install":
      return install();
    case "default":
      return store.getState().status?.state === "ready" ? install() : check();
  }
}

/** Bottom row: `update 0.2.0` once it is downloaded; a click installs after the confirm. */
function UpdateIndicator() {
  const s = useUpdateStatus();
  const text = indicatorText(s);
  if (!text) return null;
  return createElement(
    "button",
    {
      type: "button",
      className: "pf-indicator t-ui",
      tabIndex: -1,
      ...actionTip("update.command", s?.state === "ready" ? `Restart to install kns ${s.version}` : text),
      "data-kind": "info",
      disabled: s?.state !== "ready",
      onMouseDown: keepFocus,
      onClick: () => engine.run("update.command", { source: "pointer", args: ["install"] }),
    },
    text,
  );
}

export function register(): void {
  registerActions({ "update.command": { run: runUpdate } });
  registerShellItem({ id: "update", area: "status", order: 4, component: UpdateIndicator });
  backend.onEvent((e) => {
    if (e.type === "update") setStatus(e.status);
  });
  backend.updateStatus().then(setStatus, () => {});
}
