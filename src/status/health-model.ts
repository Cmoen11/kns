// Namespace health, the pure part: counts, severity, the tooltip sentence, where a badge click goes
// and the "problems first" order. The data comes from nshealth.rs (or the mock) as NsHealthSnapshot.
import type { NsHealth, NsHealthSnapshot, WorkloadKind } from "../ipc/types";

export type Severity = "warn" | "error";

/** Everything wrong in one namespace (pods + workloads). */
export function nsCount(h: NsHealth | undefined): number {
  if (!h) return 0;
  return h.podsFailing + h.podsWarn + h.workloads.reduce((n, w) => n + w.down + w.degraded, 0);
}

export function nsSeverity(h: NsHealth | undefined): Severity | null {
  if (!h || nsCount(h) === 0) return null;
  return h.podsFailing > 0 || h.workloads.some((w) => w.down > 0) ? "error" : "warn";
}

const SINGULAR: Record<WorkloadKind, string> = { deployments: "deployment", statefulsets: "statefulset", daemonsets: "daemonset" };
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "2 pods failing, 1 pod warning, 1 deployment down, 1 deployment degraded". */
export function healthText(h: NsHealth | undefined): string {
  if (!h) return "healthy";
  const parts: string[] = [];
  if (h.podsFailing > 0) parts.push(`${n(h.podsFailing, "pod")} failing`);
  if (h.podsWarn > 0) parts.push(`${n(h.podsWarn, "pod")} warning`);
  for (const w of h.workloads) {
    if (w.down > 0) parts.push(`${n(w.down, SINGULAR[w.kind])} down`);
    if (w.degraded > 0) parts.push(`${n(w.degraded, SINGULAR[w.kind])} degraded`);
  }
  return parts.length > 0 ? parts.join(", ") : "healthy";
}

/** The resource a badge click opens with FAULTS on: pods when a pod is faulty, else the first workload kind. */
export function faultsResource(h: NsHealth | undefined): "pods" | WorkloadKind {
  if (!h || h.podsFailing + h.podsWarn > 0) return "pods";
  return h.workloads.find((w) => w.down + w.degraded > 0)?.kind ?? "pods";
}

export interface HealthTotals {
  /** namespaces with a fault */
  namespaces: number;
  count: number;
  failing: number;
  severity: Severity | null;
}

/** The sum over every namespace (the "all namespaces" row, the titlebar summary). */
export function totals(s: NsHealthSnapshot | null): HealthTotals {
  const out: HealthTotals = { namespaces: 0, count: 0, failing: 0, severity: null };
  if (!s) return out;
  for (const h of s.namespaces) {
    const c = nsCount(h);
    if (c === 0) continue;
    out.namespaces++;
    out.count += c;
    out.failing += h.podsFailing + h.workloads.reduce((x, w) => x + w.down, 0);
  }
  out.severity = out.count === 0 ? null : out.failing > 0 ? "error" : "warn";
  return out;
}

/** The sum as one NsHealth (the tooltip of the "all namespaces" row). */
export function merged(s: NsHealthSnapshot | null): NsHealth | undefined {
  if (!s || s.namespaces.length === 0) return undefined;
  const out: NsHealth = { namespace: "*", podsFailing: 0, podsWarn: 0, workloads: [] };
  for (const h of s.namespaces) {
    out.podsFailing += h.podsFailing;
    out.podsWarn += h.podsWarn;
    for (const w of h.workloads) {
      const have = out.workloads.find((x) => x.kind === w.kind);
      if (have) {
        have.down += w.down;
        have.degraded += w.degraded;
      } else out.workloads.push({ ...w });
    }
  }
  return out;
}

/** Is the snapshot a statement about the cluster at all (else the badges say "unknown")? */
export const knows = (s: NsHealthSnapshot | null): boolean => !!s && (s.state === "live" || s.state === "reconnecting" || s.state === "partial");

/**
 * Problems first: errors, then warnings, each by count (most first), then everything else in the
 * given order. Stable, so equal namespaces keep their place.
 */
export function problemsFirst(names: readonly string[], byNs: ReadonlyMap<string, NsHealth>): string[] {
  const rank = (ns: string) => {
    const h = byNs.get(ns);
    const sev = nsSeverity(h);
    return sev === "error" ? 0 : sev === "warn" ? 1 : 2;
  };
  return names
    .map((ns, i) => ({ ns, i, r: rank(ns), c: nsCount(byNs.get(ns)) }))
    .sort((a, b) => a.r - b.r || (a.r < 2 ? b.c - a.c : 0) || a.i - b.i)
    .map((x) => x.ns);
}

/**
 * Structural sharing: entries of `next` equal to the previous ones keep the previous object, so a
 * badge subscribed to one namespace re-renders only when its own counts change.
 */
export function shareEntries(prev: ReadonlyMap<string, NsHealth>, next: readonly NsHealth[]): Map<string, NsHealth> {
  const out = new Map<string, NsHealth>();
  for (const h of next) {
    const old = prev.get(h.namespace);
    out.set(h.namespace, old && JSON.stringify(old) === JSON.stringify(h) ? old : h);
  }
  return out;
}

/** The worst namespaces, errors first, then by count (home's "Needs attention"). */
export function worst(byNs: ReadonlyMap<string, NsHealth>, limit = 8): NsHealth[] {
  const names = problemsFirst([...byNs.keys()].sort(), byNs);
  return names.slice(0, limit).map((n) => byNs.get(n)!).filter((h) => nsCount(h) > 0);
}
