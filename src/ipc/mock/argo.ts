// Argo CD in the mock cluster. The `shop` and `payments` namespaces are deployed by Argo CD with
// apps in any namespace: each app's Application lives in its own namespace and the objects it
// applies carry `argocd.argoproj.io/tracking-id`. The `default` context serves the Application
// kinds (an admin's view); `staging` does not (a team member who only sees the workload cluster),
// so there the ownership comes from the objects alone.
import type { Finding, Gvr, Json, ObjRef } from "../types";

export const ARGO_GVRS = {
  apps: { group: "argoproj.io", version: "v1alpha1", resource: "applications" },
  appsets: { group: "argoproj.io", version: "v1alpha1", resource: "applicationsets" },
} satisfies Record<string, Gvr>;

const ARGO_NAMESPACES = new Set(["shop", "payments"]);
export const argoManaged = (namespace: string | undefined | null): boolean => !!namespace && ARGO_NAMESPACES.has(namespace);
/** The context whose discovery leaves Argo CD out. */
export const NO_ARGO_CONTEXT = "staging";

const KIND: Record<string, [string, string]> = {
  deployments: ["apps", "Deployment"], statefulsets: ["apps", "StatefulSet"], daemonsets: ["apps", "DaemonSet"], services: ["", "Service"],
  configmaps: ["", "ConfigMap"], ingresses: ["networking.k8s.io", "Ingress"], cronjobs: ["batch", "CronJob"],
};

/** The tracking annotation of an object the mock says Argo CD applied (top-level kinds only: pods and ReplicaSets have owners). */
export function trackingAnnotation(ref: { gvr: Gvr; namespace?: string | null; name: string }): Record<string, string> {
  const k = KIND[ref.gvr.resource];
  if (!k || !argoManaged(ref.namespace) || ref.gvr.group !== k[0]) return {};
  const app = ref.name.split("-")[0];
  return { "argocd.argoproj.io/tracking-id": `${ref.namespace}_${app}:${k[0]}/${k[1]}:${ref.namespace}/${ref.name}` };
}

/** Sync and health per app: one degraded, one out of sync, one rolling out, the rest fine. */
export function appState(app: string): { sync: string; health: string } {
  switch (app) {
    case "checkout":
      return { sync: "Synced", health: "Degraded" };
    case "orders":
      return { sync: "OutOfSync", health: "Healthy" };
    case "search":
      return { sync: "Synced", health: "Progressing" };
    default:
      return { sync: "Synced", health: "Healthy" };
  }
}

const REV = "4f2c9e1a7b3d5f6e8a9b0c1d2e3f4a5b6c7d8e9f";

/** An Application object as the API returns it (status trimmed to what kns reads). */
export function mockApplication(ref: ObjRef, created: string): Json {
  const app = ref.name;
  const ns = ref.namespace ?? "argocd";
  const st = appState(app);
  const resources: Json[] = [
    { kind: "Service", namespace: ns, name: app, version: "v1", status: "Synced", health: { status: "Healthy" } },
    {
      group: "apps", kind: "Deployment", namespace: ns, name: app, version: "v1",
      status: st.sync,
      health: st.health === "Degraded"
        ? { status: "Degraded", message: `Deployment "${app}" exceeded its progress deadline` }
        : { status: st.health === "Progressing" ? "Progressing" : "Healthy", ...(st.health === "Progressing" ? { message: "Waiting for rollout to finish: 1 of 2 updated replicas are available..." } : {}) },
    },
    { kind: "ConfigMap", namespace: ns, name: `${app}-env`, version: "v1", status: st.sync === "OutOfSync" ? "OutOfSync" : "Synced" },
  ];
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: app, namespace: ns, uid: `app-${ns}-${app}`, creationTimestamp: created, labels: { team: "shop" } },
    spec: {
      project: ns,
      source: { repoURL: `https://github.com/example/${ns}-ops.git`, path: `${app}/test`, targetRevision: "HEAD" },
      destination: { name: "workload-test", namespace: ns },
      syncPolicy: app === "orders" ? {} : { automated: { prune: true, selfHeal: true } },
    },
    status: {
      sync: { status: st.sync, revision: REV },
      health: { status: st.health },
      resources,
      operationState: { phase: "Succeeded", message: "successfully synced (all tasks run)", syncResult: { revision: REV, resources: [] } },
      conditions: [],
    },
  };
}

/** Canned `:why` of an Application or ApplicationSet, shaped like diagnose/argo.rs. */
export function argoDiagnosis(ref: ObjRef): { findings: Finding[]; checked: string[] } {
  if (ref.gvr.resource === "applicationsets") return { findings: [], checked: ["conditions", "events"] };
  const checked = ["conditions", "last sync", "health", "sync status", "events"];
  const app = ref.name;
  const st = appState(app);
  const field = (path: string, value: string) => ({ type: "field" as const, ref, path, value });
  const findings: Finding[] = [];
  if (st.health === "Degraded") {
    findings.push({ severity: "error", title: `Deployment ${ref.namespace}/${app} is Degraded`, detail: `Deployment "${app}" exceeded its progress deadline`, evidence: [field("/status/resources/1/health", `Degraded: Deployment "${app}" exceeded its progress deadline`)] });
  }
  if (st.health === "Progressing") {
    findings.push({ severity: "info", title: "progressing", detail: "a rollout is under way", evidence: [field("/status/health/status", "Progressing")] });
  }
  if (st.sync === "OutOfSync") {
    findings.push({
      severity: "warn",
      title: "2 resources are out of sync (Git at 4f2c9e1)",
      detail: "auto-sync is off: nothing changes until the app is synced (Y)",
      evidence: [field("/status/sync/status", "OutOfSync"), field("/status/resources/1/status", `Deployment ${ref.namespace}/${app} OutOfSync`), field("/status/resources/2/status", `ConfigMap ${ref.namespace}/${app}-env OutOfSync`)],
    });
  }
  return { findings, checked };
}

/** The relations owner node of an object Argo CD applied, as relations.rs builds it. */
export function argoOwnerStatus(context: string, app: string): string {
  if (context === NO_ARGO_CONTEXT) return "Argo CD (Applications are not served in this cluster)";
  const st = appState(app);
  return `${st.sync} · ${st.health}`;
}
