import { describe, expect, it } from "vitest";
import { compareStamps, formatClock, parseStamp, sinceSecondsFrom } from "./time";

describe("timestamps", () => {
  it("parses RFC3339Nano with sub-millisecond precision", () => {
    const s = parseStamp("2024-03-10T12:34:56.123456789Z")!;
    expect(s.ms).toBe(Date.UTC(2024, 2, 10, 12, 34, 56, 123));
    expect(s.sub).toBe(456789);
    expect(parseStamp("2024-03-10T12:34:56Z")).toEqual({ ms: Date.UTC(2024, 2, 10, 12, 34, 56), sub: 0 });
    expect(parseStamp("2024-03-10T12:34:56.5Z")?.ms).toBe(Date.UTC(2024, 2, 10, 12, 34, 56, 500));
  });

  it("applies a zone offset", () => {
    expect(parseStamp("2024-03-10T14:34:56+02:00")?.ms).toBe(Date.UTC(2024, 2, 10, 12, 34, 56));
    expect(parseStamp("2024-03-10T07:04:56-05:30")?.ms).toBe(Date.UTC(2024, 2, 10, 12, 34, 56));
  });

  it("rejects what is not a timestamp", () => {
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("yesterday")).toBeNull();
    expect(parseStamp("2024-03-10")).toBeNull();
  });

  it("orders stamps by millisecond, then by the nanoseconds below it", () => {
    const a = parseStamp("2024-03-10T12:34:56.123000001Z")!;
    const b = parseStamp("2024-03-10T12:34:56.123000002Z")!;
    const c = parseStamp("2024-03-10T12:34:56.124Z")!;
    expect(compareStamps(a, b)).toBeLessThan(0);
    expect(compareStamps(b, a)).toBeGreaterThan(0);
    expect(compareStamps(a, a)).toBe(0);
    expect(compareStamps(b, c)).toBeLessThan(0);
  });

  it("formats the local clock for a given offset", () => {
    const ms = Date.UTC(2024, 2, 10, 23, 5, 9, 7);
    expect(formatClock(ms, { offsetMinutes: 0 })).toBe("23:05:09.007");
    expect(formatClock(ms, { offsetMinutes: 60 })).toBe("00:05:09.007");
    expect(formatClock(ms, { offsetMinutes: -330 })).toBe("17:35:09.007");
    expect(formatClock(ms, { offsetMinutes: 120, millis: false })).toBe("01:05:09");
    expect(formatClock(NaN, { offsetMinutes: 0 })).toBe("--:--:--.---");
  });

  it("uses the machine's zone by default", () => {
    const ms = Date.UTC(2024, 5, 1, 12, 0, 0, 0);
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(formatClock(ms, { millis: false })).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
  });

  it("asks for a reattach window that overlaps the last line", () => {
    expect(sinceSecondsFrom(10_000, 10_000)).toBe(1);
    expect(sinceSecondsFrom(10_000, 12_500)).toBe(4);
    expect(sinceSecondsFrom(10_000, 9_000)).toBe(1);
  });
});
