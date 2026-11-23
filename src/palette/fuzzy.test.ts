import { describe, expect, it } from "vitest";
import { fuzzyMatch, rank, segments } from "./fuzzy";

const order = (items: string[], q: string) => rank(items, q, { text: (s) => s }).map((r) => r.item);

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyMatch("dpl", "deployments")?.positions).toEqual([0, 2, 3]);
    expect(fuzzyMatch("POD", "pods")?.positions).toEqual([0, 1, 2]);
    expect(fuzzyMatch("xyz", "pods")).toBeNull();
    expect(fuzzyMatch("podss", "pods")).toBeNull();
  });

  it("an empty query matches everything", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("prefers word starts for subsequences", () => {
    // h-r: the r of "releases" (a word start), not the first r
    expect(fuzzyMatch("hr", "helm-releases")?.positions).toEqual([0, 5]);
    expect(fuzzyMatch("sr", "splitRight")?.positions).toEqual([0, 5]);
  });

  it("falls back when a word-start jump would strand the rest", () => {
    expect(fuzzyMatch("abc", "a-b-abc")).not.toBeNull();
    expect(fuzzyMatch("ba", "b-ab")?.positions.length).toBe(2);
  });
});

describe("rank", () => {
  it("exact beats prefix beats substring beats subsequence", () => {
    expect(order(["deployments", "pxoxdxs", "replicapods", "pods"], "pods")).toEqual(["pods", "replicapods", "pxoxdxs"]);
    expect(order(["xpodx", "podtemplates", "pod"], "pod")).toEqual(["pod", "podtemplates", "xpodx"]);
  });

  it("prefers the shorter target for the same kind of hit", () => {
    expect(order(["services", "serviceaccounts", "svc"], "serv")).toEqual(["services", "serviceaccounts"]);
  });

  it("is stable for equal scores and keeps input order for an empty query", () => {
    expect(order(["b", "a", "c"], "")).toEqual(["b", "a", "c"]);
    expect(order(["ab1", "ab2"], "ab")).toEqual(["ab1", "ab2"]);
  });

  it("matches keywords without positions and ranks them just below a label hit", () => {
    const items = [
      { label: "deployments", keys: ["deploy", "dp"] },
      { label: "dp-thing", keys: [] },
    ];
    const r = rank(items, "dp", { text: (i) => i.label, keywords: (i) => i.keys });
    expect(r.map((x) => x.item.label)).toEqual(["deployments", "dp-thing"]);
    expect(r[0].positions).toEqual([]);
  });

  it("adds the recency bonus", () => {
    const r = rank(["pods-a", "pods-b"], "pods", { text: (s) => s, bonus: (s) => (s === "pods-b" ? 20 : 0) });
    expect(r[0].item).toBe("pods-b");
  });
});

describe("segments", () => {
  it("splits into hit and plain runs", () => {
    expect(segments("deployments", [0, 2, 3])).toEqual([
      { text: "d", hit: true },
      { text: "e", hit: false },
      { text: "pl", hit: true },
      { text: "oyments", hit: false },
    ]);
    expect(segments("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(segments("", [])).toEqual([]);
  });
});
