// In-memory Backend for `pnpm dev` in a plain browser and for tests.
// Generates a plausible cluster with live churn so tables, logs and shells can be built without Tauri.
// Feature contracts are mocked in ./mock/<pkg>.ts (one owner each, typed as the full XBackend) and
// spread in below; ./mock/events.ts is the mock event bus.
import { agentsMock } from "./mock/agents";
import { appState, argoManaged, mockApplication, NO_ARGO_CONTEXT, trackingAnnotation } from "./mock/argo";
import { TEAM_CONTEXT, TEAM_NAMESPACES, catalogMock, mockForbidden } from "./mock/catalog";
import { dbMock } from "./mock/db";
import { debugMock } from "./mock/debug";
import { devMock } from "./mock/dev";
import { installKnsMock } from "./mock/devtools";
import { diagMock, mockPodStatus } from "./mock/diag";
import { diffMock } from "./mock/diff";
import { eventsMock } from "./mock/events";
import { fwdMock, mockExtraObjects, mockRollout } from "./mock/fwd";
import { githubMock } from "./mock/github";
import { logsMock } from "./mock/logs";
import { packMock } from "./mock/pack";
import { trafficMock } from "./mock/traffic";
import { routesMock } from "./mock/routes";
import { updateMock } from "./mock/update";
import { MOCK_CONTEXT_FLAGS, delay, mockState as state } from "./mock/shared";
import { deriveStatus, isFault } from "../table/status";
import type {
  ApiResource,
  Backend,
  BackgroundStatus,
  HerdrInstallReport,
  HerdrStatus,
  Column,
  ContextInfo,
  EventRow,
  ExecSession,
  Gvr,
  Json,
  NsHealth,
  NsHealthSnapshot,
  ObjRef,
  PodRef,
  Row,
  TableQuery,
} from "./types";


// background and Herdr (background.rs, herdr.rs): kept in memory
const background = { keepRunning: true, launchAtLogin: false };
const herdr = { installed: false };
function mockBackground(): BackgroundStatus {
  return { ...background, startedInBackground: false, windowOpen: true, socket: { path: "/tmp/kns.sock", listening: true, clients: 1 } };
}
function mockHerdr(): HerdrStatus {
  return {
    appFound: true, modDir: "~/.config/herdr-app/mods/kns", modInstalled: herdr.installed, modCurrent: herdr.installed,
    tuiFound: false, tuiPluginWritten: false, knsTui: "/Applications/kns.app/Contents/MacOS/kns-tui",
    tcp: herdr.installed ? { enabled: true, listening: true, port: 53124 } : { enabled: false, listening: false },
  };
}

const CONTEXTS: ContextInfo[] = [
  { name: "default", cluster: "k3s-home", user: "admin", namespace: "default" },
  { name: "staging", cluster: "k3s-staging", user: "dev", awsProfile: "sso-dev-eks" },
  // a team member on a shared cluster: only a few namespaces (mock/catalog.ts)
  TEAM_CONTEXT,
];

const NAMESPACES = ["default", "kube-system", "flux-system", "shop", "support", "games", "kafka", "payments"];

function res(
  group: string,
  version: string,
  resource: string,
  kind: string,
  namespaced: boolean,
  shortNames: string[] = [],
  subresources: string[] = ["status"],
  categories: string[] = ["all"],
): ApiResource {
  return {
    gvr: { group, version, resource },
    kind,
    singular: kind.toLowerCase(),
    namespaced,
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
    shortNames,
    categories,
    subresources,
  };
}

const RESOURCES: ApiResource[] = [
  res("", "v1", "pods", "Pod", true, ["po"], ["status", "log", "exec", "attach", "portforward", "eviction"]),
  res("", "v1", "services", "Service", true, ["svc"]),
  res("", "v1", "configmaps", "ConfigMap", true, ["cm"], []),
  res("", "v1", "secrets", "Secret", true, [], []),
  res("", "v1", "namespaces", "Namespace", false, ["ns"]),
  res("", "v1", "nodes", "Node", false, ["no"]),
  res("", "v1", "events", "Event", true, ["ev"], []),
  res("", "v1", "persistentvolumeclaims", "PersistentVolumeClaim", true, ["pvc"]),
  res("", "v1", "persistentvolumes", "PersistentVolume", false, ["pv"]),
  res("", "v1", "serviceaccounts", "ServiceAccount", true, ["sa"], []),
  res("apps", "v1", "deployments", "Deployment", true, ["deploy", "dp"], ["status", "scale"]),
  res("apps", "v1", "statefulsets", "StatefulSet", true, ["sts"], ["status", "scale"]),
  res("apps", "v1", "daemonsets", "DaemonSet", true, ["ds"]),
  res("apps", "v1", "replicasets", "ReplicaSet", true, ["rs"], ["status", "scale"]),
  res("batch", "v1", "jobs", "Job", true),
  res("batch", "v1", "cronjobs", "CronJob", true, ["cj"]),
  res("networking.k8s.io", "v1", "ingresses", "Ingress", true, ["ing"]),
  res("networking.k8s.io", "v1", "networkpolicies", "NetworkPolicy", true, ["netpol"], []),
  res("apiextensions.k8s.io", "v1", "customresourcedefinitions", "CustomResourceDefinition", false, ["crd", "crds"]),
  res("rbac.authorization.k8s.io", "v1", "roles", "Role", true, [], []),
  res("rbac.authorization.k8s.io", "v1", "clusterroles", "ClusterRole", false, [], []),
  res("kustomize.toolkit.fluxcd.io", "v1", "kustomizations", "Kustomization", true, ["ks"]),
  res("helm.toolkit.fluxcd.io", "v2", "helmreleases", "HelmRelease", true, ["hr"]),
  res("source.toolkit.fluxcd.io", "v1", "gitrepositories", "GitRepository", true, ["gitrepo"]),
  res("argoproj.io", "v1alpha1", "applications", "Application", true, ["app", "apps"]),
  res("argoproj.io", "v1alpha1", "applicationsets", "ApplicationSet", true, ["appset", "appsets"]),
];

const col = (name: string, type = "string", priority = 0): Column => ({ name, type, format: "", description: "", priority });

const COLUMNS: Record<string, Column[]> = {
  pods: [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age"), col("IP", "string", 1), col("Node", "string", 1)],
  deployments: [col("Name"), col("Ready"), col("Up-to-date", "integer"), col("Available", "integer"), col("Age")],
  statefulsets: [col("Name"), col("Ready"), col("Age")],
  daemonsets: [col("Name"), col("Desired", "integer"), col("Current", "integer"), col("Ready", "integer"), col("Age")],
  services: [col("Name"), col("Type"), col("Cluster-IP"), col("External-IP"), col("Port(s)"), col("Age")],
  nodes: [col("Name"), col("Status"), col("Roles"), col("Age"), col("Version")],
  namespaces: [col("Name"), col("Status"), col("Age")],
  events: [col("Last Seen"), col("Type"), col("Reason"), col("Object"), col("Message")],
  kustomizations: [col("Name"), col("Age"), col("Ready"), col("Status")],
  helmreleases: [col("Name"), col("Age"), col("Ready"), col("Status")],
  cronjobs: [col("Name"), col("Schedule"), col("Suspend", "boolean"), col("Active", "integer"), col("Last Schedule"), col("Age")],
  jobs: [col("Name"), col("Status"), col("Completions"), col("Duration"), col("Age")],
  // the printer columns of the Argo CD CRD
  applications: [col("Name"), col("Sync Status"), col("Health Status"), col("Revision", "string", 10), col("Project", "string", 10)],
};
const DEFAULT_COLUMNS = [col("Name"), col("Age")];

const APPS = ["web", "api", "worker", "checkout", "admin", "search", "orders", "postgres", "redis", "kafka", "proxy", "backup"];
const POD_STATUS = ["Running", "Running", "Running", "Running", "Running", "Running", "Pending", "CrashLoopBackOff", "Completed", "ImagePullBackOff", "Terminating", "ContainerCreating"];

let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function age(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const ownerUid = (resource: string, ns: string | undefined, app: string) => `${resource}-${ns ?? "_"}-${app}`;
/** a stable pod-template-hash look-alike per app */
const rsHash = (app: string) => (app.length * 2654435761 + app.charCodeAt(0) * 40503).toString(16).padStart(9, "0").slice(0, 9);

/** `a=b,c!=d,e` (equality, inequality, existence): what the frontend sends as a labelSelector. */
function matchesLabels(selector: string | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector) return true;
  for (const term of selector.split(",").map((t) => t.trim()).filter(Boolean)) {
    const m = /^([^!=\s]+)\s*(==|=|!=)\s*(.*)$/.exec(term);
    if (!m) {
      if (term.startsWith("!") ? labels?.[term.slice(1)] !== undefined : labels?.[term] === undefined) return false;
    } else if ((labels?.[m[1]] === m[3]) === (m[2] === "!=")) return false;
  }
  return true;
}
/** Only `metadata.name=`; `spec.nodeName=` matches everything (the mock has one node). */
function matchesFields(selector: string | undefined, row: Row): boolean {
  if (!selector) return true;
  for (const term of selector.split(",")) {
    const [k, v] = term.split("=");
    if (k.trim() === "metadata.name" && row.name !== v?.trim()) return false;
  }
  return true;
}

function makeRow(resource: string, ns: string | undefined, i: number): Row {
  const app = APPS[i % APPS.length];
  const created = ago(60_000 + rnd() * 30 * 86_400_000);
  // workloads get a stable uid so pods can point at their owners (owner drill-downs, §4.3)
  const stable = resource === "deployments" || resource === "replicasets";
  const base = { uid: stable ? ownerUid(resource, ns, app) : `${resource}-${ns ?? "_"}-${i}-${hex(6)}`, namespace: ns, created, labels: { app } };
  const a = age(created);
  switch (resource) {
    case "pods": {
      const name = `${app}-${hex(9)}-${hex(5)}`;
      const status = pick(POD_STATUS);
      const ready = status === "Running" ? "1/1" : status === "Completed" ? "0/1" : "0/1";
      const restarts = status === "CrashLoopBackOff" ? `${Math.floor(rnd() * 40) + 5} (2m ago)` : `${Math.floor(rnd() * 3)}`;
      return {
        ...base,
        name,
        deleting: status === "Terminating" ? ago(5000) : undefined,
        owners: [{ kind: "ReplicaSet", name: `${app}-${rsHash(app)}`, uid: ownerUid("replicasets", ns, app), apiVersion: "apps/v1" }],
        cells: [name, ready, status, restarts, a, `10.42.0.${Math.floor(rnd() * 250)}`, "node-7f3a9c21"],
      };
    }
    case "deployments": {
      const n = Math.floor(rnd() * 3) + 1;
      const r = rnd() > 0.85 ? n - 1 : n;
      return { ...base, name: app, cells: [app, `${r}/${n}`, n, r, a] };
    }
    case "replicasets": {
      const name = `${app}-${rsHash(app)}`;
      return { ...base, name, owners: [{ kind: "Deployment", name: app, uid: ownerUid("deployments", ns, app), apiVersion: "apps/v1" }], cells: [name, a] };
    }
    case "statefulsets":
      return { ...base, name: app, cells: [app, "1/1", a] };
    case "daemonsets":
      return { ...base, name: app, cells: [app, 1, 1, 1, a] };
    case "services":
      return { ...base, name: app, cells: [app, "ClusterIP", `10.43.${i}.${Math.floor(rnd() * 250)}`, "<none>", "80/TCP", a] };
    case "nodes":
      return { ...base, namespace: undefined, name: `node-${hex(8)}`, cells: [`node-${i}`, "Ready", "control-plane,master", a, "v1.35.10+k3s1"] };
    case "namespaces": {
      const name = NAMESPACES[i % NAMESPACES.length];
      return { ...base, namespace: undefined, name, cells: [name, "Active", a] };
    }
    case "events": {
      const warn = rnd() > 0.7;
      const name = `${app}.${hex(12)}`;
      return { ...base, name, cells: [age(ago(rnd() * 3_600_000)), warn ? "Warning" : "Normal", warn ? "BackOff" : "Pulled", `pod/${app}-${hex(5)}`, warn ? "Back-off restarting failed container" : "Successfully pulled image"] };
    }
    case "kustomizations":
    case "helmreleases": {
      const okay = rnd() > 0.2;
      return { ...base, name: app, cells: [app, a, okay ? "True" : "False", okay ? "Applied revision: main@sha1:" + hex(8) : "kustomize build failed: ..."] };
    }
    case "applications": {
      const st = appState(app);
      return { ...base, uid: `app-${ns}-${app}`, name: app, cells: [app, st.sync, st.health, "4f2c9e1a7b3d", ns ?? ""] };
    }
    case "cronjobs":
      return { ...base, name: `${app}-nightly`, cells: [`${app}-nightly`, "0 3 * * *", false, 0, "8h", a] };
    case "jobs":
      return { ...base, name: `${app}-${hex(5)}`, cells: [`${app}-${hex(5)}`, "Complete", "1/1", "12s", a] };
    default: {
      const name = `${app}-${resource.slice(0, 4)}-${i}`;
      return { ...base, name, cells: [name, a] };
    }
  }
}

const COUNT: Record<string, number> = { pods: 9, nodes: 1, namespaces: NAMESPACES.length, events: 12, applications: 7, applicationsets: 1 };
/** Kinds the mock only has in the namespaces Argo CD deploys to. */
const ARGO_ONLY = new Set(["applications", "applicationsets"]);
const tables = new Map<string, Row[]>();

function rowsFor(q: TableQuery): Row[] {
  const r = RESOURCES.find((x) => x.gvr.resource === q.gvr.resource && x.gvr.group === q.gvr.group);
  const key = `${q.context}/${q.gvr.group}/${q.gvr.resource}`;
  let all = tables.get(key);
  if (!all) {
    all = [];
    const per = COUNT[q.gvr.resource] ?? 4;
    if (r && !r.namespaced) for (let i = 0; i < per; i++) all.push(makeRow(q.gvr.resource, undefined, i));
    else for (const ns of NAMESPACES) {
      if (ARGO_ONLY.has(q.gvr.resource) && (q.gvr.group !== "argoproj.io" || !argoManaged(ns))) continue;
      for (let i = 0; i < per; i++) all.push(makeRow(q.gvr.resource, ns, i));
    }
    // named objects the feature mocks describe in detail (svc/kafka, deploy/orders, ...)
    for (const x of mockExtraObjects(q.gvr.resource)) {
      const row = makeRow(q.gvr.resource, x.namespace, 0);
      all.push({ ...row, uid: `${q.gvr.resource}-${x.namespace}-${x.name}`, name: x.name, labels: { app: x.name, ...x.labels }, cells: [x.name, ...(x.cells ?? row.cells.slice(1))] });
    }
    tables.set(key, all);
  }
  const selected = q.labelSelector || q.fieldSelector;
  const among = q.namespaces?.length ? new Set(q.namespaces) : null;
  if (!q.namespace && !selected && !among) return all;
  return all.filter(
    (x) =>
      (!q.namespace || !x.namespace || x.namespace === q.namespace) &&
      (!among || !x.namespace || among.has(x.namespace)) &&
      matchesLabels(q.labelSelector, x.labels) &&
      matchesFields(q.fieldSelector, x),
  );
}

/**
 * Namespace health of the mock cluster (contract/health.ts), derived from the same rows the tables
 * show with the table's own fault rule, so a badge counts the rows the faults views of that namespace list.
 */
export function mockNsHealth(context: string, only?: readonly string[]): NsHealthSnapshot {
  const by = new Map<string, NsHealth>();
  const at = (ns: string) => by.get(ns) ?? (by.set(ns, { namespace: ns, podsFailing: 0, podsWarn: 0, workloads: [] }), by.get(ns)!);
  let pods = 0;
  let workloads = 0;
  for (const resource of ["pods", "deployments", "statefulsets", "daemonsets"] as const) {
    const gvr = { group: resource === "pods" ? "" : "apps", version: "v1", resource };
    const names = (COLUMNS[resource] ?? DEFAULT_COLUMNS).map((c) => c.name.toLowerCase());
    for (const row of rowsFor({ context, gvr, namespaces: only ? [...only] : undefined })) {
      if (!row.namespace) continue;
      if (resource === "pods") pods++;
      else workloads++;
      const created = row.created ? Date.parse(row.created) : NaN;
      const ageSec = Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 1000)) : null;
      const get = (c: string) => {
        const i = names.indexOf(c);
        const v = i >= 0 ? row.cells[i] : undefined;
        return v === undefined || v === null ? undefined : String(v);
      };
      const s = deriveStatus({ resource, get, deleting: !!row.deleting, ageSec });
      if (!isFault(s)) continue;
      const h = at(row.namespace);
      const error = s!.state === "error";
      if (resource === "pods") {
        if (error) h.podsFailing++;
        else h.podsWarn++;
      } else {
        let w = h.workloads.find((x) => x.kind === resource);
        if (!w) h.workloads.push((w = { kind: resource, down: 0, degraded: 0 }));
        if (error) w.down++;
        else w.degraded++;
      }
    }
  }
  const namespaces = [...by.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
  return { context, state: "live", namespaces, pods, workloads };
}

const sameGvr = (a: Gvr, b: Gvr) => a.group === b.group && a.resource === b.resource;
const kindOf = (gvr: Gvr) => RESOURCES.find((r) => sameGvr(r.gvr, gvr))?.kind ?? "Unknown";

function yamlFor(ref: ObjRef): string {
  const apiVersion = ref.gvr.group ? `${ref.gvr.group}/${ref.gvr.version}` : ref.gvr.version;
  const tracking = Object.entries(trackingAnnotation(ref)).map(([k, v]) => `\n    ${k}: ${v}`).join("");
  return `apiVersion: ${apiVersion}
kind: ${kindOf(ref.gvr)}
metadata:
  name: ${ref.name}${ref.namespace ? `\n  namespace: ${ref.namespace}` : ""}
  labels:
    app: ${ref.name.split("-")[0]}
  annotations:
    kns.dev/mock: "true"${tracking}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${ref.name.split("-")[0]}
  template:
    spec:
      containers:
        - name: main
          image: ghcr.io/example/${ref.name.split("-")[0]}:1.4.2
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 256Mi }
status:
  phase: Running
`;
}

/** Settings the mock starts with: `staging` is protected, so tier-2 and read-only paths are reachable (§2.11). */
const SEEDED: Record<string, Json> = { settings: { schema: 1, data: { contexts: MOCK_CONTEXT_FLAGS } } };

installKnsMock();

/** when the mock's SSO token expires (0: never signed in) */
let mockSsoUntil = 0;

export const mockBackend: Backend = {
  listContexts: () => delay({ contexts: CONTEXTS, current: "default", files: ["~/.kube/config"] }),
  connect: (context) =>
    delay({ context, cluster: CONTEXTS.find((c) => c.name === context)?.cluster ?? context, user: "admin", server: "https://127.0.0.1:6443", serverVersion: "v1.35.10+k3s1", hasMetrics: true }),
  awsSsoLogin: () => delay(undefined, 1500).then(() => void (mockSsoUntil = Date.now() + 60 * 60_000)),
  awsSsoStatus: (contexts) =>
    delay(
      Object.fromEntries(
        CONTEXTS.filter((c) => c.awsProfile && contexts.includes(c.name)).map((c) => [
          c.name,
          mockSsoUntil === 0 ? { state: "unknown" as const } : { state: mockSsoUntil > Date.now() ? ("valid" as const) : ("expired" as const), expiresAt: new Date(mockSsoUntil).toISOString() },
        ]),
      ),
    ),
  // staging is a team member's view of a workload cluster: Argo CD runs elsewhere, so its kinds are not served
  discover: (context) => delay(context === NO_ARGO_CONTEXT || context === TEAM_CONTEXT.name ? RESOURCES.filter((r) => r.gvr.group !== "argoproj.io") : RESOURCES),

  subscribeTable: (query, onEvent) => {
    let alive = true;
    onEvent({ type: "state", state: "syncing" });
    const namespaced = RESOURCES.find((x) => x.gvr.resource === query.gvr.resource && x.gvr.group === query.gvr.group)?.namespaced ?? true;
    if (mockForbidden(query, namespaced)) {
      const where = query.namespace ? `in the namespace "${query.namespace}"` : "at the cluster scope";
      const t = setTimeout(() => onEvent({ type: "state", state: "forbidden", message: `${query.gvr.resource} is forbidden: User "team-dev" cannot list resource "${query.gvr.resource}" ${where}` }), 80);
      return () => clearTimeout(t);
    }
    if (query.context === TEAM_CONTEXT.name && query.namespaces?.length) {
      query = { ...query, namespaces: query.namespaces.filter((n) => TEAM_NAMESPACES.includes(n)) };
    }
    const columns = COLUMNS[query.gvr.resource] ?? DEFAULT_COLUMNS;
    const start = setTimeout(() => {
      if (!alive) return;
      onEvent({ type: "snapshot", columns, rows: rowsFor(query) });
      onEvent({ type: "state", state: "live" });
    }, 80);
    // churn: mutate, add or delete a row now and then
    const churn = setInterval(() => {
      if (!alive) return;
      const rows = rowsFor(query);
      if (!rows.length) return;
      const r = rnd();
      const target = pick(rows);
      if (query.gvr.resource === "pods" && r < 0.6) {
        const cells = [...target.cells];
        cells[2] = pick(POD_STATUS);
        cells[1] = cells[2] === "Running" ? "1/1" : "0/1";
        const next = { ...target, cells };
        const all = tables.get(`${query.context}/${query.gvr.group}/${query.gvr.resource}`)!;
        all[all.indexOf(target)] = next;
        onEvent({ type: "delta", upserts: [next], deletes: [] });
      } else if (query.gvr.resource === "pods" && r < 0.8) {
        const fresh = makeRow("pods", target.namespace, Math.floor(rnd() * 100));
        fresh.created = new Date().toISOString();
        tables.get(`${query.context}/${query.gvr.group}/${query.gvr.resource}`)!.push(fresh);
        if (matchesLabels(query.labelSelector, fresh.labels) && matchesFields(query.fieldSelector, fresh)) onEvent({ type: "delta", upserts: [fresh], deletes: [] });
      }
    }, 1500);
    return () => {
      alive = false;
      clearTimeout(start);
      clearInterval(churn);
    };
  },

  getYaml: (ref) => delay(yamlFor(ref)),
  getJson: (ref) => {
    // the table row of the same object, so owners and uid agree with what the table shows
    const row = tables.get(`${ref.context}/${ref.gvr.group}/${ref.gvr.resource}`)?.find((r) => r.name === ref.name && r.namespace === ref.namespace);
    const app = ref.name.split("-")[0];
    const owners = (row?.owners ?? []).map((o) => ({ apiVersion: o.apiVersion, kind: o.kind, name: o.name, uid: o.uid, controller: true }));
    if (ref.gvr.group === "argoproj.io" && ref.gvr.resource === "applications") return delay(mockApplication(ref, row?.created ?? ago(86_400_000)));
    const tracking = trackingAnnotation(ref);
    return delay({
      apiVersion: ref.gvr.group ? `${ref.gvr.group}/${ref.gvr.version}` : ref.gvr.version,
      kind: kindOf(ref.gvr),
      metadata: {
        name: ref.name, namespace: ref.namespace ?? null, uid: row?.uid ?? hex(12), creationTimestamp: row?.created ?? ago(86_400_000), labels: { app },
        ...(Object.keys(tracking).length ? { annotations: tracking } : {}),
        ...(owners.length ? { ownerReferences: owners } : {}),
      },
      spec: {
        ...(ref.gvr.resource === "services" ? { selector: { app } } : {}),
        replicas: 2,
        containers: [
          { name: "main", image: "ghcr.io/example/app:1.4.2", ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }] },
          { name: "sidecar", image: "ghcr.io/example/sidecar:0.3.0", ports: [{ name: "metrics", containerPort: 9090, protocol: "TCP" }] },
        ],
      },
      // pods: a status matching the table row (C1: crash card and :why read it)
      status: ref.gvr.resource === "pods" && !ref.gvr.group
        ? mockPodStatus(row ? String(row.cells[2]) : undefined, row ? String(row.cells[3]) : undefined)
        : { phase: "Running", conditions: [{ type: "Ready", status: "True", lastTransitionTime: ago(3_600_000), reason: "Ready", message: "" }] },
    });
  },
  // Rust masks Secret values (objects::mask_secret_values): the mock never had values to leak; it
  // shows the shape (`••• <digest>`, `password` differs between two Secrets, `username` does not)
  getJsonMasked: async (ref, salt) => {
    const obj = (await mockBackend.getJson(ref)) as { [k: string]: Json };
    if (ref.gvr.group !== "" || ref.gvr.resource !== "secrets") return obj;
    const digest = (s: string) => {
      let h = 2166136261;
      for (const c of `${salt}\u0000${s}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      return `••• ${h.toString(16).padStart(8, "0")}`;
    };
    const { spec: _spec, status: _status, ...rest } = obj;
    return { ...rest, type: "Opaque", data: { username: digest("admin"), password: digest(`pw-${ref.name}`) } };
  },
  listEvents: (q) =>
    delay(
      Array.from({ length: 6 }, (_, i): EventRow => ({
        type: i % 3 === 0 ? "Warning" : "Normal",
        reason: i % 3 === 0 ? "BackOff" : "Pulled",
        message: i % 3 === 0 ? "Back-off restarting failed container main" : "Container image already present on machine",
        count: i + 1,
        lastSeen: ago(i * 240_000),
        source: "kubelet",
        objectKind: q.ref ? kindOf(q.ref.gvr) : "Pod",
        objectName: q.ref?.name ?? `web-${hex(5)}`,
        namespace: q.ref?.namespace ?? q.namespace ?? "default",
      })),
    ),
  // stable across calls: the pods of the mock table whose app label is the workload's
  podsFor: (ref) => {
    const app = ref.name.replace(/-nightly$/, "").split("-")[0];
    const names =
      ref.gvr.resource === "pods"
        ? [ref.name]
        : rowsFor({ context: ref.context, gvr: { group: "", version: "v1", resource: "pods" }, namespace: ref.namespace, labelSelector: `app=${app}` }).map((r) => r.name);
    return delay(
      (names.length ? names : [`${app}-${rsHash(app)}-00000`]).map(
        (name): PodRef => ({ namespace: ref.namespace ?? "default", name, containers: ["main", "sidecar"], initContainers: ["init"], ephemeralContainers: [], phase: "Running", node: "node-7f3a9c21" }),
      ),
    );
  },

  applyYaml: (_c, yaml, opts) => delay({ yaml, warnings: opts?.dryRun ? ["dry run: nothing was persisted"] : [] }, 200),
  deleteObject: (ref) => {
    for (const [key, rows] of tables) {
      const i = rows.findIndex((r) => r.name === ref.name && r.namespace === ref.namespace && key.endsWith(`/${ref.gvr.resource}`));
      if (i >= 0) rows.splice(i, 1);
    }
    return delay(undefined, 150);
  },
  patchObject: () => delay(undefined, 120),
  scale: () => delay(undefined, 120),
  restart: (ref) => {
    mockRollout(ref);
    return delay(undefined, 120);
  },
  triggerCronJob: (ref) => delay(`${ref.name}-manual-${hex(5)}`, 120),
  decodeSecret: () => delay({ username: "admin", password: "s3cr3t-value", "tls.crt": null }),

  podMetrics: (_c, namespace) =>
    delay(
      [...tables.entries()]
        .filter(([k]) => k.endsWith("//pods"))
        .flatMap(([, rows]) => rows)
        .filter((r) => !namespace || r.namespace === namespace)
        .map((r) => ({ namespace: r.namespace ?? "", name: r.name, cpuMilli: Math.floor(rnd() * 400), memBytes: Math.floor(rnd() * 512) * 1048576 })),
    ),
  nodeMetrics: () => delay([{ name: "node-0", cpuMilli: 1840, memBytes: 9.2 * 2 ** 30, cpuAllocMilli: 8000, memAllocBytes: 16 * 2 ** 30 }]),

  exec: (query, onEvent): Promise<ExecSession> => {
    const send = (s: string) => onEvent({ type: "data", b64: btoa(s) });
    const prompt = `\r\n\u001b[32m${query.pod}\u001b[0m:/ # `;
    let line = "";
    setTimeout(() => send(`mock shell in ${query.namespace}/${query.pod}${prompt}`), 50);
    return delay({
      write: (data) => {
        for (const ch of data) {
          if (ch === "\r") {
            if (line.trim() === "exit") return onEvent({ type: "exit", code: 0 });
            send(`\r\n${line ? `sh: ${line.split(" ")[0]}: mock command` : ""}${prompt}`);
            line = "";
          } else if (ch === "\u007f") {
            if (line) {
              line = line.slice(0, -1);
              send("\b \b");
            }
          } else {
            line += ch;
            send(ch);
          }
        }
      },
      resize: () => {},
      close: () => {},
    });
  },

  canI: (q) => delay(q.context !== "staging" || ["get", "list", "watch"].includes(q.verb)),

  loadState: (key) => {
    try {
      const raw = localStorage.getItem(`kns:${key}`);
      return delay(raw ? (JSON.parse(raw) as Json) : (state.get(key) ?? SEEDED[key] ?? null), 0);
    } catch {
      return delay(state.get(key) ?? SEEDED[key] ?? null, 0);
    }
  },
  saveState: (key, value) => {
    state.set(key, value);
    try {
      localStorage.setItem(`kns:${key}`, JSON.stringify(value));
    } catch {
      /* private mode */
    }
    return delay(undefined, 0);
  },

  backgroundStatus: () => delay(mockBackground()),
  backgroundSet: (keepRunning, launchAtLogin) => {
    background.keepRunning = keepRunning;
    if (launchAtLogin !== undefined) background.launchAtLogin = launchAtLogin;
    return delay(mockBackground());
  },
  herdrStatus: () => delay(mockHerdr()),
  herdrInstall: () => {
    herdr.installed = true;
    const r: HerdrInstallReport = {
      done: ["kns listens for Herdr on 127.0.0.1:53124", "the kns mod is in ~/.config/herdr-app/mods/kns", "herdr-app check passed"],
      notes: [],
      tips: ["In Herdr's command palette: \"kns: panel beside this pane\" and \"kns: clusters in a new tab\"."],
      status: mockHerdr(),
    };
    return delay(r, 400);
  },
  herdrUninstall: () => {
    herdr.installed = false;
    return delay({ done: ["removed ~/.config/herdr-app/mods/kns", "turned the TCP endpoint off"], notes: [], tips: [], status: mockHerdr() } as HerdrInstallReport, 200);
  },

  ...fwdMock,
  ...devMock,
  ...diagMock,
  ...diffMock,
  ...logsMock,
  ...debugMock,
  ...packMock,
  ...agentsMock,
  ...eventsMock,
  ...updateMock,
  ...catalogMock,
  ...githubMock,
  ...trafficMock,
  ...routesMock,
  ...dbMock,

  // namespace health: a first `syncing`, then the counts every 3s when they changed (the real
  // backend sends at most one per second, only on change)
  subscribeNsHealth: (context, onSnapshot, namespaces) => {
    let last = "";
    if (context === TEAM_CONTEXT.name && !namespaces?.length) {
      const t = setTimeout(() => onSnapshot({ context, state: "forbidden", message: 'pods: pods is forbidden: User "team-dev" cannot list resource "pods" at the cluster scope', namespaces: [], pods: 0, workloads: 0 }), 200);
      return () => clearTimeout(t);
    }
    const only = context === TEAM_CONTEXT.name ? namespaces?.filter((n) => TEAM_NAMESPACES.includes(n)) : namespaces;
    const send = () => {
      const s = mockNsHealth(context, only);
      const key = JSON.stringify(s);
      if (key === last) return;
      last = key;
      onSnapshot(s);
    };
    onSnapshot({ context, state: "syncing", namespaces: [], pods: 0, workloads: 0 });
    const first = setTimeout(send, 300);
    const t = setInterval(send, 3000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  },
};
