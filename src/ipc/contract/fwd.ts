// Forwards and their targets (docs/plan-features.md §2.4). Written by A1; owner B-fwd.
// Rust mirror: src-tauri/src/contract/fwd.rs. Drift fixtures: __fixtures__/fwd.ts.
import type { Gvr, ObjRef } from "../types";

export type ForwardTarget =
  | { kind: "pod"; namespace: string; name: string }
  | { kind: "service"; namespace: string; name: string }
  | { kind: "workload"; gvr: Gvr; namespace: string; name: string };

/** A port number, or a named port (Service port name or container port name). */
export type PortRef = number | string;

export type ForwardOwner = { by: "user" } | { by: "agent"; client: string; idleStopMinutes: number };

export interface ForwardQuery {
  context: string;
  target: ForwardTarget;
  /** number, or a named port (Service port name or container port name) */
  remotePort: PortRef;
  /** 0/undefined = a free port */
  localPort?: number;
  /** true: fail with AddrInUse instead of moving to the next free port */
  pin?: boolean;
  /** loopback IP literal only: 127.0.0.1 (default), ::1, or 127.x.y.z */
  address?: string;
  /** [A-Za-z0-9 ._-]{1,40} */
  label?: string;
  devSet?: string;
  /** set when the human is executing an agent proposal; Rust gates on it and takes the owner from the ticket */
  proposalId?: string;
}

export type ForwardStatus = "active" | "waiting" | "error";

export interface Forward {
  id: string;
  context: string;
  target: ForwardTarget;
  /** compat for existing readers: resolvedPod ?? `${kind}/${name}` */
  pod: string;
  namespace: string;
  resolvedPod?: string;
  remotePort: PortRef;
  resolvedPort?: number;
  localPort: number;
  address: string;
  connections: number;
  /** waiting: no ready pod behind a Service/workload target; the listener stays bound */
  status: ForwardStatus;
  message?: string;
  label?: string;
  /** the dev set id it belongs to */
  devSet?: string;
  owner: ForwardOwner;
  /** client whose proposal started it, kept for display after ownership moved to the human */
  requestedBy?: string;
  /** ms since epoch */
  startedAt: number;
  /** agent-owned with an idle stop and no open connection: when it stops (ms since epoch) */
  idleStopAt?: number;
}

export interface ServicePort {
  name?: string;
  port: number;
  /** number, or a container port name */
  targetPort: PortRef;
  protocol: string;
  appProtocol?: string;
}

/** What a Service most likely is, by image and port (B-fwd). */
export type ServiceKind =
  | "postgres" | "mysql" | "redis" | "memcached" | "kafka" | "schemaRegistry" | "mongodb" | "rabbitmq" | "http" | "unknown";

export interface KafkaListener {
  name: string;
  /** host:port the broker advertises on this listener */
  advertised: string;
  protocol?: string;
}

export interface ServiceInfo {
  ref: ObjRef;
  /** ClusterIP | NodePort | LoadBalancer | ExternalName | Headless */
  type: string;
  ports: ServicePort[];
  selector?: Record<string, string>;
  endpoints: { ready: number; notReady: number; pods: string[] };
  kind: ServiceKind;
  kafkaListeners?: KafkaListener[];
  /** ports a backing pod's `k9scli.io/*` annotations ask for, mapped to Service ports (B2) */
  hints?: PortHint[];
}

/** A port a `k9scli.io/auto-port-forwards` / `k9scli.io/port-forwards` annotation asks for (B2). Never an address. */
export interface PortHint {
  container?: string;
  /** a container port (number or name); on a Service target the Service port it maps to */
  remotePort: PortRef;
  localPort?: number;
  /** from `auto-port-forwards` (k9s starts it without asking; kns only preselects it) */
  auto: boolean;
}

/** How a target resolves right now (pod, port), for the `F` dialog. */
export interface ForwardTargetInfo {
  target: ForwardTarget;
  resolvedPod?: string;
  ports: { name?: string; port: number; protocol: string }[];
  ready: boolean;
  message?: string;
  /** ports the target's `k9scli.io/*` annotations ask for; the first is the dialog's preselection (B2) */
  hints?: PortHint[];
}

/** The `*.localhost` name proxy (B2, proxy.rs). */
export interface NameProxyStatus {
  on: boolean;
  port: number;
  /** `http://<host>:<port>/` routes to the forward */
  names: { host: string; forward: string }[];
  /** why it is off although it was left on (the port was taken at start) */
  error?: string;
}

export interface FwdBackend {
  startForward(query: ForwardQuery): Promise<Forward>;
  listForwards(): Promise<Forward[]>;
  /** closes the listener and its connections; an unknown id is not an error */
  stopForward(id: string): Promise<void>;
  /** Resolves a Service or workload target to a ready pod and its ports. */
  resolveForwardTarget(context: string, target: ForwardTarget): Promise<ForwardTargetInfo>;
  /** Opens `http://<address>:<localPort>/` of a running forward in the default browser (Rust-side opener). */
  openForward(id: string): Promise<void>;
  serviceInfo(ref: ObjRef): Promise<ServiceInfo>;
  /** B2 */
  nameProxyStatus(): Promise<NameProxyStatus>;
  /** B2: off by default; port default 7080 */
  nameProxySet(on: boolean, port?: number): Promise<NameProxyStatus>;
}
