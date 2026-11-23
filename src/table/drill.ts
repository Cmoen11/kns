// Drill-down targets (docs/ux.md §4.3) and the view states the row actions open. Pure: view
// states are built from src/types only, so the doc, logs and shell features just render them.
import type { Gvr } from "../ipc/types";
import type { ContainersView, DocView, LogsView, ObjectRef, TableView, ViewState } from "../types";

const CORE_PODS: Gvr = { group: "", version: "v1", resource: "pods" };
const BATCH_JOBS: Gvr = { group: "batch", version: "v1", resource: "jobs" };

const table = (gvr: Gvr, namespace: string, extra: Partial<TableView> = {}): TableView => ({
  kind: "table", gvr, namespace, filters: [], faultsOnly: false, sort: null, wide: false, ...extra,
});

export const docView = (ref: ObjectRef, format: DocView["format"], mode: DocView["mode"] = "view"): DocView => ({
  kind: "doc", ref, format, mode, managedFields: false, wrap: false,
});
export const logsView = (ref: ObjectRef, container: string, previous: boolean): LogsView => ({
  kind: "logs", target: { by: "object", ref }, container, since: "tail", previous, wrap: false, timestamps: false, filterLines: false,
});

export const containersView = (pod: ObjectRef): ContainersView => ({ kind: "containers", pod, sort: null });

export const podsBySelector = (namespace: string | undefined, selector: string): TableView =>
  table(CORE_PODS, namespace ?? "*", { scope: { by: "selector", selector } });

/** `{app: "web", tier: "api"}` -> `app=web,tier=api`; null when there is no selector. */
export function selectorString(selector: unknown): string | null {
  if (typeof selector !== "object" || selector === null || Array.isArray(selector)) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(selector)) if (typeof v === "string") parts.push(`${k}=${v}`);
  return parts.length > 0 ? parts.join(",") : null;
}

export interface DrillInput {
  gvr: Gvr;
  ref: ObjectRef;
  /** the involved object of an event row, `pod/web-7d9f8` */
  eventObject?: string;
  /** alias lookup from discovery: plural, singular, kind, `plural.group` */
  resolve: (name: string) => { gvr: Gvr; namespaced: boolean } | undefined;
}

/** What Enter opens for a row. `service` needs the object's selector first (one getJson). */
export type Drill = { view: ViewState } | { service: ObjectRef };

const OWNS_PODS = new Set(["apps/deployments", "apps/statefulsets", "apps/daemonsets", "apps/replicasets", "batch/jobs"]);

export function drill({ gvr, ref, eventObject, resolve }: DrillInput): Drill {
  const key = `${gvr.group}/${gvr.resource}`;
  const ns = ref.namespace ?? "*";
  if (OWNS_PODS.has(key)) return { view: table(CORE_PODS, ns, { scope: { by: "owner", ref } }) };
  switch (key) {
    case "batch/cronjobs":
      return { view: table(BATCH_JOBS, ns, { scope: { by: "owner", ref } }) };
    case "/pods":
      return { view: containersView(ref) };
    case "/nodes":
      return { view: table(CORE_PODS, "*", { scope: { by: "node", name: ref.name } }) };
    case "/namespaces":
      return { view: table(CORE_PODS, ref.name) };
    case "/services":
      return { service: ref };
    case "apiextensions.k8s.io/customresourcedefinitions": {
      const r = resolve(ref.name);
      return { view: r ? table(r.gvr, "*") : docView(ref, "describe") };
    }
    case "/events":
    case "events.k8s.io/events": {
      const slash = eventObject?.indexOf("/") ?? -1;
      if (eventObject && slash > 0) {
        const r = resolve(eventObject.slice(0, slash));
        const name = eventObject.slice(slash + 1);
        if (r && name) return { view: docView({ gvr: r.gvr, namespace: r.namespaced ? ref.namespace : undefined, name }, "describe") };
      }
      return { view: docView(ref, "describe") };
    }
    default:
      // ConfigMap, Secret, PVC, PV, Ingress, CRD instances, Flux kinds: describe. Never decodes a Secret.
      return { view: docView(ref, "describe") };
  }
}
