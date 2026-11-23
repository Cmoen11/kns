// Publishes what the human is looking at for MCP `get_selection` (docs/plan-features.md §3 H1
// step 5): the focused pane's context (§8.3), the contexts connected in this session, the focused pane's kind
// and title, the current object (`currentObject()`), marks, filter and namespace.
//
// Driven by events only: focus/view changes (layout store), selection changes, context changes.
// A burst is coalesced into one publish 150 ms after it settles; an unchanged state is not sent.
import { backend, focusedContext, focusedPane, paneContext, getWorkspace, layoutStore, paneNamespace, titleOf, toObjRef } from "../foundation";
import { clusterStore } from "../store/cluster";
import { currentObject } from "../store/current";
import { onAnySelection } from "../store/selection";
import { currentView } from "../store/workspace";
import type { UiState } from "../ipc/types";
import { buildUiState, sameUiState } from "./model";
import { connectedContexts, subscribeConnected } from "./store";

const SETTLE_MS = 150;
let timer: ReturnType<typeof setTimeout> | null = null;
let last: UiState | null = null;

export function snapshotUiState(): UiState {
  const context = focusedContext() || null;
  const pane = focusedPane();
  const ws = getWorkspace();
  const p = pane ? ws?.panes[pane] : undefined;
  const view = p ? currentView(p) : undefined;
  const cur = currentObject();
  const objContext = cur ? paneContext(cur.paneId) || null : null;
  const filters = view?.kind === "table" ? view.filters : [];
  const filter = filters.map((f) => ("text" in f ? f.text : f.selector)).join(" ");
  let title = "";
  try {
    title = view ? titleOf(view) : "";
  } catch {
    title = view?.kind ?? "";
  }
  const ns = pane ? paneNamespace(pane) : undefined;
  return buildUiState({
    context,
    connected: connectedContexts(),
    pane: view ? { kind: view.kind, title } : null,
    // the current object can come from another pane than the focused one: label it with that pane's context
    cursor: cur && objContext ? toObjRef(cur.ref, objContext) : null,
    marked: cur && objContext ? cur.marked.map((r) => toObjRef(r, objContext)) : [],
    filter: filter || undefined,
    namespace: ns && ns !== "*" ? ns : undefined,
  });
}

function flush(): void {
  timer = null;
  const s = snapshotUiState();
  if (sameUiState(last, s)) return;
  last = s;
  backend.publishUiState(s).catch(() => {
    last = null;
  });
}

function schedule(): void {
  if (timer === null) timer = setTimeout(flush, SETTLE_MS);
}

let started = false;
/** Starts publishing (idempotent). */
export function startUiStatePublisher(): void {
  if (started) return;
  started = true;
  layoutStore.subscribe(schedule);
  onAnySelection(schedule);
  clusterStore.subscribe(schedule);
  subscribeConnected(schedule);
  schedule();
}
