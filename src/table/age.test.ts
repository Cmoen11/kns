import { describe, expect, it } from "vitest";
import { ageSeconds, formatAge, parseAge, tickPeriodMs } from "./age";

describe("formatAge (kubectl HumanDuration)", () => {
  it.each([
    [0, "0s"], [45, "45s"], [119, "119s"], [120, "2m"], [150, "2m30s"], [599, "9m59s"], [600, "10m"], [3 * 3600 - 1, "179m"],
    [3 * 3600, "3h"], [3 * 3600 + 12 * 60, "3h12m"], [8 * 3600, "8h"], [47 * 3600, "47h"], [48 * 3600, "2d"],
    [2 * 86400 + 4 * 3600, "2d4h"], [8 * 86400, "8d"], [400 * 86400, "400d"], [2 * 365 * 86400, "2y"],
    [2 * 365 * 86400 + 30 * 86400, "2y30d"], [9 * 365 * 86400, "9y"],
  ])("%d -> %s", (sec, text) => expect(formatAge(sec)).toBe(text));

  it("clamps negatives (clock skew) and rejects NaN", () => {
    expect(formatAge(-5)).toBe("0s");
    expect(formatAge(Number.NaN)).toBe("");
  });
});

describe("ageSeconds / parseAge", () => {
  it("computes from an RFC3339 timestamp", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(ageSeconds("2026-01-01T00:00:00Z", now)).toBe(60);
    expect(ageSeconds(undefined, now)).toBeNull();
    expect(ageSeconds("nope", now)).toBeNull();
    expect(ageSeconds("2026-01-01T00:02:00Z", now)).toBe(0);
  });
  it("parses what formatAge prints", () => {
    for (const s of [0, 45, 150, 3 * 3600 + 720, 2 * 86400 + 4 * 3600, 400 * 86400]) expect(parseAge(formatAge(s))).toBe(s);
    expect(parseAge("12s")).toBe(12);
    expect(parseAge("abc")).toBeNull();
    expect(parseAge("5m ago")).toBeNull();
    expect(parseAge("")).toBeNull();
  });
  it("ticks every second only while seconds are on screen", () => {
    expect(tickPeriodMs(30)).toBe(1000);
    expect(tickPeriodMs(3600)).toBe(30000);
    expect(tickPeriodMs(null)).toBe(30000);
  });
});
