// Opening shells and the port-forward dialog from a selection (eager, no xterm). The terminal chunk
// loads with the view; this file only decides what to open and registers the session in ./state.
import {
  backend, CORE_PODS, paneContext, flash, focusedPane, getSelection, openView, paneIndex, paneView, replaceView,
  showOverlay, toasts, toObjRef,
} from "../../foundation";
import type { BackendError, PodRef } from "../../ipc/types";
import type { ObjectRef, PaneId, ShellView } from "../../types";
import { containerOptions, isShellView, needsContainerPicker, type ContainerOption } from "./session-refs";
import { addSession, getRuntime, getSession, isLiveStatus, liveCount, MAX_LIVE, newSessionId } from "./state";

export const CONTAINER_OVERLAY = "shell.container";
export const PF_START_OVERLAY = "pf.start";

const errorText = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as BackendError).message) : String(e);

export interface Target {
  ref: ObjectRef;
  /** set when the cursor is on a container row */
  container?: string;
}

/**
 * What a pod action applies to: the cursor row, or in the containers view the pod plus the
 * container under the cursor (the selection's `name` there is the container name).
 */
export function selectionTarget(pane: PaneId | null = focusedPane()): Target | null {
  if (!pane) return null;
  const view = paneView(pane);
  const cur = getSelection(pane).focused;
  if (view?.kind === "containers") return { ref: view.pod, container: cur?.name };
  return cur ? { ref: cur } : null;
}

// ── container picker (a dialog, so its keys are the dialog.* actions) ──

export interface ContainerPickProps {
  pod: string;
  kind: "shell" | "attach";
  options: readonly ContainerOption[];
  resolve: (container: string | null) => void;
}

let pendingPick: ((c: string | null) => void) | null = null;

function pickContainer(pod: string, kind: "shell" | "attach", options: readonly ContainerOption[]): Promise<string | null> {
  // a picker that was replaced before it answered counts as cancelled
  pendingPick?.(null);
  return new Promise((resolve) => {
    const done = (c: string | null) => {
      if (pendingPick === done) pendingPick = null;
      resolve(c);
    };
    pendingPick = done;
    showOverlay(CONTAINER_OVERLAY, { pod, kind, options, resolve: done } satisfies ContainerPickProps);
  });
}

interface Resolved {
  pod: ObjectRef;
  container?: string;
}

/** The pod behind a row and the container to use; null when cancelled or nothing can be opened. */
async function resolvePod(target: Target, kind: "shell" | "attach", context: string): Promise<Resolved | null> {
  let pods: PodRef[];
  try {
    pods = await backend.podsFor(toObjRef(target.ref, context));
  } catch (e) {
    toasts.error(`Could not open the ${kind}: ${errorText(e)}`);
    return null;
  }
  const isPod = target.ref.gvr.resource === "pods" && target.ref.gvr.group === "";
  const p = (isPod ? pods.find((x) => x.name === target.ref.name) : pods.find((x) => x.phase === "Running")) ?? pods[0];
  if (!p) {
    flash(`no pod behind ${target.ref.name}`, "warn");
    return null;
  }
  const pod: ObjectRef = isPod ? target.ref : { gvr: CORE_PODS, namespace: p.namespace, name: p.name };
  if (target.container) return { pod, container: target.container };
  const options = containerOptions(p);
  if (!needsContainerPicker(options)) return { pod, container: options.find((o) => o.group !== "init")?.name };
  const container = await pickContainer(p.name, kind, options);
  return container === null ? null : { pod, container };
}

function overLimit(): boolean {
  if (liveCount() < MAX_LIVE) return false;
  flash(`shell limit reached (${MAX_LIVE})`, "warn");
  return true;
}

/** pod.shell / pod.attach: container picker first (§13.4), then the view; the session starts with it. */
export async function openShell(kind: "shell" | "attach", target: Target, newPane: "right" | "down" | null): Promise<void> {
  if (overLimit()) return;
  const source = focusedPane();
  // the source pane's context (§8.3), read before the picker: the shell pane opens beside it, in it
  const context = paneContext(source ?? undefined);
  const r = await resolvePod(target, kind, context);
  if (!r || overLimit()) return;
  const id = newSessionId();
  const view: ShellView = { kind, target: { by: "object", ref: r.pod }, container: r.container, session: id };
  const pane = openView(view, { pane: source ?? undefined, newPane });
  if (!pane) return;
  addSession({ id, kind, context, namespace: r.pod.namespace ?? "", pod: r.pod.name, container: r.container });
}

/**
 * terminal.reconnect (Enter on an ended or never-started shell). A known session restarts on its
 * terminal and keeps the scrollback; an unknown id (restored workspace, reopened pane) starts fresh.
 */
export async function reconnect(pane: PaneId | null = focusedPane()): Promise<void> {
  const view = pane ? paneView(pane) : undefined;
  if (!pane || !isShellView(view)) return;
  const known = getSession(view.session);
  if (known) {
    if (isLiveStatus(known.status) || overLimit()) return;
    const rt = getRuntime() ?? (await import("./sessions")).terminals;
    rt.restart(known.id);
    return;
  }
  if (overLimit()) return;
  // §8.3: never a cursor of a pane in another context
  const ref = view.target.by === "object" ? view.target.ref : paneContext(view.target.pane) === paneContext(pane) ? getSelection(view.target.pane).focused : null;
  if (!ref) {
    if (view.target.by === "paneSelection") flash(`waiting for a selection in pane ${paneIndex(view.target.pane) || "?"}`);
    return;
  }
  const context = paneContext(pane);
  const r = await resolvePod({ ref, container: view.container }, view.kind, context);
  // the pane may have moved on while the picker was open
  if (!r || paneView(pane) !== view || overLimit()) return;
  const id = newSessionId();
  replaceView(pane, (cur) => (cur === view ? { ...view, target: { by: "object", ref: r.pod }, container: r.container, session: id } : cur));
  if (paneView(pane) === view) return;
  addSession({ id, kind: view.kind, context, namespace: r.pod.namespace ?? "", pod: r.pod.name, container: r.container });
}

/**
 * terminal.container: picks another container of the shell's pod and opens a new session there.
 * A live shell keeps running and the new one opens beside it (openView never replaces a live
 * session); an ended one is followed in the same pane and stays one step back with its scrollback.
 */
export async function switchContainer(pane: PaneId | null = focusedPane()): Promise<void> {
  const view = pane ? paneView(pane) : undefined;
  if (!pane || !isShellView(view) || view.target.by !== "object") return;
  const ref = view.target.ref;
  const context = paneContext(pane);
  let pods: PodRef[];
  try {
    pods = await backend.podsFor(toObjRef(ref, context));
  } catch (e) {
    toasts.error(`Could not list the containers: ${errorText(e)}`);
    return;
  }
  const p = pods.find((x) => x.name === ref.name) ?? pods[0];
  if (!p) {
    flash(`no pod behind ${ref.name}`, "warn");
    return;
  }
  const options = containerOptions(p);
  if (options.length < 2) {
    flash(`${p.name} has one container`);
    return;
  }
  const current = view.container ?? getSession(view.session)?.container;
  const container = await pickContainer(p.name, view.kind, options);
  // cancelled, the same container while it is live, or the pane moved on while the picker was open
  if (container === null || paneView(pane) !== view) return;
  if (container === current && isLiveStatus(getSession(view.session)?.status ?? "ended")) return;
  const id = newSessionId();
  const pod: ObjectRef = { gvr: CORE_PODS, namespace: p.namespace, name: p.name };
  const next: ShellView = { kind: view.kind, target: { by: "object", ref: pod }, container, session: id };
  if (!openView(next, { pane })) return;
  addSession({ id, kind: view.kind, context, namespace: p.namespace ?? "", pod: p.name, container });
}

// ── port-forward dialog ──

export interface PfStartProps {
  ref: ObjectRef;
  container?: string;
}

export function openForwardDialog(target: Target): void {
  showOverlay(PF_START_OVERLAY, { ref: target.ref, container: target.container } satisfies PfStartProps);
}
