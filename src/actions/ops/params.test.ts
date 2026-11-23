// The proposal seams of plan-features §2.10a: extra facts and a minimum tier for agent requests.
import { describe, expect, it } from "vitest";
import { withExtras } from "./ask";
import { effectiveTier } from "./tiers";

describe("ops dialog params for agent proposals", () => {
  it("raises the tier to minTier, never lowers it", () => {
    expect(effectiveTier(0, { protected: false, minTier: 1 })).toBe(1);
    expect(effectiveTier(2, { protected: false, minTier: 1 })).toBe(2);
    expect(effectiveTier(0, { protected: true, minTier: 1 })).toBe(2);
    expect(effectiveTier(0, { protected: false })).toBe(0);
  });

  it("appends extra facts and applies minTier in the dialog options", () => {
    const out = withExtras({
      tier: 1, title: "Restart", confirmLabel: "Restart",
      facts: [{ label: "context", value: "default" }],
      extraFacts: [{ label: "requested by", value: "claude-code" }],
      minTier: 2,
    });
    expect(out.tier).toBe(2);
    expect(out.facts?.map((f) => f.label)).toEqual(["context", "requested by"]);
    expect("extraFacts" in out || "minTier" in out).toBe(false);
    expect(withExtras({ tier: 1, title: "t", confirmLabel: "ok" }).facts).toBeUndefined();
  });
});
