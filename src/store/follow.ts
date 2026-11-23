// Follow links (docs/ux.md §4.5): a pane opened beside a table follows that table's cursor row.
// The foundation owns this because it crosses panes: the source publishes its selection, the
// follower's current entry is retargeted in place (no history push) and its view refetches.
// plan-features §2.10a: a `why` pane follows like describe (C1 opens it beside with `follow: true`);
// `timeline` and `patterns` are pinned (patterns keeps its source pane, it never retargets).
import type { ObjectRef, PaneId, ViewState } from "../types";
import { getWorkspace, replaceView } from "./layout";
import { getSelection, onAnySelection, sameRef } from "./selection";
import { currentView, followers } from "./workspace";

/** §4.5: 150ms for documents; a logs stream restarts after 500ms. */
export const FOLLOW_DOC_MS = 150;
export const FOLLOW_LOGS_MS = 500;

/** The view retargeted to `ref`, or the same object when this view does not follow. */
export function retarget(view: ViewState, ref: ObjectRef): ViewState {
  if (view.kind === "doc") {
    // entering EDIT pauses follow until the edit ends
    if (view.mode !== "view" || sameRef(view.ref, ref)) return view;
    return { ...view, ref };
  }
  if (view.kind === "logs") {
    if (view.target.by === "object" && sameRef(view.target.ref, ref)) return view;
    return { ...view, target: { by: "object", ref } };
  }
  if (view.kind === "why") return sameRef(view.ref, ref) ? view : { ...view, ref };
  return view;
}

/** View kinds a follow link retargets (the rest keep their target). */
export const FOLLOWING_KINDS: ReadonlySet<ViewState["kind"]> = new Set<ViewState["kind"]>(["doc", "logs", "why"]);

const timers = new Map<PaneId, ReturnType<typeof setTimeout>>();

function follow(source: PaneId): void {
  const ws = getWorkspace();
  if (!ws) return;
  for (const id of followers(ws, source)) {
    const pane = ws.panes[id];
    const kind = currentView(pane).kind;
    if (!FOLLOWING_KINDS.has(kind)) continue;
    const prev = timers.get(id);
    if (prev) clearTimeout(prev);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const now = getWorkspace();
        const p = now?.panes[id];
        // marks are ignored; an empty source keeps the last target
        const ref = getSelection(source).focused;
        if (!p || !ref || p.link?.source !== source || !p.link.follow) return;
        // A containers pane publishes the pod's gvr with the container's name (§12.5): a document
        // keeps showing the pod, a logs pane moves to that container.
        const src = now ? currentView(now.panes[source]) : undefined;
        if (src?.kind === "containers") {
          const pod = src.pod;
          replaceView(id, (v) => (v.kind === "logs" ? (v.container === ref.name && v.target.by === "object" && sameRef(v.target.ref, pod) ? v : { ...v, target: { by: "object", ref: pod }, container: ref.name }) : v));
          return;
        }
        replaceView(id, (v) => retarget(v, ref));
      }, kind === "logs" ? FOLLOW_LOGS_MS : FOLLOW_DOC_MS),
    );
  }
}

let started = false;
export function initFollow(): void {
  if (started) return;
  started = true;
  onAnySelection(follow);
}
