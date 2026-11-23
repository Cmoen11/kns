import { describe, expect, it } from "vitest";
import { comparator, compareKeys, defaultComparator, parseNumber, sortKey, type Sortable } from "./sort";

const s = (key: Sortable["key"], name: string, namespace = "default"): Sortable => ({ key, name, namespace });
const names = (list: Sortable[]) => list.map((x) => x.name);

describe("sortKey", () => {
  it("numbers, quantities and restart cells", () => {
    expect(sortKey("12", "num")).toBe(12);
    expect(sortKey("5 (2m ago)", "num")).toBe(5);
    expect(sortKey("250m", "num")).toBeCloseTo(0.25);
    expect(sortKey("64Mi", "num")).toBe(64 * 1024 * 1024);
    expect(parseNumber("abc")).toBeNull();
  });
  it("durations sort by seconds", () => {
    expect(sortKey("2d4h", "duration")).toBe(2 * 86400 + 4 * 3600);
    expect(sortKey("45s", "duration")).toBe(45);
  });
  it("ratios sort by fraction, then by size", () => {
    const a = sortKey("0/3", "ratio") as number;
    const b = sortKey("1/2", "ratio") as number;
    const c = sortKey("2/2", "ratio") as number;
    const d = sortKey("3/3", "ratio") as number;
    expect(a < b && b < c && c < d).toBe(true);
  });
  it("empty and <none> have no key", () => {
    expect(sortKey("", "text")).toBeNull();
    expect(sortKey("<none>", "num")).toBeNull();
  });
});

describe("comparator", () => {
  it("natural text order", () => {
    expect(compareKeys("web-2", "web-10")).toBeLessThan(0);
    expect(compareKeys(1, "a")).toBeLessThan(0);
  });
  it("ascending and descending, nulls always last", () => {
    const rows = [s(3, "c"), s(null, "x"), s(1, "a"), s(2, "b")];
    expect(names([...rows].sort(comparator(false)))).toEqual(["a", "b", "c", "x"]);
    expect(names([...rows].sort(comparator(true)))).toEqual(["c", "b", "a", "x"]);
  });
  it("ties break by namespace then name, in both directions", () => {
    const rows = [s(1, "b", "ns2"), s(1, "a", "ns2"), s(1, "z", "ns1")];
    expect(names([...rows].sort(comparator(false)))).toEqual(["z", "a", "b"]);
    expect(names([...rows].sort(comparator(true)))).toEqual(["z", "a", "b"]);
  });
  it("kind default: namespace first, then name", () => {
    const rows = [s(null, "b", "kube-system"), s(null, "z", "default"), s(null, "a", "kube-system")];
    expect(names([...rows].sort(defaultComparator))).toEqual(["z", "a", "b"]);
  });
});
