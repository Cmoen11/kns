import { describe, expect, it } from "vitest";
import { Heights } from "./heights";
import { Ring, SeqList } from "./ring";

describe("Ring", () => {
  it("keeps the newest `cap` items and reports what fell off", () => {
    const r = new Ring<string>(3);
    expect(r.push("a")).toBeUndefined();
    r.push("b");
    r.push("c");
    expect(r.full).toBe(true);
    expect(r.push("d")).toBe("a");
    expect(r.push("e")).toBe("b");
    expect(r.size).toBe(3);
    expect([r.at(0), r.at(1), r.at(2)]).toEqual(["c", "d", "e"]);
    expect(r.at(3)).toBeUndefined();
    expect(r.at(-1)).toBeUndefined();
  });

  it("addresses entries by a sequence number that survives drops", () => {
    const r = new Ring<number>(2);
    for (let i = 0; i < 5; i++) r.push(i * 10);
    expect(r.first).toBe(3);
    expect(r.nextSeq).toBe(5);
    expect(r.get(2)).toBeUndefined();
    expect(r.get(3)).toBe(30);
    expect(r.get(4)).toBe(40);
    expect(r.get(5)).toBeUndefined();
  });

  it("never reuses sequence numbers after clear", () => {
    const r = new Ring<string>(4);
    r.push("a");
    r.push("b");
    r.clear();
    expect(r.size).toBe(0);
    expect(r.first).toBe(2);
    r.push("c");
    expect(r.get(2)).toBe("c");
    expect(r.get(0)).toBeUndefined();
  });

  it("iterates oldest first with sequence numbers", () => {
    const r = new Ring<string>(2);
    ["a", "b", "c"].forEach((x) => r.push(x));
    const seen: [string, number][] = [];
    r.forEach((item, seq) => seen.push([item, seq]));
    expect(seen).toEqual([["b", 1], ["c", 2]]);
  });

  it("wraps many times without losing order", () => {
    const r = new Ring<number>(7);
    for (let i = 0; i < 1000; i++) r.push(i);
    expect(Array.from({ length: 7 }, (_, i) => r.at(i))).toEqual([993, 994, 995, 996, 997, 998, 999]);
  });
});

describe("SeqList", () => {
  it("finds by binary search and drops from the front", () => {
    const l = new SeqList();
    [2, 5, 9, 14].forEach((n) => l.push(n));
    expect(l.lowerBound(5)).toBe(1);
    expect(l.lowerBound(6)).toBe(2);
    expect(l.lowerBound(100)).toBe(4);
    expect(l.has(9)).toBe(true);
    expect(l.has(10)).toBe(false);
    l.shift();
    expect(l.length).toBe(3);
    expect(l.first()).toBe(5);
    expect(l.at(0)).toBe(5);
    expect(l.lowerBound(5)).toBe(0);
    expect(l.last()).toBe(14);
  });

  it("stays correct across compaction", () => {
    const l = new SeqList();
    for (let i = 0; i < 20000; i++) l.push(i);
    for (let i = 0; i < 15000; i++) l.shift();
    expect(l.length).toBe(5000);
    expect(l.first()).toBe(15000);
    expect(l.lowerBound(15010)).toBe(10);
    expect(l.at(4999)).toBe(19999);
  });
});

describe("Heights", () => {
  it("gives offsets and hit-tests rows of different heights", () => {
    const h = new Heights();
    [1, 3, 1, 2].forEach((u) => h.push(u));
    expect(h.rows).toBe(4);
    expect(h.total).toBe(7);
    expect([0, 1, 2, 3, 4].map((r) => h.offset(r))).toEqual([0, 1, 4, 5, 7]);
    expect([0, 1, 2, 3, 4, 5, 6].map((u) => h.rowAt(u))).toEqual([0, 1, 1, 1, 2, 3, 3]);
    expect(h.rowAt(-5)).toBe(0);
    expect(h.rowAt(99)).toBe(3);
  });

  it("drops rows from the front and reports their units", () => {
    const h = new Heights();
    [2, 1, 4].forEach((u) => h.push(u));
    expect(h.dropFront(2)).toBe(3);
    expect(h.rows).toBe(1);
    expect(h.total).toBe(4);
    expect(h.offset(0)).toBe(0);
    expect(h.rowAt(3)).toBe(0);
    h.push(1);
    expect(h.offset(1)).toBe(4);
  });

  it("changes one row's height", () => {
    const h = new Heights();
    [1, 1, 1].forEach((u) => h.push(u));
    expect(h.set(1, 5)).toBe(4);
    expect(h.total).toBe(7);
    expect(h.offset(2)).toBe(6);
    expect(h.units(1)).toBe(5);
    expect(h.set(1, 1)).toBe(-4);
    expect(h.total).toBe(3);
  });

  it("is empty-safe", () => {
    const h = new Heights();
    expect(h.rowAt(0)).toBe(-1);
    expect(h.total).toBe(0);
    expect(h.dropFront(3)).toBe(0);
  });
});
