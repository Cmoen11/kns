// The traffic view, pure (docs/tools.md#traffic): readings of a pod's socket table (TrafficSample,
// traffic.rs) added up into flows. A flow is one direction, protocol, peer and port: outbound by
// the peer's port (postgres:5432), inbound by the pod's own port (8080 from Deployment/web). Pods
// of one workload are one peer. No store, no React.
import type { TrafficConnection, TrafficDirection, TrafficListener, TrafficPeer, TrafficProto, TrafficSample } from "../ipc/types";

export interface Flow {
  key: string;
  direction: TrafficDirection;
  proto: TrafficProto;
  peer: TrafficPeer;
  /** outbound: the peer's port; inbound: the pod's port */
  port: number;
  /** connections in the latest reading (0: seen before, not now) */
  open: number;
  /** the states of those connections, most common first */
  states: string[];
  /** readings it was in */
  seen: number;
  /** ms since epoch */
  firstAt: number;
  lastAt: number;
  /** the pods (or addresses) behind the peer, newest last, at most 20 */
  members: string[];
}

export interface Traffic {
  flows: ReadonlyMap<string, Flow>;
  listening: readonly TrafficListener[];
  readings: number;
  container?: string;
  notes: readonly string[];
  /** ms since epoch of the latest reading */
  at?: number;
}

export const EMPTY: Traffic = { flows: new Map(), listening: [], readings: 0, notes: [] };

/** The peer as one name: a workload for its pods, `ns/name` for Services, the address otherwise. */
export function peerKey(p: TrafficPeer): string {
  switch (p.kind) {
    case "pod":
      return `pod:${p.namespace}/${p.workload ?? p.name}`;
    case "service":
      return `svc:${p.namespace}/${p.name}`;
    case "loopback":
      return "loopback";
    default:
      return `${p.kind}:${p.name}`;
  }
}

/** What a peer is called in a row. */
export function peerLabel(p: TrafficPeer, ownNamespace: string | undefined): string {
  const ns = p.namespace && p.namespace !== ownNamespace ? `${p.namespace}/` : "";
  switch (p.kind) {
    case "pod": {
      // `deployment web`, `statefulset monitoring/prometheus`, like `svc payments/postgres`
      const [kind, name] = p.workload?.includes("/") ? p.workload.split("/", 2) : ["pod", p.name];
      return `${kind.toLowerCase()} ${ns}${name}`;
    }
    case "service":
      return `svc ${ns}${p.name}`;
    case "node":
      return `node ${p.name}`;
    case "loopback":
      return "localhost (a container of this pod)";
    case "self":
      return "this pod";
    default:
      return p.name;
  }
}

export const flowKey = (c: TrafficConnection): string => `${c.direction}|${c.proto}|${peerKey(c.peer)}|${c.direction === "out" ? c.remotePort : c.localPort}`;

/** The traffic after one more reading. */
export function addSample(prev: Traffic, s: TrafficSample, now: number): Traffic {
  const groups = new Map<string, TrafficConnection[]>();
  for (const c of s.connections) {
    const k = flowKey(c);
    const list = groups.get(k);
    if (list) list.push(c);
    else groups.set(k, [c]);
  }
  const flows = new Map<string, Flow>();
  for (const [k, f] of prev.flows) flows.set(k, groups.has(k) ? f : { ...f, open: 0, states: [] });
  for (const [k, list] of groups) {
    const c = list[0];
    const old = prev.flows.get(k);
    const count = new Map<string, number>();
    for (const x of list) count.set(x.state, (count.get(x.state) ?? 0) + 1);
    const members = [...(old?.members ?? [])];
    for (const x of list) {
      const m = x.peer.kind === "pod" ? x.peer.name : x.remoteIp;
      const i = members.indexOf(m);
      if (i >= 0) members.splice(i, 1);
      members.push(m);
    }
    flows.set(k, {
      key: k,
      direction: c.direction,
      proto: c.proto,
      // the newest pod of the workload (Enter opens it)
      peer: c.peer,
      port: c.direction === "out" ? c.remotePort : c.localPort,
      open: list.length,
      states: [...count.entries()].sort((a, b) => b[1] - a[1]).map(([st]) => st),
      seen: (old?.seen ?? 0) + 1,
      firstAt: old?.firstAt ?? now,
      lastAt: now,
      members: members.slice(-20),
    });
  }
  return { flows, listening: s.listening, readings: prev.readings + 1, container: s.container, notes: s.notes ?? [], at: now };
}

/** A connection that is still being set up: likely refused or dropped on the way (a NetworkPolicy, a firewall). */
export const connecting = (f: Flow): boolean => f.open > 0 && f.states.length === 1 && (f.states[0] === "SYN_SENT" || f.states[0] === "SYN_RECV");

/** "12 s", "4 min", "2 h". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/** The status cell of a flow. */
export function flowStatus(f: Flow, now: number): string {
  if (f.open > 0) return `${f.open} open · ${f.states.join(", ")}`;
  return `seen ${ago(now - f.lastAt)} ago`;
}

/** The order of a list: by peer, then port. Stable across readings, so rows do not jump under the cursor. */
export function sortFlows(flows: Iterable<Flow>, ownNamespace: string | undefined): Flow[] {
  return [...flows].sort((a, b) => peerLabel(a.peer, ownNamespace).localeCompare(peerLabel(b.peer, ownNamespace)) || a.port - b.port || a.proto.localeCompare(b.proto));
}
