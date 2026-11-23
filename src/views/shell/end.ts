// Ending an exec session on request (terminal.end, the activity panel's stop). The exec closes,
// the terminal and its scrollback stay in the pane, and `terminal.reconnect` starts it again.
import { confirm } from "../../ui";
import { getRuntime, getSession, isLiveStatus, patchSession, type SessionInfo } from "./state";

export function endSession(id: string, message = "ended"): void {
  const rt = getRuntime();
  if (rt) rt.end(id, message);
  else patchSession(id, { status: "ended", message });
}

/** Asks first (tier 1): a shell may hold work in progress. */
export async function stopSession(s: SessionInfo, message?: string): Promise<void> {
  const ok = await confirm({ tier: 1, title: `End ${s.kind}`, body: `Ends the ${s.kind} in ${s.pod}. Its scrollback stays in the pane.`, confirmLabel: "End", cancelLabel: "Keep" });
  if (ok && isLiveStatus(getSession(s.id)?.status ?? "ended")) endSession(s.id, message);
}
