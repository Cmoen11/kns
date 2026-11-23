import { describe, expect, it } from "vitest";
import { cellHeat, lastRestartSec, rowTint } from "./heat";

const err = { state: "error" as const, word: "CrashLoopBackOff" };
const warn = { state: "warn" as const, word: "Running" };
const ok = { state: "ok" as const, word: "Running" };

describe("heat", () => {
  it("reads the last restart", () => {
    expect(lastRestartSec("5 (2m ago)")).toBe(120);
    expect(lastRestartSec("3 (75s ago)")).toBe(75);
    expect(lastRestartSec("1 (2d3h ago)")).toBe(172800);
    expect(lastRestartSec("0")).toBeNull();
  });
  it("READY is hot only on a failing row", () => {
    expect(cellHeat("ready", "0/1", err)).toBe("error");
    expect(cellHeat("ready", "1/2", warn)).toBe("warn");
    expect(cellHeat("ready", "0/1", ok)).toBeUndefined();
    expect(cellHeat("ready", "1/1", err)).toBeUndefined();
  });
  it("RESTARTS: many or recent", () => {
    expect(cellHeat("restarts", "0", ok)).toBeUndefined();
    expect(cellHeat("restarts", "2", ok)).toBeUndefined();
    expect(cellHeat("restarts", "1 (3m ago)", ok)).toBe("warn");
    expect(cellHeat("restarts", "6 (2h ago)", ok)).toBe("warn");
    expect(cellHeat("restarts", "40 (1m ago)", err)).toBe("error");
  });
  it("tints failing rows that are not muted", () => {
    expect(rowTint(err, false)).toBe("error");
    expect(rowTint(warn, false)).toBe("warn");
    expect(rowTint(err, true)).toBeUndefined();
    expect(rowTint(ok, false)).toBeUndefined();
    expect(rowTint(null, false)).toBeUndefined();
  });
});
