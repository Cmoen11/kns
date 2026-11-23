// Feature: diagnosis (docs/plan-features.md §3 C1–C3). Owner: C1 (why, crash card), C2 (timeline,
// journal, traps, sparklines), C3 (relations, reach). Actions are eager and small (./actions,
// ./c2-actions, ./c3-actions); views and dialogs load lazily.
import { useMemo } from "react";
import { backend, focusedContext, defaultCrumbs, openView, registerOverlay, registerView, toast, toasts, type Crumb } from "../foundation";
import { registerTool, registerToolStatus, setToolBuilt, toolById, type ToolSpec, type ToolId } from "../hub/catalog";
import { clusterStore } from "../store/cluster";
import { registerActivityGroup } from "../sidepanels/groups";
import type { PanelRow } from "../sidepanels/model";
import { cleanUntrusted } from "../ui/untrusted";
import { registerTextSource } from "../views/text";
import type { ItemRow } from "../views/tools/list-model";
import { registerHomeSection } from "../views/tools/home-sections";
import "./actions";
import { TRAP_OVERLAY, type TrapDialogProps } from "./c2-actions";
import { REACH_OVERLAY, type ReachDialogProps } from "./c3-actions";
import { installRolloutWatch, rolloutStatus, useRolloutRows, useRollouts } from "./rollout";
import { reachTitle } from "./reach-model";
import { errorText, initC2, refreshJournal, refreshTraps, useC2 } from "./c2-store";
import { configureSpark } from "./spark";
import { sinceLabel } from "./timeline-model";
import { bytesLabel, journalStatusText, trapDetail, trapStatusText, trapTargetLabel } from "./traps-model";


const openBundle = (id: string, title: string, newPane: "right" | "down" | null = null) =>
  openView({ kind: "text", title: `bundle · ${title}`, source: { by: "bundle", id } }, { newPane });

function useTrapRows(): PanelRow[] {
  const traps = useC2((s) => s.traps);
  return useMemo(
    () =>
      traps.map((t): PanelRow => {
        const last = t.fired[t.fired.length - 1];
        const label = cleanUntrusted(trapTargetLabel(t));
        return {
          key: `trap:${t.id}`,
          section: "traps",
          label,
          detail: trapDetail(t),
          glyph: last ? "warn" : "progress",
          since: last ? Date.parse(last.at) : Date.parse(t.armedAt),
          activate: () => (last ? openBundle(last.bundleId, label) : openView({ kind: "traps" })),
          stop: () =>
            backend.trapDisarm(t.id).then(
              () => void refreshTraps(),
              (e: unknown) => toasts.error(`Disarm: ${errorText(e)}`),
            ),
        };
      }),
    [traps],
  );
}

function useJournalRows(): PanelRow[] {
  const journal = useC2((s) => s.journal);
  return useMemo(
    () =>
      journal
        .filter((j) => j.on)
        .map((j): PanelRow => ({
          key: `journal:${j.context}`,
          section: "journal",
          label: `journal · ${cleanUntrusted(j.context)}`,
          detail: `${j.rows} Warning event${j.rows === 1 ? "" : "s"} · ${bytesLabel(j.bytes)} · kept 7 days`,
          glyph: "ok",
          stay: true,
          stop: () =>
            backend.journalSet(j.context, false).then(
              () => {
                toast({ kind: "ok", text: `Event journal off for ${cleanUntrusted(j.context)} (recorded rows stay)` });
                void refreshJournal();
              },
              (e: unknown) => toasts.error(`Journal: ${errorText(e)}`),
            ),
        })),
    [journal],
  );
}

function useTrapHomeRows(): readonly ItemRow[] {
  const traps = useC2((s) => s.traps);
  return useMemo(
    () =>
      traps.map((t): ItemRow => {
        const last = t.fired[t.fired.length - 1];
        const label = cleanUntrusted(trapTargetLabel(t));
        return {
          type: "item",
          key: t.id,
          cells: [label, trapDetail(t)],
          glyph: last ? "warn" : undefined,
          value: last ? "bundle" : "armed",
          open: (newPane) => (last ? openBundle(last.bundleId, label, newPane) : openView({ kind: "traps" }, { newPane })),
        };
      }),
    [traps],
  );
}

export function register(): void {
  registerView({
    kinds: ["why"],
    component: () => import("./WhyView"),
    crumbs: (v): Crumb[] => [
      ...defaultCrumbs({ kind: "doc", ref: v.ref, format: "describe", mode: "view", managedFields: false, wrap: false }).slice(0, -1),
      { label: "why" },
    ],
    toolbar: () => ["view.refresh", "why.copy", "pane.followToggle", "|", "hub.help"],
  });
  registerView({
    kinds: ["timeline"],
    component: () => import("./TimelineView"),
    crumbs: (v): Crumb[] => [
      ...defaultCrumbs({ kind: "doc", ref: v.ref, format: "describe", mode: "view", managedFields: false, wrap: false }).slice(0, -1),
      { label: `timeline · ${sinceLabel(v.sinceMinutes)}` },
    ],
    toolbar: () => ["view.refresh", "res.logs", "|", "hub.help"],
  });
  registerView({
    kinds: ["traps"],
    component: () => import("./TrapsView"),
    crumbs: () => [{ label: "traps" }],
    toolbar: () => ["view.refresh", "trap.disarm", "|", "hub.help"],
  });
  registerView({
    kinds: ["relations"],
    component: () => import("./RelationsView"),
    crumbs: (v): Crumb[] => [
      ...defaultCrumbs({ kind: "doc", ref: v.ref, format: "describe", mode: "view", managedFields: false, wrap: false }).slice(0, -1),
      { label: "relations" },
    ],
    toolbar: () => ["view.refresh", "relations.collapse", "relations.expand", "|", "hub.help"],
  });
  registerView({
    kinds: ["reach"],
    component: () => import("./ReachView"),
    crumbs: (v): Crumb[] => [{ label: cleanUntrusted(reachTitle(v)) }],
    toolbar: () => ["view.refresh", "|", "hub.help"],
  });
  registerOverlay<TrapDialogProps>(TRAP_OVERLAY, () => import("./TrapDialog"));
  registerOverlay<ReachDialogProps>(REACH_OVERLAY, () => import("./ReachDialog"));

  // incident bundles as `text` views (§2.8): markdown written and redacted by Rust
  registerTextSource("bundle", async (src) => {
    const body = await backend.bundleGet(src.id);
    const title = /^# (.*)$/m.exec(body)?.[1] ?? `bundle ${src.id}`;
    return { title, sections: [{ id: "bundle", title: "", body, format: "markdown" }] };
  });

  registerActivityGroup({ id: "rollouts", label: "Rollouts", order: 20, useRows: useRolloutRows });
  registerActivityGroup({ id: "traps", label: "Traps", order: 45, useRows: () => ({ rows: useTrapRows() }) });
  registerActivityGroup({ id: "journal", label: "Journal", order: 95, useRows: () => ({ rows: useJournalRows() }) });
  registerHomeSection({ id: "traps", label: "Traps", order: 30, useRows: useTrapHomeRows });

  registerToolStatus("trap", () => {
    const text = trapStatusText(useC2((s) => s.traps));
    return text ? { text, state: "active" } : null;
  });
  registerToolStatus("journal", () => {
    const text = journalStatusText(useC2((s) => s.journal));
    return text ? { text, state: "ok" } : { text: "off", state: "off" };
  });

  registerToolStatus("rollout", () => rolloutStatus(useRollouts((s) => s.watches)));

  setToolBuilt("crash");
  setToolBuilt("rollout");
  installRolloutWatch();
  refineC3();
  setToolBuilt("sparklines");
  configureSpark((context) => backend.podMetricsHistory(context), focusedContext);
  initC2((fn) => {
    let last: string | null = null;
    clusterStore.subscribe((s) => {
      const ctx = s.status === "connected" ? s.context : null;
      if (ctx !== last) {
        last = ctx;
        if (ctx) fn(ctx);
      }
    });
  });
}

/** C3 refines its catalog entries from here (as F does), so the hub help matches what was built. */
function refine(id: ToolId, patch: Partial<ToolSpec>): void {
  const t = toolById(id);
  if (!t) return;
  const { built: _built, ...rest } = t;
  registerTool({ ...rest, ...patch });
}

function refineC3(): void {
  refine("reach", {
    summary: "Can this pod talk to that Service: ports, endpoints, policies, then a probe",
    help: {
      answers: "From a pod, `:reach web:80` (or the row menu, which asks for the target) checks the Service port, ready endpoints, the container port, and the NetworkPolicies of both ends and DNS egress by the standard rules. Each step says ok, fail or undecided; Enter on a step opens the Service's why or the policies. The probe row then connects from inside the pod.",
      notFor: "CNI-specific policies (Cilium, Calico) are named but not evaluated; the probe answers for this pod, now.",
      safety: "The checks only read. The probe asks first, then runs one fixed command (nc, wget or bash /dev/tcp) as an exec; without exec rights or tools it offers a debug container.",
      example: ":reach web:80 on an envdemo pod in kns-spike: every step green, then the probe connects.",
    },
    commands: [":reach", ":reach <service>:<port>", ":reach svc/<name>.<namespace> <port>", ":reach pod/<name> <port>"],
  });
  refine("relations", {
    summary: "What owns this object, what it owns, what sends it traffic and what it mounts",
    help: {
      answers: "A tree from the object up through its owners to the Flux Kustomization or HelmRelease and its source, down to what it owns (ReplicaSets, pods, Jobs), across to the Services and Ingresses in front of it, and to the ConfigMaps, Secrets, PVCs and ServiceAccount it uses. h / l fold, Enter describes a node.",
      notFor: "Who uses a ConfigMap or Secret (the reverse direction).",
      safety: "Read only. Secrets appear by name; their values are never read.",
      example: ":relations on deploy/web: owned by Kustomization apps, then GitRepository flux-system; owns a ReplicaSet and its pods; svc/web with Ingress web in front.",
    },
  });
  refine("rollout", {
    summary: "Follows a restart, scale or reconcile to the end in the activity panel",
    help: {
      answers: "After a restart, scale or Flux reconcile succeeds, Activity → Rollouts follows each object for 5 minutes (2/3 updated · 1 unavailable · waiting 40s, then done in Ns). When nothing moves for 2 minutes the row warns; Enter opens :why for the object, x dismisses.",
      notFor: "Rollouts started outside kns (kubectl, Flux on its own schedule).",
      safety: "Read only: it reads the object every few seconds while a row is open, and not at all otherwise.",
      example: "r on deploy/web in kns-spike, confirm: the Rollouts row counts the new pods up to done.",
    },
  });
}
