// `:diff` arguments and the reserved revision id for last-applied. Pure and eager (no YAML, no
// CodeMirror), so the action handlers stay small.
import type { DiffSide, DiffView, Gvr, ObjectRef } from "../types";

/**
 * `DiffSide` has no variant for last-applied (domain.ts is A1's), so it is a revision with this
 * reserved id: `{ revision: { owner, id: APPLIED } }` is the object's
 * `kubectl.kubernetes.io/last-applied-configuration`.
 */
export const APPLIED = "@last-applied";

export type DiffMode = "marks" | "prev" | "applied";

export function parseDiffArgs(args: readonly string[]): { mode: DiffMode } | { error: string } {
  if (args.length === 0) return { mode: "marks" };
  if (args.length === 1 && (args[0] === "prev" || args[0] === "applied")) return { mode: args[0] };
  return { error: "Usage: :diff  (two marked rows) | :diff prev | :diff applied" };
}

const g = (group: string, resource: string) => (gvr: Gvr) => gvr.group === group && gvr.resource === resource;
const REVISIONED = [g("apps", "deployments"), g("apps", "statefulsets"), g("apps", "daemonsets"), g("helm.toolkit.fluxcd.io", "helmreleases")];

/** Kinds that have revisions (`:diff prev`). */
export const hasRevisions = (gvr: Gvr): boolean => REVISIONED.some((f) => f(gvr));
export const isSecretGvr = (gvr: Gvr): boolean => gvr.group === "" && gvr.resource === "secrets";

/** Why two marked rows cannot be diffed, or null. */
export function marksProblem(marked: readonly ObjectRef[]): string | null {
  if (marked.length !== 2) return marked.length < 2 ? "mark two rows (Space), then D" : `${marked.length} rows marked: diff takes exactly two`;
  return null;
}

export function diffView(left: DiffSide, right: DiffSide): DiffView {
  return { kind: "diff", left, right, managedFields: false, split: true };
}

/** The two revisions `:diff prev` compares: the one before the newest, and the newest. */
export function prevPair<R extends { revision: number }>(revs: readonly R[]): [R, R] | string {
  const sorted = [...revs].sort((x, y) => y.revision - x.revision);
  if (sorted.length < 2) return sorted.length === 0 ? "no revisions" : "only one revision: nothing to compare";
  return [sorted[1], sorted[0]];
}

/** The object a side belongs to (its own ref, or the revision's owner). */
export const sideOwner = (s: DiffSide): ObjectRef => ("ref" in s ? s.ref : s.revision.owner);
export const isApplied = (s: DiffSide): boolean => "revision" in s && s.revision.id === APPLIED;
