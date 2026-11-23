import { describe, expect, it } from "vitest";
import type { LayoutNode, SplitNode } from "../types";
import { computeGeometry, distribute, dividerFor, moveDivider, navigationRects, neighbor, STRIP } from "./geometry";
import {
  equalizeAll,
  equalizeSplit,
  flipSplit,
  insertAtRoot,
  insertBeside,
  leaf,
  leafIds,
  normalize,
  parentOf,
  removeLeaf,
  setSplitSizes,
  swapLeaves,
  treeErrors,
} from "./layout-tree";

function gen() {
  let n = 0;
  return () => `s${++n}`;
}
const split = (id: string, dir: "row" | "col", children: LayoutNode[], sizes?: number[]): SplitNode => ({
  kind: "split", id, dir, children, sizes: sizes ?? children.map(() => 1 / children.length),
});
const ok = (root: LayoutNode) => expect(treeErrors(root)).toEqual([]);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("insertBeside", () => {
  it("wraps a lone leaf in a new split", () => {
    const r = insertBeside(leaf("a"), "a", "b", "right", gen()) as SplitNode;
    expect(r.dir).toBe("row");
    expect(leafIds(r)).toEqual(["a", "b"]);
    expect(r.sizes).toEqual([0.5, 0.5]);
    ok(r);
  });

  it("adds a sibling in a same-direction parent and halves the source", () => {
    const root = split("r", "row", [leaf("a"), leaf("b")], [0.6, 0.4]);
    const r = insertBeside(root, "a", "c", "right", gen()) as SplitNode;
    expect(leafIds(r)).toEqual(["a", "c", "b"]);
    expect(r.sizes).toEqual([0.3, 0.3, 0.4]);
    expect(r.children[2]).toBe(root.children[1]);
    ok(r);
  });

  it("wraps the leaf when the parent runs the other way, and inserts before on left/up", () => {
    const root = split("r", "row", [leaf("a"), leaf("b")]);
    const r = insertBeside(root, "b", "c", "up", gen()) as SplitNode;
    expect(leafIds(r)).toEqual(["a", "c", "b"]);
    const inner = r.children[1] as SplitNode;
    expect(inner.dir).toBe("col");
    expect(r.children[0]).toBe(root.children[0]);
    ok(r);
  });
});

describe("removeLeaf", () => {
  it("gives the fraction to the siblings proportionally", () => {
    const root = split("r", "row", [leaf("a"), leaf("b"), leaf("c")], [0.5, 0.25, 0.25]);
    const r = removeLeaf(root, "a") as SplitNode;
    expect(r.sizes[0]).toBeCloseTo(0.5);
    expect(r.sizes[1]).toBeCloseTo(0.5);
    ok(r);
  });

  it("replaces a one-child split by the child and re-flattens", () => {
    // row[a, col[b, row[c, d]]] minus b -> row[a, c, d]
    const root = split("r", "row", [leaf("a"), split("c1", "col", [leaf("b"), split("r2", "row", [leaf("c"), leaf("d")])])]);
    const r = removeLeaf(root, "b") as SplitNode;
    expect(r.children.every((c) => c.kind === "leaf")).toBe(true);
    expect(leafIds(r)).toEqual(["a", "c", "d"]);
    expect(r.sizes).toEqual([0.5, 0.25, 0.25]);
    ok(r);
  });

  it("returns null for the last leaf", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });
});

describe("normalize, flip, equalize, swap, root insert", () => {
  it("normalize fixes sizes and merges same-dir children", () => {
    const r = normalize(split("r", "row", [leaf("a"), split("x", "row", [leaf("b"), leaf("c")])], [2, 2])) as SplitNode;
    expect(r.children.length).toBe(3);
    expect(sum(r.sizes)).toBeCloseTo(1);
    ok(r);
  });

  it("flip toggles the parent's dir and stays flattened", () => {
    const root = split("r", "row", [leaf("a"), split("c", "col", [leaf("b"), leaf("d")])]);
    const r = flipSplit(root, "c") as SplitNode;
    expect(leafIds(r)).toEqual(["a", "b", "d"]);
    expect(r.children.length).toBe(3);
    ok(r);
    const f = flipSplit(root, "r") as SplitNode;
    expect(f.dir).toBe("col");
    expect(f.children.length).toBe(3);
    ok(f);
  });

  it("equalizes one split or the whole tree; three columns become thirds", () => {
    const root = split("r", "row", [leaf("a"), leaf("b"), split("c", "col", [leaf("x"), leaf("y")], [0.9, 0.1])], [0.5, 0.3, 0.2]);
    const one = equalizeSplit(root, "r") as SplitNode;
    expect(one.sizes.every((s) => Math.abs(s - 1 / 3) < 1e-9)).toBe(true);
    expect(one.children[2]).toBe(root.children[2]);
    const all = equalizeAll(root) as SplitNode;
    expect((all.children[2] as SplitNode).sizes).toEqual([0.5, 0.5]);
    expect(equalizeAll(all)).toBe(all);
  });

  it("swaps leaves and docks at the root", () => {
    const root = split("r", "row", [leaf("a"), split("c", "col", [leaf("b"), leaf("d")])]);
    expect(leafIds(swapLeaves(root, "a", "d"))).toEqual(["d", "b", "a"]);
    const docked = insertAtRoot(removeLeaf(root, "d")!, "d", "down", gen()) as SplitNode;
    expect(docked.dir).toBe("col");
    expect(leafIds(docked)).toEqual(["a", "b", "d"]);
    ok(docked);
    const side = insertAtRoot(root, "z", "left", gen()) as SplitNode;
    expect(leafIds(side)[0]).toBe("z");
    expect(sum(side.sizes)).toBeCloseTo(1);
    ok(side);
  });

  it("setSplitSizes normalizes and ignores a wrong length", () => {
    const root = split("r", "row", [leaf("a"), leaf("b")]);
    expect((setSplitSizes(root, "r", [3, 1]) as SplitNode).sizes).toEqual([0.75, 0.25]);
    expect(setSplitSizes(root, "r", [1, 1, 1])).toBe(root);
    expect(parentOf(root, "b")).toEqual({ split: root, index: 1 });
  });
});

const min = () => ({ w: 240, h: 120 });
const geo = (root: LayoutNode, width: number, height: number, mru: string[] = [], zoomed: string | null = null) =>
  computeGeometry({ root, width, height, mru, zoomed, min });

describe("geometry", () => {
  it("distribute keeps fractions and clamps to minimums", () => {
    expect(distribute(1000, [0.5, 0.5], [240, 240])).toEqual([500, 500]);
    const px = distribute(600, [0.9, 0.1], [240, 240]);
    expect(px).toEqual([360, 240]);
    expect(sum(distribute(900, [0.8, 0.1, 0.1], [240, 240, 240]))).toBeCloseTo(900);
  });

  it("lays out columns with 1px dividers that fill the area exactly", () => {
    const root = split("r", "row", [leaf("a"), leaf("b"), leaf("c")]);
    const g = geo(root, 1000, 700);
    const a = g.rects.get("a")!;
    const b = g.rects.get("b")!;
    const c = g.rects.get("c")!;
    expect(a.x).toBe(0);
    expect(b.x).toBe(a.w + 1);
    expect(c.x + c.w).toBe(1000);
    expect(a.w + b.w + c.w).toBe(998);
    expect(g.dividers.length).toBe(2);
    expect(g.strips).toEqual([]);
    expect(a.h).toBe(700);
  });

  it("folds a split that cannot give every child its minimum, showing the MRU child with one strip", () => {
    const root = split("r", "row", [leaf("a"), leaf("b"), leaf("c")]);
    const g = geo(root, 600, 500, ["b", "a", "c"]);
    expect([...g.rects.keys()]).toEqual(["b"]);
    expect(g.hidden.sort()).toEqual(["a", "c"]);
    expect(g.strips).toHaveLength(1);
    expect(g.strips[0].panes).toEqual(["a", "b", "c"]);
    expect(g.strips[0].active).toBe("b");
    expect(g.rects.get("b")).toEqual({ x: 0, y: STRIP, w: 600, h: 500 - STRIP });
    // the tree is untouched and it unfolds when space returns
    expect(geo(root, 1000, 500, ["b"]).strips).toEqual([]);
  });

  it("folds only the inner split when that is enough, and merges strips of nested folds", () => {
    // row[a, col[b, row[c, d]]]: at 600 wide the inner row folds, the outer row still fits
    const root = split("r", "row", [leaf("a"), split("c1", "col", [leaf("b"), split("r2", "row", [leaf("c"), leaf("d")])])]);
    const g = geo(root, 600, 600, ["d", "a"]);
    expect([...g.rects.keys()].sort()).toEqual(["a", "b", "d"]);
    expect(g.strips).toHaveLength(1);
    expect(g.strips[0].panes).toEqual(["c", "d"]);
    // too narrow for the outer row as well: one strip lists every leaf
    const tiny = geo(root, 300, 200, ["d", "a"]);
    expect([...tiny.rects.keys()]).toEqual(["d"]);
    expect(tiny.strips).toHaveLength(1);
    expect(tiny.strips[0].panes).toEqual(["a", "b", "c", "d"]);
  });

  it("zoom shows one pane with a strip listing all panes", () => {
    const root = split("r", "row", [leaf("a"), leaf("b")]);
    const g = geo(root, 1000, 500, ["a", "b"], "b");
    expect([...g.rects.keys()]).toEqual(["b"]);
    expect(g.strips[0]).toMatchObject({ reason: "zoom", active: "b", panes: ["a", "b"] });
    expect(g.dividers).toEqual([]);
  });

  it("finds neighbours by direction, preferring the most recently used", () => {
    const root = split("r", "row", [leaf("a"), split("c", "col", [leaf("b"), leaf("d")])]);
    const g = geo(root, 1000, 600);
    expect(neighbor(g.rects, "a", "right", ["d", "b"])).toBe("d");
    expect(neighbor(g.rects, "a", "right", ["b", "d"])).toBe("b");
    expect(neighbor(g.rects, "b", "left")).toBe("a");
    expect(neighbor(g.rects, "b", "down")).toBe("d");
    expect(neighbor(g.rects, "a", "left")).toBeNull();
    expect(neighbor(g.rects, "a", "up")).toBeNull();
  });

  it("direction keys still find folded and zoomed-out panes", () => {
    const root = split("r", "row", [leaf("a"), split("c", "col", [leaf("b"), leaf("d")])]);
    // zoomed on a: only a has a visible rect, yet `right` must reach b (which then becomes the zoomed pane)
    const zoomed = geo(root, 1000, 600, ["a", "b", "d"], "a");
    expect(neighbor(zoomed.rects, "a", "right")).toBeNull();
    const nav = navigationRects(root, { w: 1000, h: 600 }, ["a", "b", "d"]);
    expect(nav.size).toBe(3);
    expect(neighbor(nav, "a", "right", ["a", "b", "d"])).toBe("b");
    // folded: 300px cannot hold two columns, the hidden one is still a neighbour
    expect(geo(root, 300, 600, ["a"]).hidden).toEqual(["b", "d"]);
    expect(neighbor(navigationRects(root, { w: 300, h: 600 }, ["a"]), "a", "right", ["a", "d"])).toBe("d");
  });

  it("picks the divider for a keyboard resize, falling back to the opposite side", () => {
    const root = split("r", "row", [leaf("a"), split("c", "col", [leaf("b"), leaf("d")])]);
    expect(dividerFor(root, "a", "right")).toEqual({ split: "r", index: 0 });
    expect(dividerFor(root, "b", "right")).toEqual({ split: "r", index: 0 });
    expect(dividerFor(root, "a", "left")).toEqual({ split: "r", index: 0 });
    expect(dividerFor(root, "d", "up")).toEqual({ split: "c", index: 0 });
    expect(dividerFor(root, "a", "down")).toBeNull();
  });

  it("moves a divider between two children only, clamped at the minimums", () => {
    const root = split("r", "row", [leaf("a"), leaf("b"), leaf("c")]);
    const s = geo(root, 1202, 600).splits.get("r")!;
    expect(s.px).toEqual([400, 400, 400]);
    const sizes = moveDivider(s, 0, 24)!;
    expect(sizes[0]).toBeCloseTo(424 / 1200);
    expect(sizes[1]).toBeCloseTo(376 / 1200);
    expect(sizes[2]).toBeCloseTo(400 / 1200);
    const clamped = moveDivider(s, 0, -1000)!;
    expect(clamped[0]).toBeCloseTo(240 / 1200);
    expect(clamped[1]).toBeCloseTo(560 / 1200);
  });

  it("snaps a dragged divider to a third within 8px", () => {
    const root = split("r", "row", [leaf("a"), leaf("b")]);
    const s = geo(root, 1201, 600).splits.get("r")!;
    // divider at 600; a third is 400.33: dragging to 395 snaps there, 380 does not
    const snapped = moveDivider(s, 0, -205, { snap: true })!;
    expect(snapped[0] * 1200).toBeCloseTo(1201 / 3, 5);
    const free = moveDivider(s, 0, -220, { snap: true })!;
    expect(free[0] * 1200).toBeCloseTo(380);
  });
});
