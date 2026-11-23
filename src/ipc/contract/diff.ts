// Field ownership and revisions (docs/plan-features.md §3 D). Owner D. Mirror: contract/diff.rs.
import type { Json, ObjRef } from "../types";

export type ManagerClass = "flux" | "kns" | "kubectl" | "controller" | "other";

/** One field and a manager that set it; a field several managers own has one row per manager. */
export interface FieldOwner {
  /** JSON pointer into the live object; `k:` / `v:` list keys resolved to indices */
  path: string;
  /** cluster text, cleaned in Rust */
  manager: string;
  managerClass: ManagerClass;
  /** Apply | Update */
  operation: string;
  subresource?: string;
  /** RFC3339 */
  time?: string;
}

export interface Revision {
  id: string;
  revision: number;
  /** RFC3339 */
  createdAt: string;
  image?: string;
  ref: ObjRef;
  /**
   * A ReplicaSet's `spec.template` (no `pod-template-hash`) or a ControllerRevision's `data`.
   * Absent for Helm: release data is never read. Not redacted; for the human diff view only.
   */
  template?: Json;
}

export interface DiffBackend {
  fieldOwners(ref: ObjRef): Promise<FieldOwner[]>;
  /** newest first: ReplicaSets (deployments), ControllerRevisions (statefulsets, daemonsets), Helm history (helmreleases) */
  revisions(ref: ObjRef): Promise<Revision[]>;
}
