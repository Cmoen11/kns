import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../ipc/types";
import { indicatorText, parseUpdateArgs, statusText } from "./model";

const s = (o: Partial<UpdateStatus>): UpdateStatus => ({ state: "idle", current: "0.1.0", ...o });

describe("update model", () => {
  it("parses :update", () => {
    expect(parseUpdateArgs([])).toEqual({ kind: "default" });
    expect(parseUpdateArgs(["check"])).toEqual({ kind: "check" });
    expect(parseUpdateArgs(["install"])).toEqual({ kind: "install" });
    expect(parseUpdateArgs(["now"]).kind).toBe("error");
    expect(parseUpdateArgs(["check", "x"]).kind).toBe("error");
  });

  it("shows the bottom-row item only when a version is ready or installing", () => {
    expect(indicatorText(null)).toBeNull();
    expect(indicatorText(s({ state: "downloading", version: "0.2.0", progress: 10 }))).toBeNull();
    expect(indicatorText(s({ state: "ready", version: "0.2.0" }))).toBe("update 0.2.0");
    expect(indicatorText(s({ state: "installing", version: "0.2.0" }))).toBe("updating to 0.2.0…");
  });

  it("describes each state", () => {
    expect(statusText(s({ state: "disabled", message: "development build" }))).toBe("kns 0.1.0 · does not update itself (development build)");
    expect(statusText(s({ checkedAt: "2026-11-23T10:00:00Z" }))).toBe("kns 0.1.0 is up to date");
    expect(statusText(s({ state: "ready", version: "0.2.0" }))).toContain(":update install");
    expect(statusText(s({ state: "error", message: "offline" }))).toBe("kns 0.1.0 · update check failed: offline");
  });
});
