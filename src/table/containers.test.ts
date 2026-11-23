import { describe, expect, it } from "vitest";
import { containerRows, crashCells, exitLabel, exitMeaning, lastCrash, signalOf } from "./containers";

const NOW = Date.parse("2026-11-22T10:05:00Z");

describe("exit-code table (crash card)", () => {
  it("names the common codes", () => {
    expect(exitMeaning(0)).toBe("exited normally");
    expect(exitMeaning(1)).toBe("application error");
    expect(exitMeaning(2)).toContain("bad arguments");
    expect(exitMeaning(126)).toContain("not executable");
    expect(exitMeaning(127)).toContain("command not found");
    expect(exitMeaning(137)).toMatch(/^SIGKILL/);
    expect(exitMeaning(139)).toMatch(/^SIGSEGV/);
    expect(exitMeaning(143)).toMatch(/^SIGTERM/);
  });
  it("128+n is signal n", () => {
    expect(signalOf(130)).toBe("SIGINT");
    expect(signalOf(134)).toBe("SIGABRT");
    expect(signalOf(137)).toBe("SIGKILL");
    expect(signalOf(150)).toBe("signal 22");
    expect(signalOf(128)).toBeUndefined();
    expect(signalOf(1)).toBeUndefined();
    expect(exitMeaning(134)).toBe("killed by SIGABRT");
    expect(exitMeaning(3)).toBe("application-defined exit code");
    expect(exitMeaning(-1)).toBe("container runtime error");
  });
  it("LAST prefers a specific reason, then the signal", () => {
    expect(exitLabel(137, "OOMKilled")).toBe("137 OOMKilled");
    expect(exitLabel(143, "Error")).toBe("143 SIGTERM");
    expect(exitLabel(1, "Error")).toBe("1 Error");
    expect(exitLabel(1)).toBe("1 Error");
    expect(exitLabel(139)).toBe("139 SIGSEGV");
    expect(exitLabel(0, "Completed")).toBe("0 Completed");
  });
});

describe("lastCrash / crashCells", () => {
  const oom = {
    restartCount: 3,
    state: { running: { startedAt: "2026-11-22T10:01:00Z" } },
    lastState: { terminated: { exitCode: 137, reason: "OOMKilled", startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:00:41Z" } },
  };
  it("reads lastState: 137 OOMKilled, lived 41s, died 4m19s ago", () => {
    expect(lastCrash(oom)).toEqual({ code: 137, reason: "OOMKilled", lived: 41, finishedAt: "2026-11-22T10:00:41Z" });
    expect(crashCells(oom, NOW)).toEqual(["137 OOMKilled", "41s", "4m19s"]);
  });
  it("a failed current termination counts; a clean exit does not", () => {
    const failed = { state: { terminated: { exitCode: 1, reason: "Error", startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:00:03Z" } } };
    expect(crashCells(failed, NOW)).toEqual(["1 Error", "3s", "4m57s"]);
    expect(lastCrash({ state: { terminated: { exitCode: 0, reason: "Completed" } } })).toBeUndefined();
    expect(lastCrash({ state: { running: {} } })).toBeUndefined();
    expect(lastCrash(undefined)).toBeUndefined();
  });
  it("missing timestamps leave LIVED and DIED empty", () => {
    expect(crashCells({ lastState: { terminated: { exitCode: 139 } } }, NOW)).toEqual(["139 SIGSEGV", "", ""]);
  });
  it("containerRows appends LAST, LIVED, DIED", () => {
    const rows = containerRows(
      { spec: { containers: [{ name: "main", image: "busybox" }] }, status: { containerStatuses: [{ name: "main", ready: true, ...oom }] } },
      NOW,
    );
    expect(rows[0].cells.slice(-3)).toEqual(["137 OOMKilled", "41s", "4m19s"]);
  });
});
