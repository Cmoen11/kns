// Mock of FwdBackend (contract/fwd.ts). Owner B-fwd.
// Services `kafka`, `schema-registry`, `kafka-ui` (namespace kafka) and `postgres` (payments) are
// known in detail. A mock rollout (`restart`) of a workload puts its forwards in `waiting` for 2 s,
// then they resolve to a new pod.
import type { Forward, ForwardQuery, ForwardTarget, FwdBackend, NameProxyStatus, ObjRef, ServiceInfo } from "../types";
import { emitMock } from "./events";
import { delay, fail, mockForwards, mockId } from "./shared";

/** Services the mock knows in detail; anything else is a plain http service. */
const SERVICES: Record<string, Omit<ServiceInfo, "ref">> = {
  "kafka/kafka": {
    type: "ClusterIP",
    ports: [
      { name: "internal", port: 9092, targetPort: 9092, protocol: "TCP" },
      { name: "local", port: 9094, targetPort: "local", protocol: "TCP" },
    ],
    selector: { app: "kafka" },
    endpoints: { ready: 1, notReady: 0, pods: ["kafka-0"] },
    kind: "kafka",
    kafkaListeners: [
      { name: "INTERNAL", advertised: "kafka.kafka.svc.cluster.local:9092", protocol: "PLAINTEXT" },
      { name: "LOCAL", advertised: "localhost:9094", protocol: "PLAINTEXT" },
    ],
  },
  "kafka/schema-registry": {
    type: "ClusterIP",
    ports: [{ name: "http", port: 8081, targetPort: 8081, protocol: "TCP" }],
    selector: { app: "schema-registry" },
    endpoints: { ready: 1, notReady: 0, pods: ["schema-registry-7f9c-abcde"] },
    kind: "schemaRegistry",
  },
  "kafka/kafka-ui": {
    type: "ClusterIP",
    ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    selector: { app: "kafka-ui" },
    endpoints: { ready: 1, notReady: 0, pods: ["kafka-ui-5d8b-fghij"] },
    kind: "http",
    // the pod carries `k9scli.io/port-forwards: kafka-ui::18080:8080` (B2): the F dialog preselects it
    hints: [{ container: "kafka-ui", remotePort: 80, localPort: 18080, auto: false }],
  },
  "payments/postgres": {
    type: "ClusterIP",
    ports: [{ name: "postgres", port: 5432, targetPort: 5432, protocol: "TCP" }],
    selector: { app: "postgres" },
    endpoints: { ready: 1, notReady: 0, pods: ["postgres-0"] },
    kind: "postgres",
  },
};

export function mockServiceInfo(ref: ObjRef): ServiceInfo {
  const known = SERVICES[`${ref.namespace}/${ref.name}`];
  if (known) return { ref, ...known };
  return {
    ref,
    type: "ClusterIP",
    ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }],
    selector: { app: ref.name },
    endpoints: { ready: 1, notReady: 0, pods: [`${ref.name}-6d4f9-abcde`] },
    kind: "http",
  };
}

const SERVICES_GVR = { group: "", version: "v1", resource: "services" };

/** A named object the base mock adds to its tables (cells after the name; absent = generated). */
export interface MockObject {
  namespace: string;
  name: string;
  cells?: (string | number)[];
}
const extraObjects: Record<string, MockObject[]> = {
  services: Object.entries(SERVICES).map(([key, s]) => {
    const [namespace, name] = key.split("/");
    return { namespace, name, cells: [s.type, "10.43.9.9", "<none>", s.ports.map((p) => `${p.port}/${p.protocol}`).join(","), "12d"] };
  }),
};

/** Feature mocks add the objects their flows need (B-dev: deploy/orders). */
export function registerMockObjects(resource: string, objects: MockObject[]): void {
  extraObjects[resource] = [...(extraObjects[resource] ?? []), ...objects];
}

/** Read by the base mock's table generator. */
export const mockExtraObjects = (resource: string): readonly MockObject[] => extraObjects[resource] ?? [];

/** Workloads whose pods are being replaced: name -> generation (the pod suffix changes per rollout). */
const rollouts = new Map<string, { until: number; gen: number }>();
const rolloutKey = (namespace: string, name: string) => `${namespace}/${name}`;

/** The pod a target resolves to now, or null while a rollout replaces it. */
function mockResolve(context: string, target: ForwardTarget): string | null {
  if (target.kind === "pod") return target.name;
  // a Service routes to the workload of the same name in the mock
  const r = rollouts.get(rolloutKey(target.namespace, target.name));
  if (r && Date.now() < r.until) return null;
  if (target.kind === "service") {
    const pod = mockServiceInfo({ context, gvr: SERVICES_GVR, namespace: target.namespace, name: target.name }).endpoints.pods[0];
    return pod && r ? `${pod.replace(/-[a-z0-9]{5}$/, "")}-r${r.gen}` : (pod ?? null);
  }
  return `${target.name}-6d4f9-${r ? `r${r.gen}` : "abcde"}`;
}

/** The port a remote port (number or name) means on the target. */
function mockPort(context: string, target: ForwardTarget, remote: number | string): number | undefined {
  if (typeof remote === "number") {
    if (target.kind !== "service") return remote;
    const p = mockServiceInfo({ context, gvr: SERVICES_GVR, namespace: target.namespace, name: target.name }).ports.find((x) => x.port === remote);
    return p ? (typeof p.targetPort === "number" ? p.targetPort : p.port) : remote;
  }
  if (target.kind === "service") {
    const p = mockServiceInfo({ context, gvr: SERVICES_GVR, namespace: target.namespace, name: target.name }).ports.find((x) => x.name === remote);
    return p ? (typeof p.targetPort === "number" ? p.targetPort : p.port) : undefined;
  }
  return remote === "http" ? 8080 : undefined;
}

/** Called by the base mock's `restart`: forwards to that workload wait 2 s, then move to a new pod. */
export function mockRollout(ref: ObjRef): void {
  if (!ref.namespace) return;
  const key = rolloutKey(ref.namespace, ref.name);
  const gen = (rollouts.get(key)?.gen ?? 0) + 1;
  rollouts.set(key, { until: Date.now() + 2000, gen });
  emitMock({ type: "forwards" });
  setTimeout(() => emitMock({ type: "forwards" }), 2100);
}

/** Refreshes resolution and the idle clock of a listed forward. */
function snapshot(f: Forward): Forward {
  const pod = mockResolve(f.context, f.target);
  const next: Forward = {
    ...f,
    resolvedPod: pod ?? undefined,
    pod: pod ?? `${f.target.kind}/${f.target.name}`,
    status: pod === null ? "waiting" : f.status === "waiting" ? "active" : f.status,
    message: pod === null ? "no ready pod (rollout in progress)" : f.status === "waiting" ? undefined : f.message,
  };
  mockForwards.set(f.id, next);
  return next;
}

/** Starts a mock forward (also used by the dev-set mock). */
export function mockStartForward(q: ForwardQuery, owner: Forward["owner"] = { by: "user" }, requestedBy?: string): Forward {
  const free = 30000 + Math.floor(Math.random() * 1000);
  const busy = new Set([...mockForwards.values()].map((f) => f.localPort));
  let localPort = q.localPort || free;
  if (busy.has(localPort)) {
    if (q.pin) throw { code: 0, reason: "AddrInUse", message: `local port ${localPort} is not free; it is pinned` };
    while (busy.has(localPort)) localPort++;
  }
  const address = q.address?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(address) && !/^127\.\d+\.\d+\.\d+$/.test(address)) {
    throw { code: 0, reason: "Invalid", message: `${address} is not a loopback address; forwards bind to 127.0.0.1 or ::1 only` };
  }
  const pod = mockResolve(q.context, q.target);
  const resolvedPort = mockPort(q.context, q.target, q.remotePort);
  if (resolvedPort === undefined) throw { code: 0, reason: "Invalid", message: `the target has no port named "${q.remotePort}"` };
  const agentIdle = owner.by === "agent" && owner.idleStopMinutes > 0;
  const f: Forward = {
    id: mockId("f"),
    context: q.context,
    target: q.target,
    pod: pod ?? `${q.target.kind}/${q.target.name}`,
    namespace: q.target.namespace,
    resolvedPod: pod ?? undefined,
    remotePort: q.remotePort,
    resolvedPort,
    localPort,
    address,
    connections: 0,
    status: pod === null ? "waiting" : "active",
    label: q.label,
    devSet: q.devSet,
    owner,
    requestedBy: requestedBy ?? (owner.by === "agent" ? owner.client : undefined),
    startedAt: Date.now(),
    idleStopAt: agentIdle ? Date.now() + owner.idleStopMinutes * 60_000 : undefined,
  };
  mockForwards.set(f.id, f);
  emitMock({ type: "forwards" });
  return f;
}

// ── name proxy (proxy.rs): same naming rule as Rust ──

/** One DNS label: lowercase letters and digits, anything else `-` (collapsed, trimmed), ≤ 63. */
export function mockDnsLabel(s: string): string | null {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  return out || null;
}
function mockNames(): { host: string; forward: string }[] {
  const sorted = [...mockForwards.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.length - b.id.length || a.id.localeCompare(b.id));
  const out: { host: string; forward: string }[] = [];
  for (const f of sorted) {
    const name = (f.label ? mockDnsLabel(f.label) : null) ?? mockDnsLabel(f.target.name);
    const ns = mockDnsLabel(f.namespace);
    if (!name || !ns) continue;
    const host = `${name}.${ns}.localhost`;
    if (!out.some((n) => n.host === host)) out.push({ host, forward: f.id });
  }
  return out;
}

let proxy: { on: boolean; port: number } = { on: false, port: 7080 };
const proxyStatus = (): NameProxyStatus => ({ ...proxy, names: proxy.on ? mockNames() : [] });

export const fwdMock: FwdBackend = {
  startForward: (q) => {
    try {
      return delay(mockStartForward(q));
    } catch (e) {
      return Promise.reject(e);
    }
  },
  listForwards: () => delay([...mockForwards.values()].map(snapshot)),
  stopForward: (id) => {
    if (mockForwards.delete(id)) emitMock({ type: "forwards" });
    return delay(undefined);
  },
  resolveForwardTarget: (context, target) => {
    if (target.kind === "pod") return delay({ target, resolvedPod: target.name, ports: [{ name: "http", port: 8080, protocol: "TCP" }], ready: true });
    const pod = mockResolve(context, target);
    if (target.kind === "service") {
      const info = mockServiceInfo({ context, gvr: SERVICES_GVR, namespace: target.namespace, name: target.name });
      return delay({
        target,
        resolvedPod: pod ?? undefined,
        ports: info.ports.map((p) => ({ name: p.name, port: p.port, protocol: p.protocol })),
        ready: pod !== null,
        message: pod === null ? "no ready endpoint" : undefined,
        hints: info.hints,
      });
    }
    return delay({ target, resolvedPod: pod ?? undefined, ports: [{ name: "http", port: 8080, protocol: "TCP" }], ready: pod !== null });
  },
  openForward: (id) => {
    const f = mockForwards.get(id);
    if (!f) return fail("NotFound", `forward ${id} is not running`, 404);
    const named = proxy.on ? mockNames().find((n) => n.forward === id) : undefined;
    const url = named ? `http://${named.host}:${proxy.port}/` : `http://${f.address.includes(":") ? `[${f.address}]` : f.address}:${f.localPort}/`;
    console.info(`[mock] would open ${url} in the browser`);
    return delay(undefined);
  },
  serviceInfo: (ref) => delay(mockServiceInfo(ref)),
  nameProxyStatus: () => delay(proxyStatus()),
  nameProxySet: (on, port) => {
    const p = port ?? proxy.port;
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return fail("Invalid", `the name proxy port is 1024-65535, not ${p}`);
    if (on && [...mockForwards.values()].some((f) => f.localPort === p)) return fail("AddrInUse", `the name proxy could not listen on 127.0.0.1:${p}: port ${p} is in use`);
    proxy = { on, port: p };
    emitMock({ type: "forwards" });
    return delay(proxyStatus());
  },
};
