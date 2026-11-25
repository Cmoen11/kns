// Namespace health (status-colors package): one cluster-wide aggregation in Rust (nshealth.rs),
// pushed through a Channel as debounced snapshots. Mirror: src-tauri/src/contract/health.rs.
// Counts only: no names, no cluster text beyond namespace names and a state message.
import type { Unsubscribe } from "../types";

/**
 * syncing: the first lists are on their way; live: counts are current; reconnecting: counts are
 * the last known; partial: pods are counted but a workload kind could not be listed; forbidden:
 * pods cannot be listed cluster-wide (RBAC), nothing is counted; error: anything else, retried.
 */
export type NsHealthState = "syncing" | "live" | "reconnecting" | "partial" | "forbidden" | "error";

export type WorkloadKind = "deployments" | "statefulsets" | "daemonsets";

/** Faults of one workload kind in one namespace (only kinds with a fault are listed). */
export interface WorkloadFaults {
  kind: WorkloadKind;
  /** no replica ready (status error) */
  down: number;
  /** some replicas not ready (status warn) */
  degraded: number;
}

/**
 * One namespace with at least one fault. The fault rule is the table's FAULTS filter
 * (src/table/status.ts `isFault`): every row a faults view of that namespace shows is counted (a
 * table holds one kind, so the badge may also count workloads that the pods view does not list).
 */
export interface NsHealth {
  namespace: string;
  /** pods in an error state: CrashLoopBackOff, Error, ImagePull*, OOMKilled, Failed, 0/N ready */
  podsFailing: number;
  /** pods in a warn state: Pending / creating for over 60s, some containers not ready, 5+ restarts */
  podsWarn: number;
  workloads: WorkloadFaults[];
}

export interface NsHealthSnapshot {
  context: string;
  state: NsHealthState;
  /** why a state is not live (cleaned server text) */
  message?: string;
  /** namespaces with a fault, by name; healthy namespaces are absent */
  namespaces: NsHealth[];
  /** pods and workloads seen in total (all namespaces) */
  pods: number;
  workloads: number;
}

export interface HealthBackend {
  /**
   * Starts the context's namespace-health watch (pods, deployments, statefulsets and daemonsets
   * across every namespace, server-side Table rows) and reports a snapshot whenever the counts
   * change, at most once a second. The stop function ends it. With `namespaces` it watches only
   * those (a user who may not list pods across all namespaces; at most 40).
   */
  subscribeNsHealth(context: string, onSnapshot: (s: NsHealthSnapshot) => void, namespaces?: readonly string[]): Unsubscribe;
}
