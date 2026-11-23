import { describe, expect, it } from "vitest";
import { cursorAfterRemoval, reconcile, sortAll, type OrderState } from "./order";

const cmp = (a: string, b: string) => a.localeCompare(b);
const st = (order: string[], unsorted = 0): OrderState => ({ order, unsorted });

describe("row order while live (§12.3)", () => {
  it("a full sort orders everything and clears UNSORTED", () => {
    expect(sortAll(["c", "a", "b"], cmp)).toEqual({ order: ["a", "b", "c"], unsorted: 0 });
  });
  it("returns the same state when nothing came or went", () => {
    const prev = st(["a", "b", "c"]);
    expect(reconcile({ prev, visible: ["c", "b", "a"], cmp, cursor: "b", window: { first: 0, last: 10 } })).toBe(prev);
  });
  it("rows that changed value keep their place (no re-sort)", () => {
    // 'z' sits first because it sorted there before its value changed
    const prev = st(["z", "b", "c"]);
    expect(reconcile({ prev, visible: ["z", "b", "c", "d"], cmp, cursor: "z", window: { first: 0, last: 10 } }).order).toEqual(["z", "b", "c", "d"]);
  });
  it("removed rows drop out, the rest keep their order", () => {
    expect(reconcile({ prev: st(["a", "b", "c", "d"]), visible: ["a", "c", "d"], cmp, cursor: "c", window: { first: 0, last: 10 } })).toEqual(st(["a", "c", "d"]));
  });
  it("a new row below the cursor goes to its sort position", () => {
    expect(reconcile({ prev: st(["a", "c", "e"]), visible: ["a", "c", "e", "d"], cmp, cursor: "c", window: { first: 0, last: 10 } })).toEqual(st(["a", "c", "d", "e"]));
  });
  it("a new row that would land on screen above the cursor is appended and counted", () => {
    const next = reconcile({ prev: st(["a", "c", "e"]), visible: ["a", "c", "e", "b"], cmp, cursor: "c", window: { first: 0, last: 10 } });
    expect(next).toEqual(st(["a", "c", "e", "b"], 1));
  });
  it("above the cursor but off screen: sorted in (scroll anchoring absorbs it)", () => {
    const prev = st(["b", "c", "d", "e", "f", "g"]);
    const next = reconcile({ prev, visible: [...prev.order, "a"], cmp, cursor: "f", window: { first: 3, last: 5 } });
    expect(next).toEqual(st(["a", "b", "c", "d", "e", "f", "g"]));
  });
  it("no cursor: always sorted in", () => {
    expect(reconcile({ prev: st(["b", "c"]), visible: ["b", "c", "a"], cmp, cursor: null, window: { first: 0, last: 10 } })).toEqual(st(["a", "b", "c"]));
  });
  it("appended rows stay at the end across frames and new sorted rows go before them", () => {
    const prev = st(["a", "c", "e", "b"], 1);
    const next = reconcile({ prev, visible: ["a", "c", "e", "b", "d"], cmp, cursor: "c", window: { first: 0, last: 10 } });
    expect(next).toEqual(st(["a", "c", "d", "e", "b"], 1));
    const gone = reconcile({ prev: next, visible: ["a", "c", "d", "e"], cmp, cursor: "c", window: { first: 0, last: 10 } });
    expect(gone).toEqual(st(["a", "c", "d", "e"], 0));
  });
  it("unknown window (not laid out yet) treats everything as on screen", () => {
    expect(reconcile({ prev: st(["b", "c"]), visible: ["b", "c", "a"], cmp, cursor: "c", window: null })).toEqual(st(["b", "c", "a"], 1));
  });
  it("the cursor takes the row that moved into its index", () => {
    expect(cursorAfterRemoval(["a", "c", "d"], 1)).toBe("c");
    expect(cursorAfterRemoval(["a", "b"], 5)).toBe("b");
    expect(cursorAfterRemoval([], 0)).toBeNull();
  });
});
