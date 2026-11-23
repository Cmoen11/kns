import { describe, expect, it } from "vitest";
import { compileMatcher, nextMode, sameQuery } from "./match";

describe("compileMatcher", () => {
  it("is null for an empty pattern", () => {
    expect(compileMatcher(null)).toBeNull();
    expect(compileMatcher({ mode: "re", text: "" })).toBeNull();
    expect(compileMatcher({ mode: "fuzzy", text: "   " })).toBeNull();
  });

  it("RE: tests and returns every range", () => {
    const m = compileMatcher({ mode: "re", text: "err(or)?" })!;
    expect(m.highlights).toBe(true);
    expect(m.test("an error and an err")).toBe(true);
    expect(m.test("fine")).toBe(false);
    expect(m.ranges("an error and an err")).toEqual([[3, 8], [16, 19]]);
    expect(m.ranges("fine")).toEqual([]);
  });

  it("RE: smart case", () => {
    const lower = compileMatcher({ mode: "re", text: "error" })!;
    expect(lower.test("ERROR")).toBe(true);
    const upper = compileMatcher({ mode: "re", text: "Error" })!;
    expect(upper.test("ERROR")).toBe(false);
    expect(upper.test("Error")).toBe(true);
    // an escape such as \S or \D does not make the pattern case-sensitive
    expect(compileMatcher({ mode: "re", text: "\\Serr" })!.test("xERR")).toBe(true);
  });

  it("RE: repeated test calls are stable (no lastIndex state)", () => {
    const m = compileMatcher({ mode: "re", text: "a" })!;
    expect([m.test("a"), m.test("a"), m.test("a")]).toEqual([true, true, true]);
    expect(m.ranges("aa")).toEqual([[0, 1], [1, 2]]);
    expect(m.ranges("aa")).toEqual([[0, 1], [1, 2]]);
  });

  it("RE: zero-length matches do not loop or highlight", () => {
    const m = compileMatcher({ mode: "re", text: "x*" })!;
    expect(m.ranges("axxb")).toEqual([[1, 3]]);
    expect(compileMatcher({ mode: "re", text: "^" })!.ranges("abc")).toEqual([]);
  });

  it("RE: an invalid pattern is matched literally and reports the error", () => {
    const m = compileMatcher({ mode: "re", text: "foo(" })!;
    expect(m.error).toBeTruthy();
    expect(m.test("call foo( now")).toBe(true);
    expect(m.ranges("call foo( now")).toEqual([[5, 9]]);
    expect(m.test("foo")).toBe(false);
  });

  it("NOT: passes lines without the pattern and highlights nothing", () => {
    const m = compileMatcher({ mode: "not", text: "healthz" })!;
    expect(m.highlights).toBe(false);
    expect(m.test("GET /healthz 200")).toBe(false);
    expect(m.test("GET /api 200")).toBe(true);
    expect(m.ranges("GET /healthz 200")).toEqual([]);
  });

  it("FUZZY: in-order subsequence, case-insensitive", () => {
    const m = compileMatcher({ mode: "fuzzy", text: "cnrf" })!;
    expect(m.test("connection refused")).toBe(true);
    expect(m.test("Connection ReFused")).toBe(true);
    expect(m.test("refused connection")).toBe(false);
    expect(m.ranges("connection refused")).toEqual([[0, 1], [2, 3], [11, 12], [13, 14]]);
  });

  it("FUZZY: prefers a contiguous hit and merges adjacent characters", () => {
    const m = compileMatcher({ mode: "fuzzy", text: "time out" })!;
    expect(m.ranges("a timeout at t")).toEqual([[2, 9]]);
    expect(compileMatcher({ mode: "fuzzy", text: "abd" })!.ranges("abcd")).toEqual([[0, 2], [3, 4]]);
  });

  it("cycles modes and compares queries", () => {
    expect(nextMode("re")).toBe("not");
    expect(nextMode("not")).toBe("fuzzy");
    expect(nextMode("fuzzy")).toBe("re");
    expect(sameQuery(null, undefined)).toBe(true);
    expect(sameQuery({ mode: "re", text: "a" }, { mode: "re", text: "a" })).toBe(true);
    expect(sameQuery({ mode: "re", text: "a" }, { mode: "not", text: "a" })).toBe(false);
    expect(sameQuery({ mode: "re", text: "a" }, null)).toBe(false);
  });
});
