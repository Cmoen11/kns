// kubectl-describe-like text, generated client-side from the object JSON and its events
// (docs/ux.md §13.1). Pure: `now` is passed in so ages are deterministic.
import { stringify } from "yaml";
import type { EventRow, Json } from "../../ipc/types";
import { argoOwner, argoOwnerText } from "../../actions/ops/argo";
import { isObj, type JsonObject } from "./yaml-helpers";

const obj = (v: Json | undefined): JsonObject => (isObj(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;
const has = (v: Json | undefined): boolean => v !== undefined && v !== null && v !== "";

/** Compact duration like kubectl: 45s, 12m, 3h4m, 2d5h, 120d. */
export function age(ts: string | undefined, now: number): string {
  if (!ts) return "-";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "-";
  let s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  s = h % 24;
  return s && d < 10 ? `${d}d${s}h` : `${d}d`;
}

const MAX_VALUE = 120;
const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ");
  return one.length > MAX_VALUE ? `${one.slice(0, MAX_VALUE - 1)}…` : one;
};

class Out {
  readonly lines: string[] = [];
  /** `Key:   value`, values aligned at `width`; extra values continue on following lines */
  kv(key: string, value: string | string[], indent = 0, width = 16): void {
    const values = Array.isArray(value) ? (value.length ? value : ["<none>"]) : [value];
    const pad = " ".repeat(indent);
    const label = `${key}:`;
    this.lines.push(`${pad}${label.length >= width ? `${label} ` : label.padEnd(width)}${values[0]}`.trimEnd());
    for (const v of values.slice(1)) this.lines.push(`${pad}${" ".repeat(Math.max(width, label.length + 1))}${v}`);
  }
  head(title: string): void {
    if (this.lines.length) this.lines.push("");
    this.lines.push(`${title}:`);
  }
  line(text: string, indent = 0): void {
    this.lines.push(" ".repeat(indent) + text);
  }
  table(header: string[], rows: string[][], indent = 2): void {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]))).join("  ").trimEnd();
    this.line(fmt(header), indent);
    for (const r of rows) this.line(fmt(r), indent);
  }
  yaml(value: Json, indent = 2): void {
    const text = stringify(value, { lineWidth: 0 }).replace(/\n$/, "");
    for (const l of text.split("\n")) this.line(l, indent);
  }
}

// kubectl omits it too; on a Secret it would carry the base64 data
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const pairs = (m: Json | undefined): string[] =>
  Object.entries(obj(m)).filter(([k]) => k !== LAST_APPLIED).map(([k, v]) => clip(`${k}=${str(v)}`));

function selectorText(sel: Json | undefined): string {
  const s = obj(sel);
  const labels = isObj(s.matchLabels) || Array.isArray(s.matchExpressions) ? obj(s.matchLabels) : s;
  const parts = Object.entries(labels).map(([k, v]) => `${k}=${str(v)}`);
  for (const e of arr(s.matchExpressions)) {
    const x = obj(e);
    parts.push(`${str(x.key)} ${str(x.operator)} [${arr(x.values).map((v) => str(v)).join(",")}]`.trim());
  }
  return parts.length ? parts.join(",") : "<none>";
}

/** `Flux Kustomization flux-system/apps` or `Argo CD Application shop/web`, from what the controller stamped on the object. */
function managedBy(root: JsonObject): string | null {
  const labels = obj(obj(root.metadata).labels);
  for (const [prefix, kind] of [["kustomize.toolkit.fluxcd.io", "Kustomization"], ["helm.toolkit.fluxcd.io", "HelmRelease"]] as const) {
    const name = str(labels[`${prefix}/name`]);
    if (name) return `Flux ${kind} ${has(labels[`${prefix}/namespace`]) ? `${str(labels[`${prefix}/namespace`])}/` : ""}${name}`;
  }
  const argo = argoOwner(root);
  return argo ? `Argo CD ${argoOwnerText(argo)}` : null;
}

/** An Argo CD Application: what it deploys from where to where, and how it stands. */
function argoApp(o: Out, root: JsonObject): void {
  const spec = obj(root.spec);
  const status = obj(root.status);
  const sources = [obj(spec.source), ...arr(spec.sources).map(obj)].filter((s) => has(s.repoURL));
  const st = [str(obj(status.sync).status), str(obj(status.health).status)].filter(Boolean).join(" · ");
  if (st) o.kv("Status", st);
  if (has(obj(status.sync).revision)) o.kv("Revision", str(obj(status.sync).revision));
  if (has(spec.project)) o.kv("Project", str(spec.project));
  for (const s of sources) {
    const where = [str(s.path), str(s.chart) && `chart ${str(s.chart)}`].filter(Boolean).join(" ");
    o.kv("Source", clip(`${str(s.repoURL)}${where ? ` ${where}` : ""}${has(s.targetRevision) ? ` @ ${str(s.targetRevision)}` : ""}`));
  }
  const dest = obj(spec.destination);
  if (has(dest.server) || has(dest.name)) o.kv("Destination", `${str(dest.name) || str(dest.server)}${has(dest.namespace) ? ` / ${str(dest.namespace)}` : ""}`);
  const automated = obj(obj(spec.syncPolicy).automated);
  o.kv("Auto-sync", isObj(obj(spec.syncPolicy).automated) ? [automated.selfHeal === true ? "self-heal" : "", automated.prune === true ? "prune" : ""].filter(Boolean).join(", ") || "on" : "off");
  const op = obj(status.operationState);
  if (has(op.phase)) o.kv("Last Sync", `${str(op.phase)}${has(op.message) ? `: ${clip(str(op.message))}` : ""}`);
  const rows = arr(status.resources)
    .map(obj)
    .filter((r) => str(r.status) === "OutOfSync" || !["", "Healthy"].includes(str(obj(r.health).status)))
    .map((r) => [str(r.kind), has(r.namespace) ? `${str(r.namespace)}/${str(r.name)}` : str(r.name), str(r.status), str(obj(r.health).status) || "-", clip(str(obj(r.health).message))]);
  if (rows.length) {
    o.head("Resources Not Synced Or Healthy");
    o.table(["KIND", "NAME", "SYNC", "HEALTH", "MESSAGE"], rows);
  }
}

function metadata(o: Out, root: JsonObject, now: number): void {
  const meta = obj(root.metadata);
  o.kv("Name", str(meta.name));
  if (has(meta.namespace)) o.kv("Namespace", str(meta.namespace));
  o.kv("Kind", `${str(root.kind, "?")}${has(root.apiVersion) ? ` (${str(root.apiVersion)})` : ""}`);
  if (has(meta.creationTimestamp)) o.kv("Created", `${str(meta.creationTimestamp)} (${age(str(meta.creationTimestamp), now)} ago)`);
  if (has(meta.deletionTimestamp)) o.kv("Terminating", `since ${str(meta.deletionTimestamp)} (${age(str(meta.deletionTimestamp), now)})`);
  o.kv("Labels", pairs(meta.labels));
  o.kv("Annotations", pairs(meta.annotations));
  const owners = arr(meta.ownerReferences).map((r) => `${str(obj(r).kind)}/${str(obj(r).name)}`);
  if (owners.length) o.kv("Controlled By", owners);
  const gitops = managedBy(root);
  if (gitops) o.kv("Managed By", gitops);
  if (arr(meta.finalizers).length) o.kv("Finalizers", arr(meta.finalizers).map((f) => str(f)));
}

function conditions(o: Out, list: Json | undefined, now: number): void {
  const rows = arr(list).map((c) => {
    const x = obj(c);
    return [str(x.type), str(x.status), age(str(x.lastTransitionTime) || undefined, now), str(x.reason, "-") || "-", clip(str(x.message))];
  });
  if (!rows.length) return;
  // Ready first: it is the one that answers "is it ok"
  rows.sort((a, b) => Number(b[0] === "Ready") - Number(a[0] === "Ready"));
  o.head("Conditions");
  o.table(["TYPE", "STATUS", "AGE", "REASON", "MESSAGE"], rows);
}

function resources(c: JsonObject): string[] {
  const out: string[] = [];
  const r = obj(c.resources);
  for (const k of ["requests", "limits"] as const) {
    const e = Object.entries(obj(r[k]));
    if (e.length) out.push(`${k}: ${e.map(([n, v]) => `${n}=${str(v)}`).join(", ")}`);
  }
  return out;
}

function stateText(state: Json | undefined, now: number): string {
  const s = obj(state);
  if (isObj(s.running)) return `Running (started ${age(str(s.running.startedAt) || undefined, now)} ago)`;
  if (isObj(s.waiting)) return `Waiting (${str(s.waiting.reason, "unknown")})${has(s.waiting.message) ? `: ${clip(str(s.waiting.message))}` : ""}`;
  if (isObj(s.terminated)) {
    const t = s.terminated;
    return `Terminated (${str(t.reason, "unknown")}, exit code ${str(t.exitCode, "?")}${has(t.finishedAt) ? `, ${age(str(t.finishedAt), now)} ago` : ""})`;
  }
  return "";
}

function containerSpec(o: Out, c: JsonObject, indent: number): void {
  o.kv("Image", str(c.image), indent);
  const ports = arr(c.ports).map((p) => `${str(obj(p).containerPort)}/${str(obj(p).protocol, "TCP")}${has(obj(p).name) ? ` (${str(obj(p).name)})` : ""}`);
  if (ports.length) o.kv("Ports", ports.join(", "), indent);
  if (arr(c.command).length) o.kv("Command", clip(arr(c.command).map((x) => str(x)).join(" ")), indent);
  if (arr(c.args).length) o.kv("Args", clip(arr(c.args).map((x) => str(x)).join(" ")), indent);
  const res = resources(c);
  if (res.length) o.kv("Resources", res, indent);
  const env = arr(c.env).length + arr(c.envFrom).length;
  if (env) o.kv("Environment", `${arr(c.env).length} variables${arr(c.envFrom).length ? `, ${arr(c.envFrom).length} sources` : ""}`, indent);
  const mounts = arr(c.volumeMounts).map((m) => `${str(obj(m).mountPath)} from ${str(obj(m).name)}${obj(m).readOnly === true ? " (ro)" : ""}`);
  if (mounts.length) o.kv("Mounts", mounts, indent);
}

function containers(o: Out, title: string, specs: Json[], statuses: Json[], now: number): void {
  if (!specs.length) return;
  o.head(title);
  for (const spec of specs) {
    const c = obj(spec);
    const st = obj(statuses.find((s) => obj(s).name === c.name));
    o.line(`${str(c.name)}:`, 2);
    if (Object.keys(st).length) {
      const state = stateText(st.state, now);
      if (state) o.kv("State", state, 4);
      const last = stateText(st.lastState, now);
      if (last) o.kv("Last State", last, 4);
      o.kv("Ready", str(st.ready, "false"), 4);
      o.kv("Restarts", str(st.restartCount, "0"), 4);
    }
    containerSpec(o, c, 4);
  }
}

function volumes(o: Out, list: Json[]): void {
  if (!list.length) return;
  o.head("Volumes");
  for (const v of list) {
    const x = obj(v);
    const type = Object.keys(x).find((k) => k !== "name") ?? "?";
    const src = obj(x[type]);
    const ref = str(src.claimName) || str(src.secretName) || str(src.name) || str(src.path);
    o.kv(str(x.name), `${type}${ref ? ` (${ref})` : ""}`, 2, 24);
  }
}

function pod(o: Out, root: JsonObject, now: number): void {
  const spec = obj(root.spec);
  const status = obj(root.status);
  o.kv("Status", str(status.phase, "Unknown") + (has(status.reason) ? ` (${str(status.reason)})` : ""));
  if (has(spec.nodeName)) o.kv("Node", str(spec.nodeName) + (has(status.hostIP) ? ` (${str(status.hostIP)})` : ""));
  if (has(status.podIP)) o.kv("IP", str(status.podIP));
  if (has(spec.serviceAccountName)) o.kv("ServiceAccount", str(spec.serviceAccountName));
  if (has(status.qosClass)) o.kv("QoS Class", str(status.qosClass));
  if (has(spec.priorityClassName)) o.kv("Priority Class", str(spec.priorityClassName));
  const restarts = arr(status.containerStatuses).reduce((n: number, s) => n + Number(obj(s).restartCount ?? 0), 0);
  o.kv("Restarts", String(restarts));
  containers(o, "Init Containers", arr(spec.initContainers), arr(status.initContainerStatuses), now);
  containers(o, "Containers", arr(spec.containers), arr(status.containerStatuses), now);
  conditions(o, status.conditions, now);
  volumes(o, arr(spec.volumes));
  const tol = arr(spec.tolerations).map((t) => {
    const x = obj(t);
    return `${str(x.key, "*")}${has(x.effect) ? `:${str(x.effect)}` : ""}${has(x.operator) ? ` op=${str(x.operator)}` : ""}${has(x.tolerationSeconds) ? ` for ${str(x.tolerationSeconds)}s` : ""}`;
  });
  if (tol.length) {
    o.line("");
    o.kv("Tolerations", tol);
  }
}

function podTemplate(o: Out, template: Json | undefined): void {
  const t = obj(template);
  const spec = obj(t.spec);
  if (!arr(spec.containers).length) return;
  o.head("Pod Template");
  const labels = pairs(obj(t.metadata).labels);
  if (labels.length) o.kv("Labels", labels, 2);
  if (has(spec.serviceAccountName)) o.kv("ServiceAccount", str(spec.serviceAccountName), 2);
  for (const [title, list] of [["Init Containers", arr(spec.initContainers)], ["Containers", arr(spec.containers)]] as const) {
    if (!list.length) continue;
    o.line(`${title}:`, 2);
    for (const c of list) {
      o.line(`${str(obj(c).name)}:`, 4);
      containerSpec(o, obj(c), 6);
    }
  }
}

function workload(o: Out, root: JsonObject, now: number): void {
  const spec = obj(root.spec);
  const status = obj(root.status);
  const kind = str(root.kind);
  if (kind === "CronJob") {
    o.kv("Schedule", str(spec.schedule) + (has(spec.timeZone) ? ` (${str(spec.timeZone)})` : ""));
    o.kv("Suspend", str(spec.suspend, "false"));
    o.kv("Concurrency", str(spec.concurrencyPolicy, "Allow"));
    o.kv("Last Schedule", has(status.lastScheduleTime) ? `${str(status.lastScheduleTime)} (${age(str(status.lastScheduleTime), now)} ago)` : "<never>");
    o.kv("Active Jobs", String(arr(status.active).length));
    podTemplate(o, obj(obj(spec.jobTemplate).spec).template);
    return;
  }
  if (kind === "Job") {
    o.kv("Completions", `${str(status.succeeded, "0")}/${str(spec.completions, "1")}`);
    o.kv("Parallelism", str(spec.parallelism, "1"));
    o.kv("Pods", `${str(status.active, "0")} active, ${str(status.succeeded, "0")} succeeded, ${str(status.failed, "0")} failed`);
    if (has(status.startTime)) o.kv("Started", `${age(str(status.startTime), now)} ago`);
    if (has(status.completionTime)) o.kv("Completed", `${age(str(status.completionTime), now)} ago`);
  } else if (kind === "DaemonSet") {
    o.kv(
      "Pods",
      `${str(status.desiredNumberScheduled, "0")} desired, ${str(status.currentNumberScheduled, "0")} current, ${str(status.numberReady, "0")} ready, ${str(status.updatedNumberScheduled, "0")} updated, ${str(status.numberAvailable, "0")} available`,
    );
  } else {
    o.kv(
      "Replicas",
      `${str(spec.replicas, "1")} desired, ${str(status.updatedReplicas ?? status.replicas, "0")} updated, ${str(status.readyReplicas, "0")} ready, ${str(status.availableReplicas, "0")} available`,
    );
  }
  const strategy = obj(spec.strategy ?? spec.updateStrategy);
  if (has(strategy.type)) {
    const ru = obj(strategy.rollingUpdate);
    const detail = Object.entries(ru).map(([k, v]) => `${k}=${str(v)}`).join(", ");
    o.kv("Strategy", str(strategy.type) + (detail ? ` (${detail})` : ""));
  }
  if (has(spec.selector)) o.kv("Selector", selectorText(spec.selector));
  if (has(spec.serviceName)) o.kv("Service Name", str(spec.serviceName));
  podTemplate(o, spec.template);
  conditions(o, status.conditions, now);
}

function service(o: Out, root: JsonObject): void {
  const spec = obj(root.spec);
  o.kv("Type", str(spec.type, "ClusterIP"));
  o.kv("Cluster IP", str(spec.clusterIP, "<none>"));
  if (arr(spec.externalIPs).length) o.kv("External IPs", arr(spec.externalIPs).map((x) => str(x)).join(", "));
  const lb = arr(obj(obj(root.status).loadBalancer).ingress).map((i) => str(obj(i).ip) || str(obj(i).hostname));
  if (lb.length) o.kv("Load Balancer", lb.join(", "));
  if (has(spec.externalName)) o.kv("External Name", str(spec.externalName));
  o.kv("Selector", has(spec.selector) ? selectorText(spec.selector) : "<none>");
  if (has(spec.sessionAffinity)) o.kv("Affinity", str(spec.sessionAffinity));
  const ports = arr(spec.ports).map((p) => {
    const x = obj(p);
    return [str(x.name, "-") || "-", `${str(x.port)}/${str(x.protocol, "TCP")}`, str(x.targetPort, "-"), str(x.nodePort, "-")];
  });
  if (ports.length) {
    o.head("Ports");
    o.table(["NAME", "PORT", "TARGET", "NODEPORT"], ports);
  }
}

function node(o: Out, root: JsonObject, now: number): void {
  const spec = obj(root.spec);
  const status = obj(root.status);
  const labels = obj(obj(root.metadata).labels);
  const roles = Object.keys(labels).filter((k) => k.startsWith("node-role.kubernetes.io/")).map((k) => k.slice("node-role.kubernetes.io/".length));
  o.kv("Roles", roles.length ? roles.join(", ") : "<none>");
  o.kv("Schedulable", spec.unschedulable === true ? "false (cordoned)" : "true");
  const taints = arr(spec.taints).map((t) => `${str(obj(t).key)}${has(obj(t).value) ? `=${str(obj(t).value)}` : ""}:${str(obj(t).effect)}`);
  o.kv("Taints", taints);
  const addresses = arr(status.addresses).map((a) => `${str(obj(a).type)}: ${str(obj(a).address)}`);
  if (addresses.length) o.kv("Addresses", addresses);
  const cap = obj(status.capacity);
  const alloc = obj(status.allocatable);
  const names = [...new Set([...Object.keys(cap), ...Object.keys(alloc)])];
  if (names.length) {
    o.head("Resources");
    o.table(["RESOURCE", "CAPACITY", "ALLOCATABLE"], names.map((n) => [n, str(cap[n], "-"), str(alloc[n], "-")]));
  }
  const info = obj(status.nodeInfo);
  if (Object.keys(info).length) {
    o.head("System Info");
    for (const [label, key] of [["Kubelet", "kubeletVersion"], ["OS Image", "osImage"], ["Kernel", "kernelVersion"], ["Runtime", "containerRuntimeVersion"], ["Architecture", "architecture"]] as const) {
      if (has(info[key])) o.kv(label, str(info[key]), 2);
    }
  }
  conditions(o, status.conditions, now);
}

function dataKeys(o: Out, root: JsonObject, secret: boolean): void {
  if (secret) o.kv("Type", str(root.type, "Opaque"));
  const rows: string[][] = [];
  for (const [k, v] of Object.entries(obj(root.data))) {
    const len = typeof v === "string" ? (secret ? Math.floor((v.replace(/=+$/, "").length * 3) / 4) : new TextEncoder().encode(v).length) : 0;
    rows.push([k, `${len} bytes`]);
  }
  for (const k of Object.keys(obj(root.binaryData))) rows.push([k, "binary"]);
  o.head("Data");
  if (rows.length) o.table(["KEY", "SIZE"], rows);
  else o.line("<none>", 2);
}

/** CRDs and every kind without its own section: Flux summary, conditions, then spec and status. */
function generic(o: Out, root: JsonObject, now: number): void {
  if (str(root.apiVersion).startsWith("argoproj.io/") && str(root.kind) === "Application") argoApp(o, root);
  const spec = obj(root.spec);
  const status = obj(root.status);
  const ready = obj(arr(status.conditions).find((c) => obj(c).type === "Ready"));
  if (Object.keys(ready).length) {
    o.kv("Ready", `${str(ready.status)}${has(ready.reason) ? ` (${str(ready.reason)})` : ""}${has(ready.message) ? `: ${clip(str(ready.message))}` : ""}`);
  }
  if (typeof spec.suspend === "boolean") o.kv("Suspended", String(spec.suspend));
  if (has(spec.interval)) o.kv("Interval", str(spec.interval));
  const src = obj(spec.sourceRef ?? obj(obj(spec.chart).spec).sourceRef);
  if (has(src.name)) o.kv("Source", `${str(src.kind)}/${has(src.namespace) ? `${str(src.namespace)}/` : ""}${str(src.name)}`);
  const revision = str(status.lastAppliedRevision) || str(obj(status.artifact).revision) || str(status.lastAttemptedRevision);
  if (revision) o.kv("Revision", revision);
  if (has(status.phase)) o.kv("Phase", str(status.phase));
  conditions(o, status.conditions, now);
  if (Object.keys(spec).length) {
    o.head("Spec");
    o.yaml(spec);
  }
  const { conditions: _c, ...rest } = status;
  if (Object.keys(rest).length) {
    o.head("Status");
    o.yaml(rest);
  }
  for (const key of Object.keys(root)) {
    if (["apiVersion", "kind", "metadata", "spec", "status"].includes(key)) continue;
    o.head(key[0].toUpperCase() + key.slice(1));
    const v = root[key];
    if (isObj(v) || Array.isArray(v)) o.yaml(v);
    else o.line(clip(str(v)), 2);
  }
}

function events(o: Out, list: readonly EventRow[], now: number): void {
  o.head("Events");
  if (!list.length) {
    o.line("<none>", 2);
    return;
  }
  const sorted = [...list].sort((a, b) => (Date.parse(b.lastSeen ?? "") || 0) - (Date.parse(a.lastSeen ?? "") || 0));
  o.table(
    ["TYPE", "REASON", "AGE", "FROM", "COUNT", "MESSAGE"],
    sorted.map((e) => [e.type, e.reason, age(e.lastSeen, now), e.source || "-", e.count > 1 ? `x${e.count}` : "", e.message.replace(/\s+/g, " ")]),
  );
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);

/** The describe document of one object. `events === null` means they could not be listed. */
export function describe(object: Json, eventRows: readonly EventRow[] | null, now: number): string {
  const root = obj(object);
  const o = new Out();
  metadata(o, root, now);
  const kind = str(root.kind);
  const core = !str(root.apiVersion).includes(".") || /^(apps|batch)\//.test(str(root.apiVersion));
  if (core && kind === "Pod") pod(o, root, now);
  else if (core && WORKLOADS.has(kind)) workload(o, root, now);
  else if (core && kind === "Service") service(o, root);
  else if (core && kind === "Node") node(o, root, now);
  else if (core && (kind === "Secret" || kind === "ConfigMap")) dataKeys(o, root, kind === "Secret");
  else generic(o, root, now);
  if (eventRows === null) {
    o.head("Events");
    o.line("<could not list events>", 2);
  } else events(o, eventRows, now);
  return o.lines.join("\n") + "\n";
}
