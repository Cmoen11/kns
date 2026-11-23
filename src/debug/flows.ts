// Flows of feature F: debug container, debug copy, snippets, copy as kubectl, mirrord. Eager but
// light: dialogs are lazy overlays, the shell opens through src/views/shell/open.ts.
import {
  backend, CORE_PODS, focusedContext, engine, flash, focusedPane, openView, paneView, showOverlay, toast, toasts, toObjRef,
} from "../foundation";
import type { DebugPod, Json, ObjRef } from "../ipc/types";
import { access } from "../actions/ops/access";
import { errorText } from "../actions/ops/bulk";
import { recordAction } from "../store/actionlog";
import { targetsFor } from "../actions/ops/targets";
import { confirmWrite, runOn } from "../actions/ops/write";
import { onAnySelection } from "../store/selection";
import type { ObjectRef } from "../types";
import { openShell, selectionTarget, type Target } from "../views/shell/open";
import {
  findSnippet, kubectlFor, kubectlForView, KUBECTL_TEMPLATES, mirrordCommand, parseSnippetArgs, snippetFits,
  type KubeExtra, type KubeTarget, type Snippet,
} from "./model";
import { addRun } from "./runs";
import { forgetDebugPod, noteImage, refreshDebugPods, removeSnippet, saveSnippet, toolsStore } from "./store";

export const DEBUG_OVERLAY = "debug.dialog";
export const SNIPPET_OVERLAY = "debug.snippet";

const isPodRef = (r: ObjectRef | undefined | null): boolean => !!r && r.gvr.group === "" && r.gvr.resource === "pods";

/** The pod under the cursor (table row or containers view), with the container in a containers view. */
export function podTarget(): Target | null {
  const t = selectionTarget(focusedPane());
  return t && isPodRef(t.ref) ? t : null;
}

/** For `enabled`: a pod target and RBAC (advisory; the server still decides). */
export function podPermitted(verb: string, subresource?: string): true | string {
  const t = podTarget();
  if (!t) return "select a pod first";
  const context = focusedContext();
  if (!context) return true;
  const allowed = access.check({ context, verb, group: "", version: "v1", resource: "pods", subresource, namespace: t.ref.namespace });
  return allowed === false ? `forbidden: cannot ${verb} pods${subresource ? `/${subresource}` : ""}${t.ref.namespace ? ` in ${t.ref.namespace}` : ""}` : true;
}

// ── last action per row (for :kubectl) ─────────────────────────────────────

interface LastAction {
  action: string;
  extra: KubeExtra;
  container?: string;
}
const lastByRow = new Map<string, LastAction>();
const rowKey = (context: string, r: ObjectRef): string => `${context}|${r.gvr.group}/${r.gvr.resource}|${r.namespace ?? ""}|${r.name}`;

export function noteLastAction(action: string, target: Target, extra: KubeExtra = {}): void {
  const context = focusedContext();
  if (!context || !KUBECTL_TEMPLATES[action]) return;
  const key = rowKey(context, target.ref);
  lastByRow.delete(key);
  lastByRow.set(key, { action, extra, container: target.container });
  if (lastByRow.size > 50) lastByRow.delete(lastByRow.keys().next().value as string);
}

/**
 * Records the actions `:kubectl` can turn into a command, with the row they ran on. The engine
 * reports a run after its handler, so an action that opened a pane beside has moved the focus
 * already: the row is then the last cursor row of the pane that had the focus.
 */
export function trackLastActions(): () => void {
  let lastRow: Target | null = null;
  const offSel = onAnySelection((pane) => {
    if (pane !== focusedPane()) return;
    const t = selectionTarget(pane);
    if (t) lastRow = t;
  });
  const offRun = engine.on((e) => {
    if (e.type !== "run" || e.id === "pod.debug" || !KUBECTL_TEMPLATES[e.id]) return;
    const t = selectionTarget(focusedPane()) ?? lastRow;
    if (t) noteLastAction(e.id, t);
  });
  return () => {
    offSel();
    offRun();
  };
}

const kubeTarget = (context: string, t: Target, container?: string): KubeTarget => ({
  context, gvr: t.ref.gvr, namespace: t.ref.namespace, name: t.ref.name, container: container ?? t.container,
});

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: "ok", text: `Copied ${what}: ${text.length > 90 ? `${text.slice(0, 90)}…` : text}` });
  } catch {
    toasts.error(`Could not copy the ${what}`);
  }
}

/** `:kubectl`: the cursor row's last action as kubectl, else the focused view's command. */
export async function copyKubectl(): Promise<void> {
  const context = focusedContext();
  const pane = focusedPane();
  if (!context || !pane) return;
  const view = paneView(pane);
  const t = selectionTarget(pane);
  let cmd: string | null = null;
  if (t) {
    const last = lastByRow.get(rowKey(context, t.ref));
    if (last) cmd = kubectlFor(last.action, kubeTarget(context, t, last.container), last.extra);
  }
  cmd ??= view ? kubectlForView(view, context) : null;
  if (!cmd) {
    flash(view ? `no kubectl equivalent for the ${view.kind} view` : "nothing to copy", "warn");
    return;
  }
  await copy(cmd, "kubectl command");
}

/** `:mirrord [cmd…]`: copies the mirrord command for the pod under the cursor; never runs it. */
export async function copyMirrord(args: readonly string[]): Promise<void> {
  const context = focusedContext();
  const t = podTarget();
  if (!context || !t) {
    flash("select a pod first", "warn");
    return;
  }
  const cmd = mirrordCommand(kubeTarget(context, t), args);
  if (!cmd) {
    flash("the command has a ' or a control character; type it in your shell instead", "warn");
    return;
  }
  await copy(cmd, "mirrord command");
}

// ── debug container and debug copy ─────────────────────────────────────────

export interface DebugChoice {
  image: string;
  /** ephemeral: the container whose processes it shares; copy: the container that sleeps */
  target?: string;
}

export interface DebugDialogProps {
  mode: "ephemeral" | "copy";
  pod: string;
  namespace: string;
  context: string;
  containers: readonly string[];
  target?: string;
  images: readonly string[];
  protected: boolean;
  resolve: (choice: DebugChoice | null) => void;
}

let pendingDialog: ((c: DebugChoice | null) => void) | null = null;

function askDebug(props: Omit<DebugDialogProps, "resolve">): Promise<DebugChoice | null> {
  pendingDialog?.(null);
  return new Promise((resolve) => {
    const done = (c: DebugChoice | null) => {
      if (pendingDialog === done) pendingDialog = null;
      resolve(c);
    };
    pendingDialog = done;
    showOverlay(DEBUG_OVERLAY, { ...props, resolve: done } satisfies DebugDialogProps);
  });
}

/** Settings images first, then recently used ones not in the settings. */
export function imageChoices(settingsImages: readonly string[]): string[] {
  const recent = toolsStore.getState().recentImages;
  return [...settingsImages, ...recent.filter((i) => !settingsImages.includes(i))];
}

async function readPod(ref: ObjRef): Promise<Json | null> {
  try {
    return await backend.getJson(ref);
  } catch (e) {
    toasts.error(`Cannot read pod ${ref.name}: ${errorText(e)}`);
    return null;
  }
}

interface PodInfo {
  containers: { name: string; image: string }[];
  labels: Record<string, string>;
}

function podInfo(pod: Json | null): PodInfo {
  const o = (pod ?? {}) as { spec?: { containers?: { name?: unknown; image?: unknown }[] }; metadata?: { labels?: Record<string, string> } };
  const containers = (o.spec?.containers ?? [])
    .filter((c) => typeof c.name === "string")
    .map((c) => ({ name: c.name as string, image: typeof c.image === "string" ? c.image : "" }));
  return { containers, labels: o.metadata?.labels ?? {} };
}

/** `B` / `:debug [copy]`. */
export async function debugFlow(copyMode: boolean, newPane: "right" | "down" | null, images: readonly string[]): Promise<void> {
  const context = focusedContext();
  const t = podTarget();
  if (!context || !t) {
    flash("select a pod first", "warn");
    return;
  }
  const ref = toObjRef(t.ref, context);
  const info = podInfo(await readPod(ref));
  if (info.containers.length === 0) return;
  const targets = targetsFor(ref);
  const choice = await askDebug({
    mode: copyMode ? "copy" : "ephemeral",
    pod: ref.name,
    namespace: ref.namespace ?? "",
    context,
    containers: info.containers.map((c) => c.name),
    target: t.container && info.containers.some((c) => c.name === t.container) ? t.container : info.containers[0].name,
    images: imageChoices(images),
    protected: targets.protected,
  });
  if (!choice) return;
  if (choice.image) noteImage(choice.image);
  // the dialog is the confirmation on an ordinary context; a copy is a new pod (tier 1), and a
  // protected context asks for the typed name either way
  const ok = await confirmWrite(targets, {
    verb: copyMode ? "copy" : "debug",
    tier: copyMode ? 1 : 0,
    confirmLabel: copyMode ? "Create copy" : "Add container",
    body: copyMode
      ? `Creates a sleeping copy of ${ref.name} (labels dropped, probes removed, deleted after 1 h at the latest).`
      : `Adds an ephemeral container (${choice.image}) to ${ref.name}. It cannot be removed; it goes away with the pod.`,
  });
  if (!ok) return;
  noteLastAction("pod.debug", { ref: t.ref, container: choice.target }, { image: choice.image || undefined, copy: copyMode });

  if (copyMode) {
    const [r] = await runOn(targets, () => backend.debugCopy(ref, choice.image || undefined, choice.target), { verb: "debug copy" });
    void refreshDebugPods(context);
    if (!r.ok || !r.value) {
      toasts.error(`Debug copy of ${ref.name} failed: ${errorText(r.error)}`);
      return;
    }
    const copyPod = r.value;
    toast({ kind: "ok", text: `Created ${copyPod.name}. Open a shell from Activity → Debug pods once it runs.` });
    return;
  }

  flash(`adding a debug container to ${ref.name} (waits up to 60s)`);
  const [r] = await runOn(targets, () => backend.debugContainer({ ref, image: choice.image, target: choice.target }), { verb: "debug" });
  void refreshDebugPods(context);
  if (!r.ok || !r.value) {
    toasts.error(`Debug container on ${ref.name} failed: ${errorText(r.error)}`);
    return;
  }
  toast({ kind: "ok", text: `${r.value} runs in ${ref.name}` });
  await openShell("shell", { ref: { gvr: CORE_PODS, namespace: ref.namespace, name: ref.name }, container: r.value }, newPane);
}

/** Activity row: a shell in the debug container, or in the copy's shell container. */
export function openDebugShell(p: DebugPod): void {
  if (p.context !== focusedContext()) {
    flash(`${p.name} is in context ${p.context}: focus a pane in it first`, "warn");
    return;
  }
  void openShell("shell", { ref: { gvr: CORE_PODS, namespace: p.namespace, name: p.name }, container: p.container }, null);
}

/** Activity `x` on a copy (ephemeral containers cannot be removed, so their rows have no stop). */
export async function deleteDebugCopy(p: DebugPod): Promise<boolean> {
  if (p.kind !== "copy") return false;
  const ref: ObjRef = { context: p.context, gvr: CORE_PODS, namespace: p.namespace, name: p.name };
  const targets = targetsFor(ref);
  const ok = await confirmWrite(targets, { verb: "delete", tier: 1, confirmLabel: "Delete", body: `Deletes the debug copy ${p.name} (made from ${p.source}).` });
  if (!ok) return false;
  const [r] = await runOn(targets, () => backend.debugPodDelete(ref), { verb: "delete" });
  if (!r.ok) {
    toasts.error(`Could not delete ${p.name}: ${errorText(r.error)}`);
    return false;
  }
  forgetDebugPod(p);
  toast({ kind: "ok", text: `Deleted ${p.name}` });
  void refreshDebugPods(p.context);
  return true;
}

/** Header X: every copy of the current context, one confirm. */
export async function deleteAllCopies(pods: readonly DebugPod[]): Promise<void> {
  const copies = pods.filter((p) => p.kind === "copy");
  if (copies.length === 0) return;
  if (copies.length === 1) {
    await deleteDebugCopy(copies[0]);
    return;
  }
  const context = copies[0].context;
  const items: ObjRef[] = copies.map((p) => ({ context, gvr: CORE_PODS, namespace: p.namespace, name: p.name }));
  const targets = { ...targetsFor(items[0]), items };
  if (!(await confirmWrite(targets, { verb: "delete", tier: 1, confirmLabel: "Delete", body: "Deletes every kns debug copy in this context." }))) return;
  const results = await runOn(targets, (ref) => backend.debugPodDelete(ref), { verb: "delete" });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) toasts.error(`Could not delete ${failed.length} of ${results.length}: ${errorText(failed[0].error)}`);
  else toast({ kind: "ok", text: `Deleted ${results.length} debug copies` });
  void refreshDebugPods(context);
}

// ── snippets ───────────────────────────────────────────────────────────────

export interface SnippetDialogProps {
  pod: string;
  containers: readonly { name: string; image: string }[];
  container: string;
  user: readonly Snippet[];
  resolve: (r: { snippet: Snippet; container: string } | null) => void;
}

function askSnippet(props: Omit<SnippetDialogProps, "resolve">): Promise<{ snippet: Snippet; container: string } | null> {
  return new Promise((resolve) => showOverlay(SNIPPET_OVERLAY, { ...props, resolve } satisfies SnippetDialogProps));
}

/** The pod behind a row: the pod itself, else a running pod of the workload. */
async function resolvePod(t: Target, context: string): Promise<{ ref: ObjRef; container?: string } | null> {
  if (isPodRef(t.ref)) return { ref: toObjRef(t.ref, context), container: t.container };
  try {
    const pods = await backend.podsFor(toObjRef(t.ref, context));
    const p = pods.find((x) => x.phase === "Running") ?? pods[0];
    if (!p) {
      flash(`no pod behind ${t.ref.name}`, "warn");
      return null;
    }
    return { ref: { context, gvr: CORE_PODS, namespace: p.namespace, name: p.name } };
  } catch (e) {
    toasts.error(`Could not find the pods of ${t.ref.name}: ${errorText(e)}`);
    return null;
  }
}

/** `:x`, `:x <name>`, `:x save <name> <command>`, `:x rm <name>`. */
export async function snippetFlow(args: readonly string[], newPane: "right" | "down" | null): Promise<void> {
  const cmd = parseSnippetArgs(args);
  if (cmd.kind === "error") {
    flash(cmd.message, "warn");
    return;
  }
  if (cmd.kind === "save") {
    saveSnippet({ id: cmd.id, title: cmd.id, command: cmd.command });
    toast({ kind: "ok", text: `Saved snippet ${cmd.id}: run it with :x ${cmd.id}` });
    return;
  }
  if (cmd.kind === "remove") {
    if (removeSnippet(cmd.id)) toast({ kind: "ok", text: `Removed snippet ${cmd.id}` });
    else flash(findSnippet([], cmd.id) ? `${cmd.id} is built in` : `no snippet ${cmd.id}`, "warn");
    return;
  }
  const context = focusedContext();
  const pane = focusedPane();
  const t = pane ? selectionTarget(pane) : null;
  if (!context || !t) {
    flash("select a pod first", "warn");
    return;
  }
  const pod = await resolvePod(t, context);
  if (!pod) return;
  const info = podInfo(await readPod(pod.ref));
  if (info.containers.length === 0) return;
  const user = toolsStore.getState().snippets;
  let snippet: Snippet | undefined;
  let container = pod.container && info.containers.some((c) => c.name === pod.container) ? pod.container : undefined;
  if (cmd.kind === "run") {
    snippet = findSnippet(user, cmd.id);
    if (!snippet) {
      flash(`no snippet ${cmd.id}; :x lists them`, "warn");
      return;
    }
    const s = snippet;
    container ??= (info.containers.find((c) => snippetFits(s, c.image)) ?? info.containers[0]).name;
  } else {
    const picked = await askSnippet({ pod: pod.ref.name, containers: info.containers, container: container ?? info.containers[0].name, user });
    if (!picked) return;
    snippet = picked.snippet;
    container = picked.container;
  }
  await runSnippet(snippet, pod.ref, container, newPane);
}

async function runSnippet(s: Snippet, ref: ObjRef, container: string, newPane: "right" | "down" | null): Promise<void> {
  flash(`running ${s.id} in ${ref.name} · ${container}`);
  let result;
  try {
    result = await backend.snippetRun({ ref, container, command: s.command });
  } catch (e) {
    recordAction({ text: `snippet ${s.id} in ${ref.name} failed`, state: "error", error: errorText(e), context: ref.context, namespace: ref.namespace, target: { kind: "object", gvr: ref.gvr, namespace: ref.namespace, name: ref.name } });
    toasts.error(`Snippet ${s.id} failed: ${errorText(e)}`);
    return;
  }
  // the snippet's id, never its command line (it may carry a secret)
  recordAction({ text: `ran snippet ${s.id} in ${ref.name} · exit ${result.exitCode ?? "?"}`, state: (result.exitCode ?? 0) === 0 ? "ok" : "warn", context: ref.context, namespace: ref.namespace, target: { kind: "object", gvr: ref.gvr, namespace: ref.namespace, name: ref.name } });
  const runId = addRun({
    snippet: s.id, title: s.title, command: s.command, pod: ref.name, namespace: ref.namespace ?? "", container, context: ref.context, at: Date.now(), result,
  });
  openView({ kind: "text", title: `x ${s.id} · ${ref.name}`, source: { by: "snippet", runId } }, { newPane });
}
