// Pure pane geometry (docs/ux.md §3.3, §3.4): pixel rects for the tree in a given area, fold to
// tabs under layout pressure, zoom, dividers, direction neighbours and divider moves.
// Nothing is stored: fold and zoom never change the tree.
import type { Dir, LayoutNode, PaneId } from "../types";
import { hasLeaf, leafIds, pathTo, type Edge } from "./layout-tree";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Size {
  w: number;
  h: number;
}

/** §3.3: 1px divider between panes. */
export const DIVIDER = 1;
/** §3.4: a folded or zoomed pane carries one tab strip, 20px by default. */
export const STRIP = 20;
/** The strip height the theme asks for (--k-h-tabstrip); STRIP outside a browser. */
export function stripHeight(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return STRIP;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--k-h-tabstrip"));
  return v > 0 ? v : STRIP;
}
/** §3.3: keyboard resize steps. */
export const RESIZE_STEP = 24;
export const RESIZE_FINE = 8;
const SNAP_PX = 8;
const SNAPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];

export interface SplitGeom {
  id: string;
  dir: Dir;
  rect: Rect;
  /** true when the split shows only its MRU child */
  folded: boolean;
  /** size of each child along the split's axis (empty when folded) */
  px: number[];
  /** the smallest each child may get */
  mins: number[];
}
export interface DividerGeom {
  split: string;
  /** between children index and index + 1 */
  index: number;
  dir: Dir;
  rect: Rect;
}
export interface StripGeom {
  rect: Rect;
  /** every pane reachable through this strip, in pane order */
  panes: PaneId[];
  active: PaneId;
  reason: "fold" | "zoom";
}
export interface Geometry {
  size: Size;
  /** visible panes only (below their strip) */
  rects: Map<PaneId, Rect>;
  strips: StripGeom[];
  dividers: DividerGeom[];
  splits: Map<string, SplitGeom>;
  /** panes hidden by fold or zoom */
  hidden: PaneId[];
}

export interface GeometryInput {
  root: LayoutNode;
  width: number;
  height: number;
  /** most recent first; decides which child of a folded split shows */
  mru: readonly PaneId[];
  zoomed: PaneId | null;
  /** minimum pane size (§1: 240×120 tables, 240×96 others) */
  min: (pane: PaneId) => Size;
}

type Axis = "w" | "h";
const axisOf = (dir: Dir): Axis => (dir === "row" ? "w" : "h");

/** The least a subtree needs along an axis when every split inside it folds. */
function foldedMin(node: LayoutNode, axis: Axis, min: (pane: PaneId) => Size): number {
  if (node.kind === "leaf") return min(node.pane)[axis];
  let m = 0;
  for (const c of node.children) m = Math.max(m, foldedMin(c, axis, min));
  return m;
}

/** Shares `total` by fraction, never giving a child less than its minimum (sum of mins <= total). */
export function distribute(total: number, fractions: readonly number[], mins: readonly number[]): number[] {
  const n = fractions.length;
  const px = new Array<number>(n).fill(0);
  const locked = new Array<boolean>(n).fill(false);
  for (let round = 0; round <= n; round++) {
    let free = total;
    let fsum = 0;
    for (let i = 0; i < n; i++) {
      if (locked[i]) free -= mins[i];
      else fsum += fractions[i];
    }
    let again = false;
    for (let i = 0; i < n; i++) {
      if (locked[i]) {
        px[i] = mins[i];
        continue;
      }
      px[i] = fsum > 0 ? (free * fractions[i]) / fsum : free / n;
      if (px[i] < mins[i] - 1e-6) {
        locked[i] = true;
        again = true;
      }
    }
    if (!again) break;
  }
  return px;
}

function mruLeaf(node: LayoutNode, mru: readonly PaneId[]): PaneId {
  for (const p of mru) if (hasLeaf(node, p)) return p;
  return leafIds(node)[0];
}

export function computeGeometry(input: GeometryInput): Geometry {
  const { root, mru, min } = input;
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const g: Geometry = { size: { w: width, h: height }, rects: new Map(), strips: [], dividers: [], splits: new Map(), hidden: [] };
  const all = leafIds(root);
  const full: Rect = { x: 0, y: 0, w: width, h: height };
  const strip = stripHeight();
  const below = (r: Rect): Rect => ({ x: r.x, y: r.y + strip, w: r.w, h: Math.max(0, r.h - strip) });
  const stripOf = (r: Rect): Rect => ({ x: r.x, y: r.y, w: r.w, h: strip });

  if (input.zoomed && all.length > 1 && all.includes(input.zoomed)) {
    g.strips.push({ rect: stripOf(full), panes: all, active: input.zoomed, reason: "zoom" });
    g.rects.set(input.zoomed, below(full));
    g.hidden = all.filter((p) => p !== input.zoomed);
    return g;
  }

  const place = (node: LayoutNode, rect: Rect, stripped: boolean): void => {
    if (node.kind === "leaf") {
      g.rects.set(node.pane, rect);
      return;
    }
    const axis = axisOf(node.dir);
    const n = node.children.length;
    const avail = rect[axis] - DIVIDER * (n - 1);
    const mins = node.children.map((c) => foldedMin(c, axis, min));
    const need = mins.reduce((a, b) => a + b, 0);
    if (need > avail + 1e-6) {
      // fold: only the MRU child shows; one strip per chain lists every leaf under the outer split
      const active = mruLeaf(node, mru);
      const shown = node.children.find((c) => hasLeaf(c, active)) ?? node.children[0];
      g.splits.set(node.id, { id: node.id, dir: node.dir, rect, folded: true, px: [], mins });
      for (const c of node.children) if (c !== shown) leafIds(c, g.hidden);
      let inner = rect;
      if (!stripped) {
        g.strips.push({ rect: stripOf(rect), panes: leafIds(node), active, reason: "fold" });
        inner = below(rect);
      }
      place(shown, inner, true);
      return;
    }
    const exact = distribute(avail, node.sizes, mins);
    // whole pixels: round the running edge, so the children always fill the rect exactly
    const px: number[] = [];
    let run = 0;
    let edge = 0;
    for (let i = 0; i < n; i++) {
      run += exact[i];
      const next = i === n - 1 ? avail : Math.round(run);
      px.push(next - edge);
      edge = next;
    }
    g.splits.set(node.id, { id: node.id, dir: node.dir, rect, folded: false, px, mins });
    let pos = axis === "w" ? rect.x : rect.y;
    for (let i = 0; i < n; i++) {
      const r: Rect = axis === "w" ? { x: pos, y: rect.y, w: px[i], h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: px[i] };
      place(node.children[i], r, stripped);
      pos += px[i];
      if (i < n - 1) {
        g.dividers.push({
          split: node.id,
          index: i,
          dir: node.dir,
          rect: axis === "w" ? { x: pos, y: rect.y, w: DIVIDER, h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: DIVIDER },
        });
        pos += DIVIDER;
      }
    }
  };
  place(root, full, false);
  return g;
}

/**
 * Rects of every pane as if nothing were folded or zoomed. Direction keys use these, so focus can
 * move to a pane that is folded away or zoomed out (which then becomes the one shown, §3.4).
 */
export function navigationRects(root: LayoutNode, size: Size, mru: readonly PaneId[] = []): Map<PaneId, Rect> {
  return computeGeometry({ root, width: size.w, height: size.h, mru, zoomed: null, min: () => ({ w: 0, h: 0 }) }).rects;
}

/**
 * The visible pane next to `from` in a direction: the nearest one that overlaps it on the other
 * axis; ties go to the most recently used.
 */
export function neighbor(rects: ReadonlyMap<PaneId, Rect>, from: PaneId, edge: Edge, mru: readonly PaneId[] = []): PaneId | null {
  const a = rects.get(from);
  if (!a) return null;
  let best: PaneId | null = null;
  let bestDist = Infinity;
  let bestRank = Infinity;
  for (const [id, b] of rects) {
    if (id === from) continue;
    const horizontal = edge === "left" || edge === "right";
    const overlap = horizontal
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (overlap <= 0) continue;
    const dist =
      edge === "right" ? b.x - (a.x + a.w) : edge === "left" ? a.x - (b.x + b.w) : edge === "down" ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
    if (dist < 0) continue;
    const r = mru.indexOf(id);
    const rank = r < 0 ? Number.MAX_SAFE_INTEGER : r;
    if (dist < bestDist - 0.5 || (Math.abs(dist - bestDist) <= 0.5 && rank < bestRank)) {
      best = id;
      bestDist = dist;
      bestRank = rank;
    }
  }
  return best;
}

export interface DividerRef {
  split: string;
  index: number;
}

/**
 * The divider a keyboard resize in `edge` direction moves (§3.3): the one on that side of the
 * pane, or, when there is none, the one on the opposite side.
 */
export function dividerFor(root: LayoutNode, pane: PaneId, edge: Edge): DividerRef | null {
  const path = pathTo(root, pane);
  if (!path) return null;
  const dir: Dir = edge === "left" || edge === "right" ? "row" : "col";
  const after = edge === "right" || edge === "down";
  const find = (wantAfter: boolean): DividerRef | null => {
    for (let i = path.length - 1; i >= 0; i--) {
      const { split, index } = path[i];
      if (split.dir !== dir) continue;
      if (wantAfter && index < split.children.length - 1) return { split: split.id, index };
      if (!wantAfter && index > 0) return { split: split.id, index: index - 1 };
    }
    return null;
  };
  return find(after) ?? find(!after);
}

/**
 * New fractions for a split after moving one divider by `delta` px (positive = right / down).
 * Only the two adjacent children change, clamped at their minimums. `snap` adds the 8px magnet to
 * 1/4, 1/3, 1/2, 2/3 and 3/4 of the split. Null when nothing can move.
 */
export function moveDivider(s: SplitGeom, index: number, delta: number, opts: { snap?: boolean } = {}): number[] | null {
  if (s.folded || index < 0 || index >= s.px.length - 1) return null;
  const a = s.px[index];
  const b = s.px[index + 1];
  const lo = Math.min(0, s.mins[index] - a);
  const hi = Math.max(0, b - s.mins[index + 1]);
  let d = Math.max(lo, Math.min(hi, delta));
  if (opts.snap) {
    const total = s.px.reduce((x, y) => x + y, 0) + DIVIDER * (s.px.length - 1);
    let before = 0;
    for (let i = 0; i < index; i++) before += s.px[i] + DIVIDER;
    const pos = before + a + d;
    let nearest: number | null = null;
    for (const f of SNAPS) {
      const off = f * total - pos;
      if (Math.abs(off) <= SNAP_PX && (nearest === null || Math.abs(off) < Math.abs(nearest))) nearest = off;
    }
    if (nearest !== null && d + nearest >= lo && d + nearest <= hi) d += nearest;
  }
  const px = [...s.px];
  px[index] = a + d;
  px[index + 1] = b - d;
  const sum = px.reduce((x, y) => x + y, 0);
  if (!(sum > 0)) return null;
  return px.map((p) => p / sum);
}
