import { describe, expect, it } from "vitest";
import { afterClose, MAX_TABS, sanitizeTabs, stepTab, tabToEvict, touch, withoutTab, withTab } from "./tabs";

describe("context tabs", () => {
  it("opens a tab right after the current one, once", () => {
    expect(withTab(["a", "b"], "c", "a")).toEqual(["a", "c", "b"]);
    expect(withTab(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(withTab(["a", "b"], "b", "a")).toEqual(["a", "b"]);
    expect(withoutTab(["a", "b"], "a")).toEqual(["b"]);
  });

  it("steps in strip order and wraps", () => {
    expect(stepTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(stepTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(stepTab(["a", "b", "c"], "b", 1)).toBe("c");
    expect(stepTab([], "a", 1)).toBeNull();
  });

  it("closing the tab on screen goes to the most recently used other tab", () => {
    expect(afterClose(["a", "b", "c"], "b", ["b", "a", "c"])).toBe("a");
    expect(afterClose(["a", "b", "c"], "b", [])).toBe("c");
    expect(afterClose(["a", "b", "c"], "c", [])).toBe("b");
    expect(afterClose(["a"], "a", ["a"])).toBeNull();
  });

  it("evicts the least recently used tab, sparing live sessions and the one on screen", () => {
    const tabs = ["a", "b", "c"];
    expect(tabToEvict(tabs, "a", ["a", "b", "c"], () => false, 4)).toBeNull();
    expect(tabToEvict(tabs, "a", ["a", "b", "c"], () => false, 3)).toBe("c");
    expect(tabToEvict(tabs, "a", ["a", "b", "c"], (t) => t === "c", 3)).toBe("b");
    expect(tabToEvict(tabs, "a", ["a", "b", "c"], () => true, 3)).toBe("c");
    // tabs never used this session go first, leftmost first
    expect(tabToEvict(tabs, "c", ["c"], () => false, 3)).toBe("a");
  });

  it("keeps a most-recently-used order", () => {
    expect(touch(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("restores only known workspaces and always the current one", () => {
    const has = (t: string) => t !== "gone";
    expect(sanitizeTabs(["a", "gone", "a", 3, "b"], "c", has)).toEqual(["a", "b", "c"]);
    expect(sanitizeTabs(undefined, "a", has)).toEqual(["a"]);
    const many = Array.from({ length: MAX_TABS + 2 }, (_, i) => `t${i}`);
    const out = sanitizeTabs(many, `t${MAX_TABS + 1}`, has);
    expect(out).toHaveLength(MAX_TABS);
    expect(out).toContain(`t${MAX_TABS + 1}`);
  });
});
