// Pure operations on the pane tree (docs/ux.md §3.1-3.3). The tree is flattened n-ary: a child
// split never has the same dir as its parent. Every function returns a new tree and keeps
// untouched nodes identical by reference; nothing here reads the DOM or a store.
import type { Dir, LayoutNode, LeafNode, PaneId, SplitNode } from "../types";

export type IdGen = () => string;
export type Edge = "left" | "right" | "up" | "down";

/** §3.2: at most 12 leaves per window. */
export const MAX_LEAVES = 12;

export const edgeDir = (e: Edge): Dir => (e === "left" || e === "right" ? "row" : "col");
export const edgeBefore = (e: Edge): boolean => e === "left" || e === "up";
export const opposite = (e: Edge): Edge => (e === "left" ? "right" : e === "right" ? "left" : e === "up" ? "down" : "up");

export const leaf = (pane: PaneId): LeafNode => ({ kind: "leaf", pane });

/** Pane ids in tree order (left to right, top to bottom). This is the pane numbering. */
export function leafIds(node: LayoutNode, out: PaneId[] = []): PaneId[] {
  if (node.kind === "leaf") out.push(node.pane);
  else for (const c of node.children) leafIds(c, out);
  return out;
}

export function hasLeaf(node: LayoutNode, pane: PaneId): boolean {
  return node.kind === "leaf" ? node.pane === pane : node.children.some((c) => hasLeaf(c, pane));
}

export function findSplit(node: LayoutNode, id: string): SplitNode | null {
  if (node.kind === "leaf") return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findSplit(c, id);
    if (hit) return hit;
  }
  return null;
}

export interface PathStep {
  split: SplitNode;
  /** index of the child that contains the pane */
  index: number;
}

/** The splits from the root down to the pane's parent. Empty when the pane is the root; null when absent. */
export function pathTo(root: LayoutNode, pane: PaneId): PathStep[] | null {
  if (root.kind === "leaf") return root.pane === pane ? [] : null;
  for (let i = 0; i < root.children.length; i++) {
    const rest = pathTo(root.children[i], pane);
    if (rest) return [{ split: root, index: i }, ...rest];
  }
  return null;
}

export function parentOf(root: LayoutNode, pane: PaneId): PathStep | null {
  const path = pathTo(root, pane);
  return path && path.length > 0 ? path[path.length - 1] : null;
}

function fixSizes(sizes: readonly number[], n: number): number[] {
  const ok = sizes.length === n && sizes.every((s) => Number.isFinite(s) && s > 0);
  if (!ok) return new Array<number>(n).fill(1 / n);
  const sum = sizes.reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1) < 1e-9 ? (sizes as number[]) : sizes.map((s) => s / sum);
}

/**
 * Restores the invariants: sizes sum to 1, no split with fewer than two children, no child split
 * with its parent's dir (it is merged into the parent, keeping its share).
 */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === "leaf") return node;
  const own = fixSizes(node.sizes, node.children.length);
  let changed = own !== node.sizes;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const n = normalize(c);
    if (n !== c) changed = true;
    if (n.kind === "split" && n.dir === node.dir) {
      changed = true;
      n.children.forEach((g, j) => {
        children.push(g);
        sizes.push(own[i] * n.sizes[j]);
      });
    } else {
      children.push(n);
      sizes.push(own[i]);
    }
  });
  if (children.length === 1) return children[0];
  return changed ? { ...node, children, sizes } : node;
}

/** Rewrites one split by id; the rest of the tree keeps its identity. */
export function updateSplit(root: LayoutNode, id: string, fn: (s: SplitNode) => SplitNode): LayoutNode {
  if (root.kind === "leaf") return root;
  if (root.id === id) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const n = updateSplit(c, id, fn);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...root, children } : root;
}

/**
 * Inserts `pane` on an edge of the leaf `target` (§3.2 Split). A parent split in the same
 * direction gets a new sibling and the target's fraction is halved; otherwise the leaf is wrapped.
 */
export function insertBeside(root: LayoutNode, target: PaneId, pane: PaneId, edge: Edge, ids: IdGen, fraction?: number): LayoutNode {
  return insertNextTo(root, (n) => n.kind === "leaf" && n.pane === target, pane, edge, ids, fraction);
}

/** As insertBeside, next to a whole split (reopening a pane beside the subtree it sat next to). */
export function insertBesideSplit(root: LayoutNode, splitId: string, pane: PaneId, edge: Edge, ids: IdGen, fraction?: number): LayoutNode {
  return normalize(insertNextTo(root, (n) => n.kind === "split" && n.id === splitId, pane, edge, ids, fraction));
}

/**
 * Inserts `pane` on an edge of the first node `isTarget` accepts. Without `fraction` the target's
 * share is halved; with it the new pane takes that share of the split it lands in.
 */
function insertNextTo(root: LayoutNode, isTarget: (n: LayoutNode) => boolean, pane: PaneId, edge: Edge, ids: IdGen, fraction?: number): LayoutNode {
  const dir = edgeDir(edge);
  const before = edgeBefore(edge);
  const f = fraction !== undefined && fraction > 0 && fraction < 1 ? fraction : undefined;
  const go = (node: LayoutNode): LayoutNode => {
    if (isTarget(node)) {
      const own = f ?? 0.5;
      return { kind: "split", id: ids(), dir, children: before ? [leaf(pane), node] : [node, leaf(pane)], sizes: before ? [own, 1 - own] : [1 - own, own] };
    }
    if (node.kind === "leaf") return node;
    const i = node.children.findIndex(isTarget);
    if (i >= 0 && node.dir === dir) {
      const children = [...node.children];
      const sizes = f === undefined ? [...node.sizes] : node.sizes.map((s) => s * (1 - f));
      const own = f ?? node.sizes[i] / 2;
      if (f === undefined) sizes[i] = own;
      const at = before ? i : i + 1;
      children.splice(at, 0, leaf(pane));
      sizes.splice(at, 0, own);
      return { ...node, children, sizes };
    }
    let changed = false;
    const children = node.children.map((c) => {
      const n = go(c);
      if (n !== c) changed = true;
      return n;
    });
    return changed ? { ...node, children } : node;
  };
  return go(root);
}

/** Removes a leaf; its fraction goes to the siblings proportionally. Null when the tree becomes empty. */
export function removeLeaf(root: LayoutNode, pane: PaneId): LayoutNode | null {
  const go = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "leaf") return node.pane === pane ? null : node;
    let changed = false;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const n = go(c);
      if (n !== c) changed = true;
      if (n) {
        children.push(n);
        sizes.push(node.sizes[i]);
      }
    });
    if (!changed) return node;
    if (children.length === 0) return null;
    return { ...node, children, sizes };
  };
  const r = go(root);
  return r && normalize(r);
}

/** Adds `pane` as an outermost child on one edge of the whole tree (dock at root level). */
export function insertAtRoot(root: LayoutNode, pane: PaneId, edge: Edge, ids: IdGen, fraction?: number): LayoutNode {
  const dir = edgeDir(edge);
  const before = edgeBefore(edge);
  if (root.kind === "split" && root.dir === dir) {
    const f = fraction ?? 1 / (root.children.length + 1);
    const rest = root.sizes.map((s) => s * (1 - f));
    return {
      ...root,
      children: before ? [leaf(pane), ...root.children] : [...root.children, leaf(pane)],
      sizes: before ? [f, ...rest] : [...rest, f],
    };
  }
  const f = fraction ?? 0.5;
  return {
    kind: "split",
    id: ids(),
    dir,
    children: before ? [leaf(pane), root] : [root, leaf(pane)],
    sizes: before ? [f, 1 - f] : [1 - f, f],
  };
}

/** Appends `pane` as the last child of an existing split, with an equal share. */
export function appendToSplit(root: LayoutNode, splitId: string, pane: PaneId): LayoutNode {
  return updateSplit(root, splitId, (s) => {
    const f = 1 / (s.children.length + 1);
    return { ...s, children: [...s.children, leaf(pane)], sizes: [...s.sizes.map((x) => x * (1 - f)), f] };
  });
}

export function swapLeaves(root: LayoutNode, a: PaneId, b: PaneId): LayoutNode {
  if (a === b) return root;
  const go = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") return node.pane === a ? leaf(b) : node.pane === b ? leaf(a) : node;
    let changed = false;
    const children = node.children.map((c) => {
      const n = go(c);
      if (n !== c) changed = true;
      return n;
    });
    return changed ? { ...node, children } : node;
  };
  return go(root);
}

/** Toggles the dir of one split (§3.2 Flip) and re-flattens. */
export function flipSplit(root: LayoutNode, splitId: string): LayoutNode {
  return normalize(updateSplit(root, splitId, (s) => ({ ...s, dir: s.dir === "row" ? "col" : "row" })));
}

const equal = (n: number) => new Array<number>(n).fill(1 / n);
const isEqual = (sizes: readonly number[]) => sizes.every((s) => Math.abs(s - 1 / sizes.length) < 1e-9);

export function equalizeSplit(root: LayoutNode, splitId: string): LayoutNode {
  return updateSplit(root, splitId, (s) => (isEqual(s.sizes) ? s : { ...s, sizes: equal(s.children.length) }));
}

export function equalizeAll(root: LayoutNode): LayoutNode {
  if (root.kind === "leaf") return root;
  let changed = !isEqual(root.sizes);
  const children = root.children.map((c) => {
    const n = equalizeAll(c);
    if (n !== c) changed = true;
    return n;
  });
  return changed ? { ...root, children, sizes: equal(children.length) } : root;
}

export function setSplitSizes(root: LayoutNode, splitId: string, sizes: readonly number[]): LayoutNode {
  return updateSplit(root, splitId, (s) => {
    if (sizes.length !== s.children.length) return s;
    const next = fixSizes(sizes, sizes.length);
    return next.every((x, i) => Math.abs(x - s.sizes[i]) < 1e-9) ? s : { ...s, sizes: [...next] };
  });
}

/** Invariant violations of a tree, for tests and for validating persisted data. */
export function treeErrors(root: LayoutNode): string[] {
  const out: string[] = [];
  const seen = new Set<PaneId>();
  const splits = new Set<string>();
  const go = (node: LayoutNode, parentDir: Dir | null) => {
    if (node.kind === "leaf") {
      if (seen.has(node.pane)) out.push(`pane ${node.pane} appears twice`);
      seen.add(node.pane);
      return;
    }
    if (splits.has(node.id)) out.push(`split id ${node.id} appears twice`);
    splits.add(node.id);
    if (node.children.length < 2) out.push(`split ${node.id} has ${node.children.length} children`);
    if (node.sizes.length !== node.children.length) out.push(`split ${node.id}: sizes and children differ in length`);
    if (Math.abs(node.sizes.reduce((a, b) => a + b, 0) - 1) > 1e-6) out.push(`split ${node.id}: sizes do not sum to 1`);
    if (node.sizes.some((s) => !(s > 0))) out.push(`split ${node.id}: a size is not positive`);
    if (node.dir === parentDir) out.push(`split ${node.id} has its parent's dir`);
    for (const c of node.children) go(c, node.dir);
  };
  go(root, null);
  return out;
}
