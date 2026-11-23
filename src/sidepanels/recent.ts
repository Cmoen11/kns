// Recent (activity panel): the action log as panel rows, and where Enter on one goes. An entry
// keeps only plain data (store/actionlog-model.ts), so a jump re-resolves it: the object's table
// row (cursor on it by name), its logs, the forward's row while it lives, the dev set, a namespace.
// A jump opens in the focused pane like the other activity rows (history: Esc goes back); a pane
// holding a live session is never navigated (openView opens beside it). The log is per context: an
// object of a context the focused pane does not show opens beside it, in that context (§8.3).
import { resourceFor } from "../store/cluster";
import { focusPane, focusedContext, focusedPane, openInContext, openView, paneOrder, paneView, setNamespace } from "../store/layout";
import { entryLine, type LogEntry, type LogTarget } from "../store/actionlog-model";
import { flash } from "../store/status";
import { tableView } from "../store/workspace";
import type { GlyphState } from "../ui";
import { toasts } from "../ui";
import { getForwards, setCursor as setForwardCursor } from "../views/shell/forwards";
import type { PanelRow } from "./model";

const GLYPH: Record<LogEntry["state"], GlyphState> = { ok: "ok", info: "done", warn: "warn", error: "error" };

/** Opens where the entry happened; false when there is nothing to go to (the panel keeps focus). */
export function jumpTo(t: LogTarget | undefined, context: string = focusedContext()): boolean {
  if (!t) return false;
  switch (t.kind) {
    case "object": {
      if (t.namespace === undefined && resourceFor(t.gvr, context)?.namespaced) return false;
      openInContext(tableView(t.gvr, t.namespace ?? "*", { cursorName: t.name }), context);
      return true;
    }
    case "logs":
      openInContext({ kind: "logs", target: { by: "object", ref: { gvr: t.gvr, namespace: t.namespace, name: t.name } }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false }, context);
      return true;
    case "forward": {
      const index = getForwards().findIndex((f) => f.id === t.id);
      const existing = paneOrder().find((p) => paneView(p)?.kind === "portforwards");
      const pane = existing ?? openView({ kind: "portforwards" });
      if (!pane) return false;
      if (existing) focusPane(existing);
      if (index >= 0) setForwardCursor(pane, index);
      else flash("that forward has stopped");
      return true;
    }
    case "devset":
      openView({ kind: "devsets", selected: t.id });
      return true;
    case "namespace": {
      const v = paneView();
      if (v?.kind === "table" && context === focusedContext() && resourceFor(v.gvr)?.namespaced !== false) setNamespace(t.namespace, focusedPane() ?? undefined);
      else openInContext(tableView({ group: "", version: "v1", resource: "pods" }, t.namespace), context);
      return true;
    }
    case "view":
      openView({ kind: t.view } as Parameters<typeof openView>[0]);
      return true;
  }
}

function copy(e: LogEntry): void {
  const text = entryLine(e);
  navigator.clipboard.writeText(text).then(
    () => flash("copied the entry"),
    () => toasts.error("Copy failed: the clipboard is not available"),
  );
}

/** The log (oldest first) as rows, newest first. */
export function recentRows(entries: readonly LogEntry[], context?: string): PanelRow[] {
  const out: PanelRow[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const detail = [e.namespace, e.error].filter(Boolean).join(" · ");
    out.push({
      key: `rec:${e.id}`,
      section: "recent",
      label: e.text,
      detail: detail || undefined,
      since: e.at,
      glyph: GLYPH[e.state],
      tone: e.state === "error" ? "error" : e.state === "warn" ? "warn" : undefined,
      // nothing to go to: the panel keeps the focus and the bottom row reads the entry out
      stay: !e.target,
      activate: () => (jumpTo(e.target, context) ? undefined : (flash(e.error ? `${e.text}: ${e.error}` : e.text), false)),
      copy: () => copy(e),
    });
  }
  return out;
}
