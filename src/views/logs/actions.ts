// Logs actions (docs/ux.md §5.4, logs rows). Small and eager: keys work before the view chunk has
// loaded; every handler reaches the focused pane's session through ./sessions.
// res.logs / res.logsPrevious are not here: the table feature registers them for its own view
// kinds (it owns the cursor row) and opens the LogsView state this view renders.
import {
  backend, CORE_PODS, focusedContext, flash, focusPane, getWorkspace, openView, patchView, registerActions, registerViewActions, showOverlay, tableView, toast, toasts,
  type ActionContext,
} from "../../foundation";
import type { LogSince, LogsView, PaneId } from "../../types";
import { nextMode } from "./match";
import { focusedPatterns, type FocusedPatterns } from "./patterns-model";
import { templateRegex } from "./patterns";
import { LINE, type SourceInfo } from "./session";
import { focusedLogs, logsOf, type FocusedLogs } from "./sessions";
import { filterLabel, parseFieldFilter } from "./structured";
import { defaultContainer, SINCE_BY_DIGIT } from "./targets";

export const CONTAINER_OVERLAY = "logs.containers";

const NOT_READY = "the logs view is still loading";

/** Wraps a handler so it only applies to a focused, mounted logs pane. */
const logs = (run: (f: FocusedLogs, ctx: ActionContext) => void | Promise<void>, enabled?: (f: FocusedLogs) => boolean | string) => ({
  when: () => focusedLogs() !== null,
  enabled: () => {
    const f = focusedLogs();
    return f ? (enabled ? enabled(f) : true) : NOT_READY;
  },
  run: (ctx: ActionContext) => {
    const f = focusedLogs();
    if (f) return run(f, ctx);
  },
});

const patch = (f: FocusedLogs, p: Partial<LogsView>) => patchView(f.pane, "logs", p);
const setSince = (since: LogSince) => logs((f) => patch(f, { since }));

// ── search ───────────────────────────────────────────────────────────────────

/** Enter / Shift+Enter in the search input: the draft becomes the view's search. */
function commitSearch(f: FocusedLogs, filterLines?: boolean): void {
  const s = f.pl.session;
  const d = s.draft;
  // `level>=warn` / `.traceId=abc` typed into the search: a field chip, not a text search
  // (the input opens with the applied search in it: a chip typed after it keeps that search)
  const applied = f.view.match?.text ?? "";
  const tail = applied && d.text.startsWith(applied) && d.text !== applied ? d.text.slice(applied.length) : null;
  const chip = d.mode === "re" ? (parseFieldFilter(d.text) ?? (tail !== null ? parseFieldFilter(tail) : null)) : null;
  if (chip) {
    s.addFieldFilter(chip);
    s.setDraft({ text: parseFieldFilter(d.text) ? "" : applied });
    s.closeSearch();
    flash(`field filter ${filterLabel(chip)}`);
    return;
  }
  const match = d.text === "" ? undefined : { mode: d.mode, text: d.text };
  const filter = match ? (filterLines ?? f.view.filterLines) : false;
  patch(f, { match, filterLines: filter });
  // the session learns the applied search before the input closes, so the old one never flashes back
  s.setApplied(match ?? null, filter);
  s.closeSearch();
}

async function copy(f: FocusedLogs): Promise<void> {
  const s = f.pl.session;
  const { text, lines } = s.copyText({ timestamps: f.view.timestamps });
  if (lines === 0) {
    flash("nothing to copy");
    return;
  }
  if (await writeClipboard(text)) {
    toast({ kind: "ok", text: `Copied ${lines} ${lines === 1 ? "line" : "lines"}` });
    s.clearSelection();
  } else toasts.error("Could not write to the clipboard");
}

/** The async clipboard API, with the legacy command as a fallback for webviews that refuse it. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "sr-only";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    prev?.focus({ preventScroll: true });
    return ok;
  }
}

registerActions({
  "logs.autoscroll": logs((f) => f.pl.session.toggleFollow()),
  "logs.resumeFollow": logs((f) => f.pl.session.resume()),
  "logs.wrap": logs((f) => patch(f, { wrap: !f.view.wrap })),
  "logs.timestamps": logs((f) => patch(f, { timestamps: !f.view.timestamps })),
  "logs.tail": setSince("tail"),
  "logs.head": setSince("head"),
  // a digit key (2-6), or the preset by name from the toolbar's menu (`args[0]`: "5m")
  "logs.since": logs((f, ctx) => {
    const named = Object.values(SINCE_BY_DIGIT).find((v) => v === ctx.args[0]);
    const since = named ?? (ctx.digit === undefined ? undefined : SINCE_BY_DIGIT[ctx.digit]);
    if (since) patch(f, { since });
  }),
  "logs.previous": logs(
    (f) => patch(f, { previous: !f.view.previous }),
    (f) => f.view.target.by !== "paneSelection" || "no target yet",
  ),
  "logs.mark": logs((f) => f.pl.session.mark()),
  "logs.clear": logs((f) => f.pl.session.clear()),
  "logs.copy": logs(copy),
  "logs.allContainers": logs(
    (f) => {
      if (f.view.container !== "*") {
        f.pl.lastContainer = f.view.container;
        patch(f, { container: "*" });
        return;
      }
      const one = f.pl.lastContainer ?? defaultContainer(f.pl.streams.pods);
      if (one) patch(f, { container: one });
    },
    (f) => f.view.container !== "*" || f.pl.lastContainer !== undefined || f.pl.streams.pods.length > 0 || "containers are not resolved yet",
  ),
  "logs.containerPicker": logs(
    (f) => showOverlay(CONTAINER_OVERLAY, { pane: f.pane }),
    (f) => f.pl.streams.pods.length > 0 || "containers are not resolved yet",
  ),
  "logs.expandLine": logs(
    (f) => void f.pl.session.toggleExpand(),
    (f) => {
      const s = f.pl.session;
      if (s.cursor === null) return "no cursor line (j / k)";
      const e = s.ring.get(s.cursor);
      // a structured line expands into its fields, also with wrap on
      return (e !== undefined && s.isStructured(e)) || !f.view.wrap || "wrap is on";
    },
  ),
  "logs.structured": logs((f) => f.pl.session.setStructured(!f.pl.session.structured)),
  // always beside (in place would stop the source stream, ux §4.6); one patterns pane per source
  "logs.patterns": logs((f, ctx) => {
    const open = patternsPaneOf(f.pane);
    if (open) return focusPane(open);
    openView({ kind: "patterns", source: f.pane, errorsOnly: false }, { newPane: ctx.newPane ?? "right" });
  }),
  "logs.goToPod": logs(
    (f, ctx) => goToPod(f, ctx),
    (f) => (podOfLine(f) ? true : f.pl.session.cursor === null ? "no cursor line (j / k)" : "this line has no pod"),
  ),
  // F in NORMAL toggles filter-lines on the current search; Shift+Enter in the input applies it as a filter
  "logs.filterLines": logs(
    (f) => {
      if (f.pl.session.searchOpen) commitSearch(f, true);
      else patch(f, { filterLines: !f.view.filterLines });
    },
    (f) => f.pl.session.searchOpen || f.view.match !== undefined || "no search to filter by (/)",
  ),
});

// ids that other views implement too: dispatched on the focused pane's view kind
/** The patterns pane already open for a logs pane, if any. */
function patternsPaneOf(source: PaneId): PaneId | undefined {
  const ws = getWorkspace();
  if (!ws) return undefined;
  for (const [id, p] of Object.entries(ws.panes)) {
    const v = p.history[p.index];
    if (v?.kind === "patterns" && v.source === source) return id;
  }
  return undefined;
}

/** The pod of the cursor line; without a cursor, the only pod of the pane. */
export function podOfLine(f: FocusedLogs): SourceInfo | undefined {
  const s = f.pl.session;
  if (s.cursor !== null) {
    const e = s.ring.get(s.cursor);
    return e && e.kind === LINE ? s.sources[e.src] : undefined;
  }
  const pods = new Set(s.sources.map((x) => `${x.namespace}/${x.pod}`));
  return pods.size === 1 ? s.sources[0] : undefined;
}

/** The pods table with the cursor on the line's pod (in place; `+O` / Ctrl+click beside). */
async function goToPod(f: FocusedLogs, ctx: ActionContext): Promise<void> {
  const src = podOfLine(f);
  if (!src) return;
  let uid: string | undefined;
  try {
    const obj = (await backend.getJson({ context: focusedContext(), gvr: CORE_PODS, namespace: src.namespace, name: src.pod })) as { metadata?: { uid?: unknown } };
    if (typeof obj?.metadata?.uid === "string") uid = obj.metadata.uid;
  } catch {
    flash(`${src.pod} is gone`, "warn");
  }
  // the pane the action ran in, not whatever has the focus once the lookup is back
  openView(tableView(CORE_PODS, src.namespace, uid ? { cursorUid: uid } : {}), { pane: f.pane, newPane: ctx.newPane });
}

registerViewActions(["logs"], {
  // Esc ladder (§4.2): after the search and the selection, the field chips go one by one
  "filter.clear": {
    when: () => (focusedLogs()?.pl.session.fieldFilters.length ?? 0) > 0,
    run: () => void withLogs((f) => f.pl.session.removeFieldFilter()),
  },
  "nav.down": logs((f) => f.pl.session.moveCursor(1)),
  "nav.up": logs((f) => f.pl.session.moveCursor(-1)),
  "nav.top": logs((f) => f.pl.session.cursorTop()),
  "nav.pageDown": logs((f) => f.pl.session.moveCursor(f.pl.session.pageRows)),
  "nav.pageUp": logs((f) => f.pl.session.moveCursor(-f.pl.session.pageRows)),

  "filter.open": logs((f) => f.pl.session.openSearch()),
  "filter.apply": { when: () => focusedLogs()?.pl.session.searchOpen === true, run: () => void withLogs((f) => commitSearch(f)) },
  "filter.cancel": { when: () => focusedLogs()?.pl.session.searchOpen === true, run: () => void withLogs((f) => f.pl.session.closeSearch()) },
  "filter.cycleMode": {
    when: () => focusedLogs()?.pl.session.searchOpen === true,
    run: () => void withLogs((f) => f.pl.session.setDraft({ mode: nextMode(f.pl.session.draft.mode) })),
  },

  "search.next": {
    when: () => focusedLogs()?.pl.session.matcher?.highlights === true,
    enabled: () => (focusedLogs()?.pl.session.hits.length ?? 0) > 0 || "no matches",
    run: () => void withLogs((f) => step(f, 1)),
  },
  "search.previous": {
    when: () => focusedLogs()?.pl.session.matcher?.highlights === true,
    enabled: () => (focusedLogs()?.pl.session.hits.length ?? 0) > 0 || "no matches",
    run: () => void withLogs((f) => step(f, -1)),
  },
  // Esc ladder (§4.2): a search, then a selection, before the pane goes back
  "search.close": {
    when: () => {
      const f = focusedLogs();
      return !!f && !f.pl.session.searchOpen && f.view.match !== undefined;
    },
    run: () => void withLogs((f) => patch(f, { match: undefined, filterLines: false })),
  },
  "select.lines": logs(
    (f) => f.pl.session.startSelection(),
    (f) => f.pl.session.rowCount > 0 || "no lines",
  ),
  "select.clear": {
    when: () => focusedLogs()?.pl.session.anchor != null,
    run: () => void withLogs((f) => f.pl.session.clearSelection()),
  },
  "view.refresh": logs((f) => f.pl.streams.restart()),
});

function withLogs(fn: (f: FocusedLogs) => void): void {
  const f = focusedLogs();
  if (f) fn(f);
}

function step(f: FocusedLogs, dir: 1 | -1): void {
  if (f.pl.session.step(dir) === "wrapped") flash(dir > 0 ? "search wrapped to the top" : "search wrapped to the bottom");
}

// ── patterns view (docs/plan-features.md §3 E) ───────────────────────────────

const pat = (run: (p: FocusedPatterns, ctx: ActionContext) => void, enabled?: (p: FocusedPatterns) => boolean | string) => ({
  when: () => focusedPatterns() !== null,
  enabled: () => {
    const p = focusedPatterns();
    return p ? (enabled ? enabled(p) : true) : "the patterns view is still loading";
  },
  run: (ctx: ActionContext) => {
    const p = focusedPatterns();
    if (p) run(p, ctx);
  },
});

/** Enter: the source logs pane shows only the lines of this pattern (an RE filter-lines search). */
function filterSource(p: FocusedPatterns): void {
  const row = p.m.current();
  if (!row) return;
  patchView(p.m.source, "logs", { match: { mode: "re", text: templateRegex(row.template) }, filterLines: true });
  // the session applies it now, so the source shows it even before its view re-renders
  logsOf(p.m.source)?.session.setApplied({ mode: "re", text: templateRegex(row.template) }, true);
  flash(`logs filtered to this pattern (${row.count} lines)`);
}

registerViewActions(["patterns"], {
  "nav.down": pat((p) => p.m.move(1)),
  "nav.up": pat((p) => p.m.move(-1)),
  "nav.top": pat((p) => p.m.moveTo(0)),
  "nav.bottom": pat((p) => p.m.moveTo(Number.MAX_SAFE_INTEGER)),
  "nav.pageDown": pat((p) => p.m.move(10)),
  "nav.pageUp": pat((p) => p.m.move(-10)),
  "nav.open": pat(filterSource, (p) => (p.m.closed ? "source closed" : p.m.current() ? true : "no pattern")),
  "view.refresh": pat((p) => p.m.refresh(), (p) => !p.m.closed || "source closed"),
});

registerActions({
  "patterns.errorsOnly": pat((p) => patchView(p.pane, "patterns", { errorsOnly: !p.view.errorsOnly })),
});
