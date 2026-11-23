// `pf.copyUrl` (docs/plan-features.md §3 B2): `C` on a port-forward row copies its connection
// string. The dialog (ConnDialog, lazy) picks "no credentials" or a Secret key; Rust builds the
// string and, with a Secret, writes the clipboard itself (history/cloud exclusion, cleared later).
import { backend, flash, focusedPane, getSettings, paneView, registerActions, showOverlay, toast, toasts } from "../foundation";
import type { ConnCopyRequest, ConnCopyResult, ConnInfo, Forward } from "../ipc/types";
import { cursorForward } from "../views/shell/forwards";
import { devSetById, errorText } from "./store";

export const CONN_OVERLAY = "dev.conn";

export interface ConnProps {
  forward: Forward;
  info: ConnInfo;
  /** the dev set's name, when the forward belongs to one */
  setName?: string;
  onCopy: (choice: Pick<ConnCopyRequest, "plain" | "secret" | "remember">) => void;
}

/** What a copy did, in one line: `copied postgres://app:•••@localhost:15432/app, clears in 60s`. */
export function copiedText(r: ConnCopyResult): string {
  const where = r.remembered === "set" ? " · kept in the dev set" : r.remembered === "forward" ? " · kept for this forward" : "";
  if (!r.copied) return `copied ${r.preview}${where}`;
  const clears = r.clearSeconds !== undefined ? `, ${r.historyExcluded ? "kept out of clipboard history, " : ""}clears in ${r.clearSeconds}s` : "";
  return `copied ${r.preview}${clears}${where}`;
}

async function copy(f: Forward, choice: Pick<ConnCopyRequest, "plain" | "secret" | "remember">): Promise<void> {
  try {
    const r = await backend.forwardConnCopy({ forward: f.id, ...choice, clearSeconds: getSettings().clipboardClearSeconds || undefined });
    if (!r.copied && r.text !== undefined) {
      try {
        await navigator.clipboard.writeText(r.text);
      } catch {
        toasts.error("Copy failed: the clipboard is not available");
        return;
      }
    }
    toast({ kind: "ok", text: copiedText(r) });
  } catch (e) {
    toasts.error(`Could not copy the connection string: ${errorText(e)}`);
  }
}

const managerForward = (): Forward | undefined => {
  const pane = focusedPane();
  return pane && paneView(pane)?.kind === "portforwards" ? cursorForward(pane) : undefined;
};

registerActions({
  "pf.copyUrl": {
    enabled: () => managerForward() !== undefined || "no port-forward selected",
    run: async () => {
      const f = managerForward();
      if (!f) return;
      let info: ConnInfo;
      try {
        info = await backend.forwardConnInfo(f.id);
      } catch (e) {
        return flash(`Could not read the forward: ${errorText(e)}`, "warn");
      }
      showOverlay(CONN_OVERLAY, {
        forward: f,
        info,
        setName: info.devSet ? devSetById(info.devSet)?.name : undefined,
        onCopy: (choice) => void copy(f, choice),
      } satisfies ConnProps);
    },
  },
});
