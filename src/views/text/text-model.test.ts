import { describe, expect, it } from "vitest";
import { approxTokens, formatBytes, formatTokens, redactionText, sizeLine, sumReports, utf8Bytes } from "./measure";
import type { TextDoc } from "./sources";
import { canDrop, clampIndex, composeDoc, keptIds, measureDoc, toggleDrop } from "./text-model";

const report = (byRule: Record<string, number>) => ({ count: Object.values(byRule).reduce((a, b) => a + b, 0), byRule });

const doc = (over: Partial<TextDoc> = {}): TextDoc => ({
  title: "t",
  droppable: true,
  measure: true,
  sections: [
    { id: "header", title: "", body: "# head\n", format: "plain" },
    { id: "a", title: "A", body: "aaa\n", format: "plain", droppable: true, redactions: report({ key: 2, url: 1 }) },
    { id: "b", title: "B", body: "bbb\n", format: "plain", droppable: true, redactions: report({ jwt: 1 }) },
  ],
  ...over,
});

describe("section dropping", () => {
  it("drops and restores droppable sections only", () => {
    const d = doc();
    const one = toggleDrop(d, new Set(), "a");
    expect([...one]).toEqual(["a"]);
    expect([...toggleDrop(d, one, "a")]).toEqual([]);
    expect(toggleDrop(d, one, "header")).toBe(one);
    expect(canDrop(d, "header")).toBe(false);
    expect(keptIds(d, one)).toEqual(["header", "b"]);
  });

  it("drops nothing in a doc that is not droppable", () => {
    const d = doc({ droppable: false });
    expect(canDrop(d, "a")).toBe(false);
    expect(toggleDrop(d, new Set(), "a").size).toBe(0);
  });

  it("copies the kept sections, by the doc's own rule when it has one", () => {
    const d = doc({ compose: undefined });
    expect(composeDoc(d, new Set(["a"]))).toBe("# head\n\n\nbbb\n");
    const own = doc({ compose: (kept) => kept.join(",") });
    expect(composeDoc(own, new Set(["b"]))).toBe("header,a");
  });
});

describe("size line", () => {
  it("measures what would be copied and sums the kept sections' redactions", () => {
    const d = doc({ compose: (kept) => kept.map((id) => d.sections.find((s) => s.id === id)!.body).join("\n") });
    const all = measureDoc(d, new Set());
    expect(all.redactions).toEqual({ count: 4, byRule: { key: 2, url: 1, jwt: 1 } });
    expect(all.kept).toBe(2);
    expect(all.droppable).toBe(2);
    const less = measureDoc(d, new Set(["a"]));
    expect(less.redactions).toEqual({ count: 1, byRule: { jwt: 1 } });
    expect(less.kept).toBe(1);
    expect(less.line).toMatch(/^\d+ B · ~\d+ tokens · redacted 1 value \(1 jwt\)$/);
  });

  it("formats like the plan's example", () => {
    const text = "x".repeat(14 * 1024 + 300);
    expect(sizeLine(text, report({ key: 4, url: 2, jwt: 1 }))).toBe("14 KB · ~3.7k tokens · redacted 7 values (4 key, 2 url, 1 jwt)");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatTokens(999)).toBe("~999 tokens");
    expect(formatTokens(12_400)).toBe("~12k tokens");
    expect(redactionText({ count: 0, byRule: {} })).toBe("redacted 0 values");
    expect(redactionText(report({ key: 1 }))).not.toMatch(/safe/i);
  });

  it("counts bytes as UTF-8 and tokens per 4 characters", () => {
    expect(utf8Bytes("•••")).toBe(9);
    expect(approxTokens("•••")).toBe(1);
    expect(sumReports([undefined, report({ a: 1 }), report({ a: 2, b: 1 })])).toEqual({ count: 4, byRule: { a: 3, b: 1 } });
  });

  it("clamps the cursor", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });
});
