// Contract drift (docs/plan-features.md §2.1). The fixtures in ./__fixtures__ are written by
// `cargo test` from the Rust contract types and each value is checked against the TS types with
// `satisfies` by `pnpm typecheck` (literal unions, missing and excess fields). This test makes sure
// every contract module has its fixture file and that the files are well-formed.
import { describe, expect, it } from "vitest";

const fixtures = import.meta.glob<Record<string, unknown>>("./__fixtures__/*.ts", { eager: true });
const contracts = Object.keys(import.meta.glob("./*.ts")).filter((p) => !p.endsWith(".test.ts") && !p.endsWith("/index.ts"));

describe("contract drift fixtures", () => {
  it("exist for every contract module", () => {
    const have = Object.keys(fixtures).map((p) => p.replace("./__fixtures__/", "./"));
    expect(contracts.filter((c) => !have.includes(c))).toEqual([]);
  });

  it("export at least one non-empty value per file", () => {
    for (const [path, mod] of Object.entries(fixtures)) {
      const values = Object.values(mod);
      expect(values.length, path).toBeGreaterThan(0);
      for (const v of values) expect(v, path).not.toBeNull();
    }
  });

  it("carry every ForwardTarget kind and both PortRef forms", async () => {
    const fwd = await import("./__fixtures__/fwd");
    expect(fwd.forwardTargets.map((t) => t.kind).sort()).toEqual(["pod", "service", "workload"]);
    expect(fwd.portRefs.map((p) => typeof p).sort()).toEqual(["number", "string"]);
  });

  it("carry every ProposalPayload kind and BackendEvent type", async () => {
    const agents = await import("./__fixtures__/agents");
    const events = await import("./__fixtures__/events");
    expect(new Set(agents.payloads.map((p) => p.kind)).size).toBe(10);
    expect(new Set(events.events.map((e) => e.type)).size).toBe(9);
  });
});
