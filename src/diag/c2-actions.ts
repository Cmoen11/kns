// Timeline, trap and journal actions (docs/plan-features.md §2.7, §3 C2). Small and eager: keys
// work before the lazy views load; handlers open views and dialogs or call the focused pane's
// controller (./c2-controller). No key is named here.
import { backend, focusedContext, engine, flash, focusedPane, getSelection, openView, paneView, registerActions, registerViewActions, showOverlay, toast, toasts, type ActionContext } from "../foundation";
import type { ObjectRef } from "../types";
import { cleanUntrusted } from "../ui/untrusted";
import { errorText, journalOn, refreshJournal } from "./c2-store";
import { timelineControllers, trapsControllers } from "./c2-controller";
import { parseSince, TIMELINE_KINDS } from "./timeline-model";
import { parseJournalArg, TRAP_KINDS } from "./traps-model";

export const TRAP_OVERLAY = "diag.trap";
const PAGE = 10;

/** The object `H` / `:trap` act on: a table's cursor row, or the pod of a containers view. */
export function c2Target(): ObjectRef | null {
  const pane = focusedPane();
  if (!pane) return null;
  const v = paneView(pane);
  if (v?.kind === "containers") return v.pod;
  if (v?.kind === "table") return getSelection(pane).focused ?? null;
  return null;
}

const inTable = (kinds: Set<string>) => () => {
  const v = paneView();
  return v?.kind === "containers" || (v?.kind === "table" && kinds.has(v.gvr.resource));
};

const targetReason = (kinds: Set<string>, what: string) => (): true | string => {
  const ref = c2Target();
  if (!ref) return "no row selected";
  return kinds.has(ref.gvr.resource) || `${what} works on pods, workloads and Services`;
};

function openTimeline(ctx: ActionContext): void {
  const ref = c2Target();
  if (!ref || !TIMELINE_KINDS.has(ref.gvr.resource)) return;
  const minutes = parseSince(ctx.args);
  if (minutes === null) {
    flash(`:timeline takes a window like 60, 3h or 2d`, "warn");
    return;
  }
  // pinned (§2.10a follow rule): beside it does not follow the cursor
  openView({ kind: "timeline", ref: { gvr: ref.gvr, namespace: ref.namespace, name: ref.name }, sinceMinutes: minutes }, ctx.newPane ? { newPane: ctx.newPane } : {});
}

export interface TrapDialogProps {
  ref: ObjectRef;
  context: string;
}

async function toggleJournal(ctx: ActionContext): Promise<void> {
  const context = focusedContext();
  if (!context) {
    flash("connect to a context first", "warn");
    return;
  }
  await refreshJournal();
  const want = parseJournalArg(ctx.args, journalOn(context));
  if (want === null) {
    flash(":journal takes on or off", "warn");
    return;
  }
  try {
    await backend.journalSet(context, want);
    await refreshJournal();
    toast({ kind: "ok", text: want ? `Event journal on for ${cleanUntrusted(context)}: Warning events are kept on this machine while kns runs` : `Event journal off for ${cleanUntrusted(context)} (recorded rows stay)` });
  } catch (e) {
    toasts.error(`Journal: ${errorText(e)}`);
  }
}

const tl = () => timelineControllers.get();
const tr = () => trapsControllers.get();

registerActions({
  "res.timeline": { when: inTable(TIMELINE_KINDS), enabled: targetReason(TIMELINE_KINDS, "the timeline"), run: openTimeline },
  "res.trap": {
    when: inTable(TRAP_KINDS),
    enabled: () => {
      const r = targetReason(TRAP_KINDS, "a trap")();
      if (r !== true) return r;
      return c2Target()?.namespace ? true : "traps watch namespaced objects";
    },
    run: () => {
      const ref = c2Target();
      const context = focusedContext();
      if (!ref || !context) return;
      showOverlay(TRAP_OVERLAY, { ref: { gvr: ref.gvr, namespace: ref.namespace, name: ref.name }, context } satisfies TrapDialogProps);
    },
  },
  "trap.list": { run: (ctx) => void openView({ kind: "traps" }, ctx.newPane ? { newPane: ctx.newPane } : {}) },
  "trap.disarm": { enabled: () => tr()?.canDisarm() ?? "loading", run: () => tr()?.disarm() },
  "journal.toggle": {
    enabled: () => (focusedContext() ? true : "not connected"),
    run: (ctx) => toggleJournal(ctx),
  },
});

registerViewActions(["timeline"], {
  "nav.down": () => tl()?.move(1),
  "nav.up": () => tl()?.move(-1),
  "nav.pageDown": () => tl()?.move(PAGE),
  "nav.pageUp": () => tl()?.move(-PAGE),
  "nav.top": () => tl()?.moveTo("top"),
  "nav.bottom": () => tl()?.moveTo("bottom"),
  "nav.open": { enabled: () => tl()?.canOpen() ?? "loading", run: (ctx) => tl()?.open(ctx.newPane) },
  "view.refresh": () => tl()?.refresh(),
  // §2.7: `l` in a timeline = logs at the cursor row's time
  "res.logs": { enabled: () => tl()?.canLogs() ?? "loading", run: (ctx) => tl()?.logs(ctx.newPane) },
});

registerViewActions(["traps"], {
  "nav.down": () => tr()?.move(1),
  "nav.up": () => tr()?.move(-1),
  "nav.pageDown": () => tr()?.move(PAGE),
  "nav.pageUp": () => tr()?.move(-PAGE),
  "nav.top": () => tr()?.moveTo("top"),
  "nav.bottom": () => tr()?.moveTo("bottom"),
  "nav.open": { enabled: () => tr()?.canOpen() ?? "loading", run: (ctx) => tr()?.open(ctx.newPane) },
  "view.refresh": () => tr()?.refresh(),
});

/** The views call this when their state changes what `enabled` reads. */
export const invalidateC2 = (): void => engine.invalidate();
