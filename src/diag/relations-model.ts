// The `relations` view's pure model (docs/plan-features.md §3 C3): the tree flattened into rows
// with fold state, and what `h` / `l` do on a row. No DOM, no stores: tested in c3-model.test.ts.
import type { RelationKind, RelationNode } from "../ipc/types";
import type { ObjectRef } from "../types";

export interface RelationRow {
  /** path of child indices from the root ("" is the root, "0.2" its first child's third child) */
  key: string;
  depth: number;
  node: RelationNode;
  hasChildren: boolean;
  expanded: boolean;
  /** key of the parent row (null for the root) */
  parent: string | null;
}

/** What a row's relation says, as a short word before the kind. */
export const RELATION_WORD: Record<RelationKind, string> = {
  self: "",
  owner: "owned by",
  owned: "owns",
  traffic: "traffic",
  uses: "uses",
};

/** The tree as rows; children of a key in `collapsed` are hidden. */
export function flatten(root: RelationNode | null, collapsed: ReadonlySet<string>): RelationRow[] {
  if (!root) return [];
  const out: RelationRow[] = [];
  const walk = (n: RelationNode, key: string, depth: number, parent: string | null) => {
    const hasChildren = n.children.length > 0;
    const expanded = hasChildren && !collapsed.has(key);
    out.push({ key, depth, node: n, hasChildren, expanded, parent });
    if (expanded) n.children.forEach((c, i) => walk(c, key === "" ? String(i) : `${key}.${i}`, depth + 1, key));
  };
  walk(root, "", 0, null);
  return out;
}

export function countNodes(root: RelationNode | null): number {
  if (!root) return 0;
  return 1 + root.children.reduce((n, c) => n + countNodes(c), 0);
}

/**
 * `h`: an expanded row folds; otherwise the cursor goes to the parent.
 * `l`: a folded row unfolds; an expanded one moves to its first child.
 * Returns the new collapsed set and cursor key.
 */
export function fold(rows: readonly RelationRow[], cursor: string, collapsed: ReadonlySet<string>, dir: "collapse" | "expand"): { collapsed: Set<string>; cursor: string } {
  const next = new Set(collapsed);
  const row = rows.find((r) => r.key === cursor);
  if (!row) return { collapsed: next, cursor };
  if (dir === "collapse") {
    if (row.expanded) {
      next.add(row.key);
      return { collapsed: next, cursor };
    }
    return { collapsed: next, cursor: row.parent ?? cursor };
  }
  if (row.hasChildren && !row.expanded) {
    next.delete(row.key);
    return { collapsed: next, cursor };
  }
  if (row.expanded) return { collapsed: next, cursor: row.key === "" ? "0" : `${row.key}.0` };
  return { collapsed: next, cursor };
}

/** Why `h` / `l` do nothing on this row, or true. */
export function canFold(row: RelationRow | undefined, dir: "collapse" | "expand"): true | string {
  if (!row) return "no row";
  if (dir === "collapse") return row.expanded || row.parent !== null ? true : "nothing to fold";
  return row.hasChildren ? true : "nothing below this row";
}

export const toObjectRef = (n: RelationNode): ObjectRef => ({ gvr: n.ref.gvr, namespace: n.ref.namespace, name: n.ref.name });

/** Status words that mean trouble (rendered warn). */
export function statusSeverity(status: string | undefined): "error" | "warn" | null {
  if (!status) return null;
  if (/missing|not Ready|Failed|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|forbidden|Error/i.test(status)) return "error";
  const m = /^(\d+)\/(\d+) ready$/.exec(status);
  if (m && Number(m[1]) < Number(m[2])) return "warn";
  if (/Pending|suspended|reconciling|ContainerCreating/i.test(status)) return "warn";
  return null;
}
