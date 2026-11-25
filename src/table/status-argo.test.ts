import { describe, expect, it } from "vitest";
import { statusColumnId } from "./columns";
import { argoStatus, deriveStatus, isFault } from "./status";

describe("Argo CD Applications (SYNC STATUS + HEALTH STATUS)", () => {
  const app = (health: string, sync: string) =>
    deriveStatus({ resource: "applications", ageSec: 9999, get: (c) => (c === "health status" ? health : c === "sync status" ? sync : undefined) });

  it("puts health first, then sync", () => {
    expect(app("Healthy", "Synced")).toEqual({ state: "ok", word: "Healthy" });
    expect(app("Degraded", "Synced")).toEqual({ state: "error", word: "Degraded" });
    expect(app("Missing", "OutOfSync")).toEqual({ state: "error", word: "Missing" });
    expect(app("Progressing", "OutOfSync")).toEqual({ state: "progress", word: "Progressing" });
    expect(app("Suspended", "Synced")).toEqual({ state: "suspended", word: "Suspended" });
    expect(app("Healthy", "OutOfSync")).toEqual({ state: "warn", word: "OutOfSync" });
    expect(app("Healthy", "Unknown")).toEqual({ state: "warn", word: "Sync unknown" });
  });

  it("is a fault when out of sync or unhealthy", () => {
    expect(isFault(app("Healthy", "OutOfSync"))).toBe(true);
    expect(isFault(app("Degraded", "Synced"))).toBe(true);
    expect(isFault(argoStatus("Healthy", "Synced"))).toBe(false);
  });

  it("puts the status cell on HEALTH STATUS when both columns are there", () => {
    expect(statusColumnId("applications", false, ["name", "sync status", "health status"])).toBe("health status");
    expect(statusColumnId("widgets", false, ["name", "health status"])).toBeNull();
  });
});
