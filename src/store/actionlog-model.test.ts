import { describe, expect, it } from "vitest";
import { append, capContexts, entryLine, maxId, sanitizeLog, shouldRecord, toEntry, type LogData } from "./actionlog-model";

const gvr = { group: "apps", version: "v1", resource: "deployments" };

describe("action log model", () => {
  it("records by setting", () => {
    expect(shouldRecord("all", false)).toBe(true);
    expect(shouldRecord("writes", false)).toBe(false);
    expect(shouldRecord("writes", true)).toBe(true);
    expect(shouldRecord("off", true)).toBe(false);
  });
  it("cleans untrusted text and fills defaults", () => {
    const e = toEntry({ text: "scaled web\u001b[31m 1 → 2\n", error: "boom\u202e\u0007", namespace: "kns-spike" }, 1, 5);
    expect(e).toEqual({ id: 1, at: 5, state: "error", text: "scaled web 1 → 2", error: "boom", namespace: "kns-spike", write: false });
    expect(toEntry({ text: "x".repeat(500) }, 2, 0).text.length).toBeLessThanOrEqual(200);
    expect(toEntry({ text: "ok" }, 3, 0).state).toBe("ok");
  });
  it("caps the list and the contexts", () => {
    let list = [toEntry({ text: "a" }, 1, 0)];
    for (let i = 2; i <= 5; i++) list = append(list, toEntry({ text: String(i) }, i, i), 3);
    expect(list.map((e) => e.id)).toEqual([3, 4, 5]);
    const d: LogData = { byContext: { a: [], b: [], c: [] }, touched: { a: 1, b: 3, c: 2 } };
    expect(Object.keys(capContexts(d, 2).byContext).sort()).toEqual(["b", "c"]);
  });
  it("validates the persisted log and keeps targets", () => {
    const raw = {
      byContext: {
        default: [
          { id: 7, at: 10, state: "ok", text: "scaled web", write: true, target: { kind: "object", gvr, namespace: "x", name: "web" } },
          { id: 8, at: 11, state: "weird", text: "kept as info", target: { kind: "view", view: "evil" } },
          { id: "9", at: 12, text: "dropped: bad id" },
          "junk",
        ],
        other: "not a list",
      },
      touched: { default: 11 },
    };
    const d = sanitizeLog(raw);
    expect(d.byContext.default.map((e) => e.id)).toEqual([7, 8]);
    expect(d.byContext.default[0].target).toEqual({ kind: "object", gvr, namespace: "x", name: "web" });
    expect(d.byContext.default[1]).toMatchObject({ state: "info", write: false });
    expect(d.byContext.default[1].target).toBeUndefined();
    expect(d.byContext.other).toBeUndefined();
    expect(maxId(d)).toBe(8);
    expect(sanitizeLog(null)).toEqual({ byContext: {}, touched: {} });
  });
  it("copies one line", () => {
    expect(entryLine(toEntry({ text: "delete pod x failed", error: "forbidden", namespace: "ns" }, 1, 0))).toBe("1970-01-01T00:00:00.000Z delete pod x failed (ns) : forbidden");
  });
});
