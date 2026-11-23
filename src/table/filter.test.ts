import { describe, expect, it } from "vitest";
import { compileFilters, detectMode, fuzzyMatch, labelSelectorOf, mergeRanges, nextMode, parseFilterInput, validLabelSelector } from "./filter";

describe("parseFilterInput", () => {
  it("plain text is a regex chip", () => {
    expect(parseFilterInput("web", "re")).toEqual({ filter: { mode: "re", text: "web" } });
  });
  it("k9s prefixes: !re, -l selector, -f fuzzy", () => {
    expect(parseFilterInput("!kube", "re")).toEqual({ filter: { mode: "not", text: "kube" } });
    expect(parseFilterInput("-l app=web", "re")).toEqual({ filter: { mode: "label", selector: "app=web" } });
    expect(parseFilterInput("-f wb", "re")).toEqual({ filter: { mode: "fuzzy", text: "wb" } });
  });
  it("prefixes are literal outside RE mode", () => {
    expect(detectMode("!x", "not")).toEqual({ mode: "not", text: "!x" });
    expect(detectMode("-l a=b", "fuzzy")).toEqual({ mode: "fuzzy", text: "-l a=b" });
  });
  it("the Tab mode decides without a prefix", () => {
    expect(parseFilterInput("app=web,tier in (a,b)", "label")).toEqual({ filter: { mode: "label", selector: "app=web,tier in (a,b)" } });
    expect(parseFilterInput("wb", "fuzzy")).toEqual({ filter: { mode: "fuzzy", text: "wb" } });
    expect(parseFilterInput("x", "not")).toEqual({ filter: { mode: "not", text: "x" } });
  });
  it("empty input is no filter; bad input is an error", () => {
    expect(parseFilterInput("", "re")).toEqual({ filter: null });
    expect(parseFilterInput("!", "re")).toEqual({ filter: null });
    expect(parseFilterInput("-l ", "re")).toEqual({ filter: null });
    expect(parseFilterInput("(", "re")).toEqual({ filter: null, error: "invalid regex" });
    expect(parseFilterInput("-l a b c", "re")).toEqual({ filter: null, error: "invalid label selector" });
  });
  it("cycles RE, NOT, LABEL, FUZZY", () => {
    expect(nextMode("re")).toBe("not");
    expect(nextMode("not")).toBe("label");
    expect(nextMode("label")).toBe("fuzzy");
    expect(nextMode("fuzzy")).toBe("re");
    expect(nextMode("not", ["re", "not", "fuzzy"])).toBe("fuzzy");
  });
});

describe("label selectors", () => {
  it("validates requirements", () => {
    for (const ok of ["app", "app=web", "app==web", "app!=web", "!app", "app in (a, b)", "app notin (a)", "a=b,c=d", "app.kubernetes.io/name=x"]) {
      expect(validLabelSelector(ok)).toBe(true);
    }
    for (const bad of ["", "a b", "=x", "a=b,,", "a in b"]) expect(validLabelSelector(bad)).toBe(false);
  });
  it("joins label chips and the scope selector for the server", () => {
    expect(labelSelectorOf([{ mode: "re", text: "x" }])).toBeUndefined();
    expect(labelSelectorOf([{ mode: "label", selector: "a=b" }, { mode: "label", selector: "c" }], "app=web")).toBe("app=web,a=b,c");
  });
});

describe("compileFilters", () => {
  const row = ["web-7d9f8", "1/1", "Running", "shop"];
  it("no chips: everything passes", () => {
    const m = compileFilters([]);
    expect(m.empty).toBe(true);
    expect(m.test(row, "web-7d9f8")).toBe(true);
  });
  it("RE matches any cell, case-insensitive", () => {
    expect(compileFilters([{ mode: "re", text: "running" }]).test(row, "web-7d9f8")).toBe(true);
    expect(compileFilters([{ mode: "re", text: "^api" }]).test(row, "web-7d9f8")).toBe(false);
  });
  it("NOT excludes rows where any cell matches", () => {
    expect(compileFilters([{ mode: "not", text: "shop" }]).test(row, "web-7d9f8")).toBe(false);
    expect(compileFilters([{ mode: "not", text: "kube" }]).test(row, "web-7d9f8")).toBe(true);
  });
  it("FUZZY matches the name as a subsequence", () => {
    expect(compileFilters([{ mode: "fuzzy", text: "w7f" }]).test(row, "web-7d9f8")).toBe(true);
    expect(compileFilters([{ mode: "fuzzy", text: "run" }]).test(row, "web-7d9f8")).toBe(false);
  });
  it("chips combine with AND; LABEL is server-side and ignored here", () => {
    const m = compileFilters([{ mode: "re", text: "web" }, { mode: "not", text: "Pending" }, { mode: "label", selector: "app=web" }]);
    expect(m.empty).toBe(false);
    expect(m.test(row, "web-7d9f8")).toBe(true);
    expect(m.labelSelector).toBe("app=web");
    expect(compileFilters([{ mode: "re", text: "web" }, { mode: "re", text: "Pending" }]).test(row, "web-7d9f8")).toBe(false);
    expect(compileFilters([{ mode: "label", selector: "app=web" }]).empty).toBe(true);
  });
  it("an invalid regex chip is ignored, not thrown", () => {
    expect(compileFilters([{ mode: "re", text: "(" }]).test(row, "web")).toBe(true);
  });
  it("highlight ranges: regex in any cell, fuzzy only in the name", () => {
    const m = compileFilters([{ mode: "re", text: "e" }, { mode: "fuzzy", text: "wb" }]);
    expect(m.ranges("web-web", true)).toEqual([[0, 3], [5, 6]]);
    expect(m.ranges("web", false)).toEqual([[1, 2]]);
    expect(compileFilters([{ mode: "not", text: "e" }]).ranges("web", true)).toEqual([]);
    expect(compileFilters([{ mode: "re", text: "x*" }]).ranges("web", true)).toEqual([]);
  });
});

describe("fuzzyMatch / mergeRanges", () => {
  it("returns positions or null", () => {
    expect(fuzzyMatch("wb", "web")).toEqual([0, 2]);
    expect(fuzzyMatch("WB", "web")).toEqual([0, 2]);
    expect(fuzzyMatch("bw", "web")).toBeNull();
  });
  it("merges overlapping and touching ranges", () => {
    expect(mergeRanges([[4, 6], [0, 2], [1, 3], [6, 7]])).toEqual([[0, 3], [4, 7]]);
  });
});
