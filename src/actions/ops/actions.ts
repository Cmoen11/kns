// Handlers for the mutating actions (docs/ux.md §5.4, §14) and the three owner/node jumps.
// Small and eager: the dialog chunk loads on the first confirm. Every handler snapshots its
// targets first, catches its own errors and reports through one toast.
import type { Gvr, Json, ObjRef } from "../../ipc/types";
import { backend, engine, flash, focusedPane, getSelection, openView, registerActions, resolveResource, tableView, toast, type ActionContext } from "../../foundation";
import { getSettings, settingsStore } from "../../store/settings";
import { permitted } from "./access";
import {
  cordonPatch, fluxOwner, isCordoned, isSuspended, labelsOf, ownerOf, reconcilePatch, replicasOf, sourceRefOf, suspendPatch, type FluxRef,
} from "./flux";
import { appSetRefreshPatch, argoOwner, operationPhase, refreshPatch, syncPatch, type ArgoRef } from "./argo";
import { errorText } from "./bulk";
import { canReapply } from "./reapply-rule";
import { currentTargets, onArgo, onArgoApp, onFlux, onResource, onScalable, onTable, resolveFlux, resourceOfKind, type Targets } from "./targets";
import { deleteTier } from "./tiers";
import { confirmWrite, report, reportReadError, runOn, undoWrite } from "./write";

const read = (ref: ObjRef): Promise<Json | null> => backend.getJson(ref).catch(() => null);

/** The Flux or Argo CD owner of a single target, for the "will be reverted" notice. */
function gitOpsOf(
  obj: Json | null,
  effect: { flux: string; argo: string },
): { flux?: { owner: FluxRef; effect: string }; argo?: { owner: ArgoRef; effect: string } } {
  const flux = fluxOwner(labelsOf(obj));
  if (flux) return { flux: { owner: flux, effect: effect.flux } };
  const argo = argoOwner(obj);
  return argo ? { argo: { owner: argo, effect: effect.argo } } : {};
}

// ── delete and kill ────────────────────────────────────────────────────────

async function deleteTargets(kill: boolean): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  const single = t.items.length === 1;
  const obj = single ? await read(t.items[0]) : null;
  const answer = await confirmWrite(t, {
    verb: kill ? "kill" : "delete",
    tier: kill ? 1 : deleteTier(t.resource, t.gvr.group),
    isDelete: true,
    deleteOptions: !kill,
    body: kill ? "Deletes with grace period 0: the containers get no time to shut down." : undefined,
    ...(kill
      ? {}
      : gitOpsOf(obj, {
          flux: "Flux recreates it on the next reconcile.",
          argo: "Argo CD recreates it on its next sync (at once with self-heal); until then the app is OutOfSync.",
        })),
  });
  if (!answer) return;
  // "re-apply last known YAML" (§14): only for one object that nothing would recreate anyway
  let yaml: string | null = null;
  if (single && !kill && canReapply(t.resource, ownerOf(obj) !== null)) {
    // lazy: the yaml parser stays out of the entry chunk
    const { cleanForReapply } = await import("./reapply");
    yaml = await backend.getYaml(t.items[0]).then(cleanForReapply, () => null);
  }
  const force = kill || answer.force === true;
  const results = await runOn(t, (ref) =>
    backend.deleteObject(ref, { propagation: answer.propagation, gracePeriodSeconds: force ? 0 : undefined }),
    { verb: kill ? "kill" : "delete" },
  );
  const reapply = yaml;
  report(kill ? "Killed" : "Deleted", t, results, {
    undoLabel: "re-apply",
    undo: reapply
      ? async () => {
          if (!(await confirmWrite(t, { verb: "re-apply", tier: 0 }))) return;
          report("Re-applied", t, await runOn(t, () => backend.applyYaml(t.context, reapply), { verb: "re-apply" }));
        }
      : undefined,
  });
}

// ── scale ──────────────────────────────────────────────────────────────────

async function scaleTargets(): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  const single = t.items.length === 1;
  const obj = single ? await read(t.items[0]) : null;
  const answer = await confirmWrite(t, {
    verb: "scale",
    tier: 0,
    replicas: { current: replicasOf(obj) },
    ...gitOpsOf(obj, {
      flux: "If the replica count is set in Git, Flux puts it back on the next reconcile.",
      argo: "If the replica count is set in Git, Argo CD puts it back on its next sync (at once with self-heal).",
    }),
  });
  if (!answer || answer.replicas === undefined) return;
  const to = answer.replicas;
  const results = await runOn(t, async (ref) => {
    const before = single ? replicasOf(obj) : replicasOf(await read(ref));
    await backend.scale(ref, to);
    return before;
  }, { verb: "scale" });
  const changed = results.filter((r) => r.ok && typeof r.value === "number" && r.value !== to);
  const before = new Map(changed.map((r) => [r.item, r.value as number]));
  report("Scaled", t, results, {
    detail: `to ${to}`,
    logText: single && replicasOf(obj) !== null ? `scaled ${t.noun} ${t.items[0].name} ${replicasOf(obj)} → ${to}` : undefined,
    undo: changed.length > 0
      ? undoWrite(t, changed.map((r) => r.item), { verb: "scale", done: "Scaled", detail: single ? `back to ${replicasOf(obj)}` : "back" }, (ref) => backend.scale(ref, before.get(ref) ?? to))
      : undefined,
  });
}

// ── tier 0 and 1 writes ────────────────────────────────────────────────────

/**
 * Confirm, run on every target, toast. Tier 0 (the default) asks only on protected contexts;
 * tier 1 always opens the dialog, Enter confirms (a restart: one click on a row button must not
 * roll a workload).
 */
async function simpleWrite(spec: { verb: string; done: string; detail?: string; tier?: 0 | 1; body?: string }, fn: (ref: ObjRef, t: Targets) => Promise<unknown>): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  if (!(await confirmWrite(t, { verb: spec.verb, tier: spec.tier ?? 0, body: spec.body }))) return;
  report(spec.done, t, await runOn(t, (ref) => fn(ref, t), { verb: spec.verb }), { detail: spec.detail });
}

async function triggerCronJobs(): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  if (!(await confirmWrite(t, { verb: "trigger", tier: 0 }))) return;
  const results = await runOn(t, (ref) => backend.triggerCronJob(ref), { verb: "trigger" });
  const job = results.length === 1 && results[0].ok ? results[0].value : undefined;
  report("Triggered", t, results, { detail: job ? `as job ${job}` : undefined });
}

/**
 * Suspend or resume (CronJobs and Flux kinds): the cursor row decides the direction and every
 * target follows it. Undo puts back only the objects this changed.
 */
async function toggleSuspend(warnFlux: boolean): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  const states = await runOn(t, (ref) => backend.getJson(ref), { read: true });
  const firstState = states[0];
  if (!firstState.ok) return reportReadError(`Cannot read ${t.noun} ${t.items[0].name}`, firstState.error);
  const suspend = !isSuspended(firstState.value);
  const single = t.items.length === 1;
  const answer = await confirmWrite(t, {
    verb: suspend ? "suspend" : "resume",
    tier: 0,
    ...(warnFlux && single
      ? gitOpsOf(firstState.value ?? null, {
          flux: "If spec.suspend is set in Git, Flux puts it back on the next reconcile.",
          argo: "If spec.suspend is set in Git, Argo CD puts it back on its next sync.",
        })
      : {}),
  });
  if (!answer) return;
  const was = new Map(states.map((s) => [s.item, s.ok ? isSuspended(s.value) : undefined]));
  const results = await runOn(t, (ref) => backend.patchObject(ref, suspendPatch(suspend), "merge"), { verb: suspend ? "suspend" : "resume" });
  const changed = results.filter((r) => r.ok && was.get(r.item) === !suspend).map((r) => r.item);
  report(suspend ? "Suspended" : "Resumed", t, results, {
    undo: changed.length > 0
      ? undoWrite(t, changed, { verb: suspend ? "resume" : "suspend", done: suspend ? "Resumed" : "Suspended" }, (ref) =>
          backend.patchObject(ref, suspendPatch(!suspend), "merge"),
        )
      : undefined,
  });
}

async function reconcile(withSource: boolean): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  if (!(await confirmWrite(t, { verb: "reconcile", tier: 0 }))) return;
  let sources = 0;
  const results = await runOn(t, async (ref) => {
    if (withSource) {
      // research.md §5.9: annotate the source first, then the object
      const src = sourceRefOf(await backend.getJson(ref));
      const srcRef = src && resolveFlux(src, t.context);
      if (srcRef) {
        await backend.patchObject(srcRef, reconcilePatch(new Date()), "merge");
        sources++;
      }
    }
    await backend.patchObject(ref, reconcilePatch(new Date()), "merge");
  }, { verb: "reconcile" });
  const detail = withSource ? (sources > 0 ? "with source" : "(no source to reconcile)") : undefined;
  report("Reconcile requested for", t, results, { detail });
}

// ── Argo CD ────────────────────────────────────────────────────────────────

/** Refresh: the controller compares with Git again (hard also drops its manifest cache); an ApplicationSet regenerates. */
async function argoRefresh(hard: boolean): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  const appSet = t.resource === "applicationsets";
  if (!(await confirmWrite(t, { verb: hard && !appSet ? "hard refresh" : "refresh", tier: 0 }))) return;
  const results = await runOn(t, (ref) => backend.patchObject(ref, appSet ? appSetRefreshPatch() : refreshPatch(hard), "merge"), { verb: "refresh" });
  report(hard && !appSet ? "Hard refresh requested for" : "Refresh requested for", t, results);
}

/** Sync to the target revision, as `argocd app sync` does: an `operation` the controller runs. Never prunes. */
async function argoSync(): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  const answer = await confirmWrite(t, {
    verb: "sync",
    tier: 1,
    body: "Applies the target revision from Git to the destination. Resources that are no longer in Git are kept (no prune).",
  });
  if (!answer) return;
  const results = await runOn(t, async (ref) => {
    if (operationPhase(await read(ref)) === "Running") throw new Error("a sync is already running");
    await backend.patchObject(ref, syncPatch(), "merge");
  }, { verb: "sync" });
  report("Sync started for", t, results);
}

async function cordon(on: boolean): Promise<void> {
  const t = currentTargets();
  if (!t) return;
  if (!(await confirmWrite(t, { verb: on ? "cordon" : "uncordon", tier: 0 }))) return;
  const results = await runOn(t, async (ref) => {
    const was = isCordoned(await read(ref));
    await backend.patchObject(ref, cordonPatch(on), "merge");
    return was;
  }, { verb: on ? "cordon" : "uncordon" });
  const changed = results.filter((r) => r.ok && r.value === !on).map((r) => r.item);
  report(on ? "Cordoned" : "Uncordoned", t, results, {
    undo: changed.length > 0
      ? undoWrite(t, changed, { verb: on ? "uncordon" : "cordon", done: on ? "Uncordoned" : "Cordoned" }, (ref) =>
          backend.patchObject(ref, cordonPatch(!on), "merge"),
        )
      : undefined,
  });
}

// ── jumps (read-only) ──────────────────────────────────────────────────────

const cursorRef = (): { t: Targets; ref: ObjRef } | null => {
  const t = currentTargets();
  return t ? { t, ref: t.items[0] } : null;
};

async function openOwner(ctx: ActionContext): Promise<void> {
  const cur = cursorRef();
  if (!cur) return;
  let obj: Json;
  try {
    obj = await backend.getJson(cur.ref);
  } catch (e) {
    return reportReadError(`Cannot read ${cur.t.noun} ${cur.ref.name}`, e);
  }
  const owner = ownerOf(obj);
  if (!owner) return flash(`${cur.ref.name} has no owner`);
  const res = resourceOfKind(owner.kind, owner.group);
  if (!res) return flash(`owner kind ${owner.kind} is not served`, "warn");
  openView(tableView(res.gvr, res.namespaced ? (cur.ref.namespace ?? "*") : "*", { cursorUid: owner.uid }), { newPane: ctx.newPane });
}

async function openNode(ctx: ActionContext): Promise<void> {
  const cur = cursorRef();
  if (!cur) return;
  const nodes = resolveResource("nodes");
  if (!nodes) return flash("nodes are not served", "warn");
  try {
    const pod = (await backend.getJson(cur.ref)) as { spec?: { nodeName?: unknown } } | null;
    const name = typeof pod?.spec?.nodeName === "string" ? pod.spec.nodeName : "";
    if (!name) return flash(`${cur.ref.name} is not scheduled on a node`);
    const node = (await read({ context: cur.t.context, gvr: nodes.gvr, name })) as { metadata?: { uid?: unknown } } | null;
    const uid = typeof node?.metadata?.uid === "string" ? node.metadata.uid : undefined;
    openView(tableView(nodes.gvr, "*", { cursorUid: uid }), { newPane: ctx.newPane });
  } catch (e) {
    reportReadError(`Cannot read pod ${cur.ref.name}`, e);
  }
}

function openReplicaSets(ctx: ActionContext): void {
  const pane = focusedPane();
  const rs = resolveResource("replicasets");
  // the selection's own ref: it carries the uid the owner scope matches on
  const sel = pane ? getSelection(pane) : null;
  const ref = sel?.marked[0] ?? sel?.focused;
  if (!ref || !rs) return;
  openView(tableView(rs.gvr, ref.namespace ?? "*", { scope: { by: "owner", ref } }), { newPane: ctx.newPane });
}

// ── registration ───────────────────────────────────────────────────────────

/** A handler never rejects: the engine would toast the raw error a second time. */
const safe = (fn: (ctx: ActionContext) => void | Promise<void>) => async (ctx: ActionContext): Promise<void> => {
  try {
    await fn(ctx);
  } catch (e) {
    toast({ kind: "error", text: errorText(e) });
  }
};

const jobsGvr = (): Gvr | undefined => resolveResource("jobs")?.gvr;
const hasRow = (): true | string => (currentTargets() ? true : "no row selected");

registerActions({
  "res.delete": { when: onTable, enabled: () => permitted("delete"), run: safe(() => deleteTargets(false)) },
  // exists only while the kill switch is on (§14); never unconfirmed
  "pod.kill": {
    when: () => getSettings().killEnabled && onResource("pods"),
    enabled: () => permitted("delete"),
    run: safe(() => deleteTargets(true)),
  },
  "workload.scale": { when: onScalable, enabled: () => permitted("patch", { subresource: "scale" }), run: safe(scaleTargets) },
  "workload.restart": {
    when: () => onResource("deployments", "statefulsets", "daemonsets"),
    enabled: () => permitted("patch"),
    run: safe(() => simpleWrite({ verb: "restart", done: "Restarted", tier: 1, body: "A rolling restart: the pods are replaced one after another." }, (ref) => backend.restart(ref))),
  },
  "cronjob.trigger": {
    when: () => onResource("cronjobs"),
    enabled: () => permitted("create", { on: jobsGvr }),
    run: safe(triggerCronJobs),
  },
  "cronjob.suspend": { when: () => onResource("cronjobs"), enabled: () => permitted("patch"), run: safe(() => toggleSuspend(true)) },
  "flux.reconcile": { when: onFlux, enabled: () => permitted("patch"), run: safe(() => reconcile(false)) },
  "flux.reconcileWithSource": { when: onFlux, enabled: () => permitted("patch"), run: safe(() => reconcile(true)) },
  "flux.suspendResume": { when: onFlux, enabled: () => permitted("patch"), run: safe(() => toggleSuspend(false)) },
  "argo.refresh": { when: onArgo, enabled: () => permitted("patch"), run: safe(() => argoRefresh(false)) },
  "argo.hardRefresh": { when: onArgoApp, enabled: () => permitted("patch"), run: safe(() => argoRefresh(true)) },
  "argo.sync": { when: onArgoApp, enabled: () => permitted("patch"), run: safe(argoSync) },
  "node.cordon": { when: () => onResource("nodes"), enabled: () => permitted("patch"), run: safe(() => cordon(true)) },
  "node.uncordon": { when: () => onResource("nodes"), enabled: () => permitted("patch"), run: safe(() => cordon(false)) },

  "res.owner": { when: onTable, enabled: hasRow, run: safe(openOwner) },
  "pod.node": { when: () => onResource("pods"), enabled: hasRow, run: safe(openNode) },
  "deploy.replicaSets": { when: () => onResource("deployments"), enabled: hasRow, run: safe(openReplicaSets) },
});

// pod.kill's `when` reads the kill switch: refresh hints and the palette when it flips
let killEnabled = getSettings().killEnabled;
settingsStore.subscribe((s) => {
  if (s.killEnabled === killEnabled) return;
  killEnabled = s.killEnabled;
  engine.invalidate();
});
