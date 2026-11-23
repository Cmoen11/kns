import { describe, expect, it } from "vitest";
import type { Proposal } from "../../ipc/types";
import { isRequestedKind, requestedSpec } from "./requested";

const DEPLOY = { group: "apps", version: "v1", resource: "deployments" };
const p = (payload: Proposal["payload"], context = "default"): Proposal => ({ id: "p1", client: "claude-code", context, createdAt: "", expiresAt: "", state: "reviewing", payload });
const ref = (context = "default") => ({ context, gvr: DEPLOY, namespace: "default", name: "web" });
const extraFacts = [{ label: "requested by", value: "claude-code" }];

describe("agent-requested writes", () => {
  it("are at least tier 1, and carry the requested-by fact after the object facts", () => {
    const restart = p({ kind: "restart", ref: ref() });
    if (!isRequestedKind(restart.payload)) throw new Error("kind");
    const s = requestedSpec({ ...restart, payload: restart.payload }, { protected: false, extraFacts });
    expect(s.tier).toBe(1);
    expect(s.typeToConfirm).toBeUndefined();
    expect(s.facts[s.facts.length - 1]).toEqual(extraFacts[0]);
    expect(s.confirmLabel).toBe("Restart");
  });

  it("type the context name on a protected context (what Rust checks)", () => {
    const scale = p({ kind: "scale", ref: ref("staging"), replicas: 3 }, "staging");
    if (!isRequestedKind(scale.payload)) throw new Error("kind");
    const s = requestedSpec({ ...scale, payload: scale.payload }, { protected: true, extraFacts });
    expect(s.tier).toBe(2);
    expect(s.typeToConfirm).toBe("staging");
    expect(s.body).toContain("3");
  });

  it("keep the manual delete tier elsewhere", () => {
    const del = p({ kind: "delete", ref: ref() });
    if (!isRequestedKind(del.payload)) throw new Error("kind");
    const s = requestedSpec({ ...del, payload: del.payload }, { protected: false, extraFacts });
    expect(s.tier).toBe(2);
    expect(s.typeToConfirm).toBe("web");
    expect(isRequestedKind({ kind: "devSetDelete", devSet: "x" })).toBe(false);
  });
});
