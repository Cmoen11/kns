// Port-forward helpers (pure): container ports from a pod's JSON, input validation, addresses.
import type { Forward, ForwardTarget, Json, PortHint, PortRef } from "../../ipc/types";

export interface ContainerPort {
  container: string;
  port: number;
  /** the port's name in the spec, e.g. "http" */
  name?: string;
  protocol: string;
}

const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/**
 * The forwardable (TCP) ports a pod declares, in spec order: containers first, then init
 * containers (sidecars). With `container`, only that container's ports. Tolerates any JSON.
 */
export function containerPorts(pod: Json, container?: string): ContainerPort[] {
  const spec = isObj(pod) && isObj(pod.spec) ? pod.spec : null;
  if (!spec) return [];
  const out: ContainerPort[] = [];
  const seen = new Set<string>();
  for (const c of [...arr(spec.containers), ...arr(spec.initContainers)]) {
    if (!isObj(c) || typeof c.name !== "string") continue;
    if (container !== undefined && c.name !== container) continue;
    for (const p of arr(c.ports)) {
      if (!isObj(p)) continue;
      const port = p.containerPort;
      if (typeof port !== "number" || !validPort(port)) continue;
      const protocol = typeof p.protocol === "string" ? p.protocol : "TCP";
      // port-forward is TCP only
      if (protocol !== "TCP") continue;
      const key = `${c.name}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ container: c.name, port, protocol, ...(typeof p.name === "string" && p.name ? { name: p.name } : {}) });
    }
  }
  return out;
}

export const validPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** A typed port: digits only, 1..65535. null when it is not one. */
export function parsePort(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return validPort(n) ? n : null;
}

/** The local port field: empty or 0 means "pick a free port" (0). null when invalid. */
export function parseLocalPort(text: string): number | null {
  const t = text.trim();
  if (t === "" || t === "0") return 0;
  return parsePort(t);
}

const LOOPBACK4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A bind address: a loopback IP literal only (127.0.0.1, 127.x.y.z, ::1); Rust refuses anything else. */
export function validAddress(text: string): boolean {
  const t = text.trim().replace(/^\[(.*)\]$/, "$1");
  if (t === "::1") return true;
  const m = LOOPBACK4.exec(t);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

/** A remote port field: a port number, or a port name (Service or container port name). null when neither. */
export function parseRemotePort(text: string): PortRef | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) return parsePort(t);
  return /^[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/.test(t) ? t : null;
}

const WORKLOAD_SHORT: Readonly<Record<string, string>> = {
  deployments: "deploy", statefulsets: "sts", daemonsets: "ds", replicasets: "rs", jobs: "job", cronjobs: "cj",
};

/** `svc/kafka`, `deploy/orders`, `pod/web-1`. */
export function targetName(t: ForwardTarget): string {
  if (t.kind === "pod") return `pod/${t.name}`;
  if (t.kind === "service") return `svc/${t.name}`;
  return `${WORKLOAD_SHORT[t.gvr.resource] ?? t.gvr.resource}/${t.name}`;
}

/** The TARGET cell: `svc/kafka → kafka-0`, `deploy/web → waiting`, `pod/web-1`. */
export function targetText(f: Pick<Forward, "target" | "resolvedPod" | "status">): string {
  const name = targetName(f.target);
  if (f.target.kind === "pod") return name;
  if (f.status === "waiting" || !f.resolvedPod) return `${name} → waiting`;
  return `${name} → ${f.resolvedPod}`;
}

/** `9094`, or `local (9094)` when a named port resolved. */
export function remoteText(f: Pick<Forward, "remotePort" | "resolvedPort">): string {
  if (typeof f.remotePort === "number") return String(f.remotePort);
  return f.resolvedPort ? `${f.remotePort} (${f.resolvedPort})` : f.remotePort;
}

/** Who owns it: `owner: me`, `agent: claude-code · stops when idle 15m`, `owner: me · requested by claude-code`. */
export function ownerText(f: Pick<Forward, "owner" | "requestedBy">): string {
  if (f.owner.by === "agent") {
    const idle = f.owner.idleStopMinutes > 0 ? ` · stops when idle ${f.owner.idleStopMinutes}m` : "";
    return `agent: ${f.owner.client}${idle}`;
  }
  return f.requestedBy ? `owner: me · requested by ${f.requestedBy}` : "owner: me";
}

/** Sort key for a remote port that may be a name. */
export const portKey = (p: PortRef): string => (typeof p === "number" ? String(p).padStart(5, "0") : p);

/** Agent-owned forwards that stop within `withinMs` (idle), not yet warned about. */
export function idleWarnings(list: readonly Forward[], now: number, warned: ReadonlySet<string>, withinMs = 60_000): Forward[] {
  return list.filter((f) => f.idleStopAt !== undefined && f.idleStopAt - now <= withinMs && !warned.has(f.id));
}

/** What to copy or open for a forward: wildcard and loopback binds are reached through localhost. */
export function forwardHost(f: Pick<Forward, "address" | "localPort">): string {
  const a = f.address;
  const host = a === "" || a === "127.0.0.1" || a === "0.0.0.0" || a === "::" || a === "::1" || a === "localhost" ? "localhost" : a.includes(":") ? `[${a}]` : a;
  return `${host}:${f.localPort}`;
}

export const forwardUrl = (f: Pick<Forward, "address" | "localPort">): string => `http://${forwardHost(f)}`;

export function portLabel(p: ContainerPort): string {
  return `${p.port}${p.name ? ` ${p.name}` : ""} (${p.container})`;
}

/** Compact age, like kubectl: 12s, 4m, 3h, 2d. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** True when two listings differ in anything the UI shows. */
export function forwardsChanged(a: readonly Forward[], b: readonly Forward[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id || x.status !== y.status || x.connections !== y.connections || x.localPort !== y.localPort ||
      x.remotePort !== y.remotePort || x.address !== y.address || x.message !== y.message || x.pod !== y.pod ||
      x.namespace !== y.namespace || x.context !== y.context || x.resolvedPod !== y.resolvedPod || x.resolvedPort !== y.resolvedPort ||
      x.devSet !== y.devSet || x.idleStopAt !== y.idleStopAt || x.owner.by !== y.owner.by || x.requestedBy !== y.requestedBy || x.label !== y.label
    ) return true;
  }
  return false;
}

/** Forwards that were active (or unknown) before and report an error now: toast these once. */
export function newlyBroken(prev: readonly Forward[], next: readonly Forward[]): Forward[] {
  const before = new Map(prev.map((f) => [f.id, f.status]));
  return next.filter((f) => f.status === "error" && before.get(f.id) !== "error");
}

// ── B2: k9s port-forward annotations, an address per service ──

const K9S_AUTO_PF = "k9scli.io/auto-port-forwards";
const K9S_PF = "k9scli.io/port-forwards";

/** One spec `[container::][local-port:]container-port` (Rust: forward::k9s_spec); else null. */
function k9sSpec(spec: string, auto: boolean): PortHint | null {
  const sep = spec.indexOf("::");
  const container = sep >= 0 ? spec.slice(0, sep).trim() : "";
  const rest = (sep >= 0 ? spec.slice(sep + 2) : spec).trim();
  if (container && !/^[a-z0-9-]{1,63}$/.test(container)) return null;
  const colon = rest.indexOf(":");
  let local: number | undefined;
  let remote = rest;
  if (colon >= 0) {
    const l = rest.slice(0, colon).trim();
    if (!/^\d{1,5}$/.test(l) || Number(l) < 1 || Number(l) > 65535) return null;
    local = Number(l);
    remote = rest.slice(colon + 1).trim();
  }
  let remotePort: PortRef;
  if (/^\d{1,5}$/.test(remote)) {
    const n = Number(remote);
    if (n < 1 || n > 65535) return null;
    remotePort = n;
  } else if (/^(?=.*[a-z])[a-z0-9-]{1,15}$/.test(remote)) remotePort = remote;
  else return null;
  return { ...(container ? { container } : {}), remotePort, ...(local !== undefined ? { localPort: local } : {}), auto };
}

/** The ports a pod's `k9scli.io/*` annotations ask for (auto first; each remote port once; ≤ 20). */
export function k9sHints(pod: Json): PortHint[] {
  const meta = isObj(pod) && isObj(pod.metadata) ? pod.metadata : null;
  const ann = meta && isObj(meta.annotations) ? meta.annotations : null;
  const out: PortHint[] = [];
  for (const [key, auto] of [[K9S_AUTO_PF, true], [K9S_PF, false]] as const) {
    const v = ann?.[key];
    if (typeof v !== "string") continue;
    for (const spec of v.split(",")) {
      const h = k9sSpec(spec, auto);
      if (h && out.length < 20 && !out.some((x) => x.remotePort === h.remotePort && x.container === h.container)) out.push(h);
    }
  }
  return out;
}

/** A hint's remote port as a number on this pod (a port name looked up in its ports). */
export function hintPort(h: PortHint, ports: readonly ContainerPort[]): number | null {
  if (typeof h.remotePort === "number") return h.remotePort;
  const p = ports.find((x) => x.name === h.remotePort && (!h.container || x.container === h.container)) ?? ports.find((x) => x.name === h.remotePort);
  return p ? p.port : null;
}

/**
 * Windows "address per service": a stable 127.0.1.x for `key` (namespace/name), the next free one
 * when taken by another forward; null when all 253 are used. The service keeps its own port.
 */
export function serviceAddress(key: string, used: readonly string[]): string | null {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  const taken = new Set(used);
  for (let i = 0; i < 253; i++) {
    const a = `127.0.1.${2 + ((h + i) % 253)}`;
    if (!taken.has(a)) return a;
  }
  return null;
}
