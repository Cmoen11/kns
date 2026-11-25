// Pod traffic (`:traffic`, docs/tools.md#traffic): one reading of a pod's socket table
// (/proc/net/{tcp,tcp6,udp,udp6} of its network namespace, read with one `cat` exec), each peer
// address named as a pod, Service, node, loopback or external address. The UI reads every few
// seconds and adds the readings up; a connection that opens and closes between two readings is
// not seen. Mirror: src-tauri/src/contract/traffic.rs (types), src-tauri/src/traffic.rs (command).
import type { ObjRef } from "../types";

export interface TrafficRequest {
  /** the pod */
  ref: ObjRef;
  /** the container to read through; default: the first running one that has `cat`, then a kns debug container */
  container?: string;
  /** where to look peers up when pods may not be listed in every namespace (a team's namespaces) */
  namespaces?: string[];
}

export type TrafficProto = "tcp" | "udp";
/** in: a peer connected to a port the pod listens on; out: the pod connected to the peer */
export type TrafficDirection = "in" | "out";
/** loopback: another container of the pod (a sidecar); self: the pod's own address; external: nothing in the cluster has it */
export type TrafficPeerKind = "pod" | "service" | "node" | "loopback" | "self" | "external";

export interface TrafficPeer {
  kind: TrafficPeerKind;
  namespace?: string;
  /** pod, Service or node name; the address for loopback and external */
  name: string;
  /** a pod's workload as `Kind/name` (Deployment/web) */
  workload?: string;
}

export interface TrafficConnection {
  proto: TrafficProto;
  direction: TrafficDirection;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  /** ESTABLISHED, SYN_SENT, TIME_WAIT, ... */
  state: string;
  peer: TrafficPeer;
}

export interface TrafficListener {
  proto: TrafficProto;
  /** 0.0.0.0 or :: = every address */
  ip: string;
  port: number;
}

export interface TrafficSample {
  /** the container the table was read through */
  container: string;
  /** RFC 3339 */
  at: string;
  listening: TrafficListener[];
  connections: TrafficConnection[];
  /** why some peers may have no name */
  notes?: string[];
}

export interface TrafficBackend {
  /**
   * One reading of a pod's socket table (an exec of `cat`; nothing is changed). Rejects with
   * reason "NeedsDebug" when no container of the pod has `cat` and it has no kns debug container.
   */
  trafficSample(req: TrafficRequest): Promise<TrafficSample>;
}
