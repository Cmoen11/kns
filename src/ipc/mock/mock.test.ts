// The feature mocks (docs/plan-features.md §2.11): event bus, proposal state machine, dev-set rules,
// the dev-only __knsMock guard and the mock redactor.
import { describe, expect, it } from "vitest";
import { mockBackend } from "../mock";
import type { BackendEvent, Proposal, ProposalPayload } from "../types";
import { mockPropose } from "./agents";
import { mockDevSet, mockSaveDevSet } from "./dev";
import { shouldInstallKnsMock } from "./devtools";
import { emitMock } from "./events";
import { mockRedact } from "./pack";
import { mockState } from "./shared";

const scaleOn = (context: string, name: string): ProposalPayload => ({
  kind: "scale",
  ref: { context, gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "default", name },
  replicas: 2,
});

describe("mock event bus", () => {
  it("delivers emitted events to onEvent subscribers until unsubscribed", async () => {
    const got: BackendEvent[] = [];
    const off = mockBackend.onEvent((e) => got.push(e));
    emitMock({ type: "forwards" });
    await Promise.resolve();
    off();
    emitMock({ type: "forwards" });
    await Promise.resolve();
    expect(got).toEqual([{ type: "forwards" }]);
  });
});

describe("mock proposals", () => {
  // approving needs the agent policy "propose" (as in Rust)
  const allow = async () => {
    await mockBackend.mcpPolicySet("default", "propose");
    await mockBackend.mcpPolicySet("staging", "propose");
  };

  it("runs pending -> reviewing -> pending -> reviewing -> executing -> approved", async () => {
    await allow();
    const p = mockPropose("agent-a", scaleOn("default", "web"), "scale ‮web​ up");
    expect(p.state).toBe("pending");
    expect(p.reason).toBe("scale web up");
    expect((await mockBackend.proposalClaim(p.id)).state).toBe("reviewing");
    expect((await mockBackend.proposalUnclaim(p.id)).state).toBe("pending");
    await mockBackend.proposalClaim(p.id);
    expect((await mockBackend.proposalApprove(p.id, {})).state).toBe("executing");
    // like Rust: "done" before the step ran is refused; the gated step ends the proposal
    await expect(mockBackend.proposalResolve(p.id, { kind: "done", ok: true })).rejects.toMatchObject({ reason: "Conflict" });
    if (p.payload.kind !== "scale") throw new Error("scale");
    await mockBackend.scale(p.payload.ref, 2, p.id);
    const done = (await mockBackend.proposalsList()).find((x) => x.id === p.id);
    expect(done?.state).toBe("approved");
  });

  it("allows one waiting proposal per client", () => {
    mockPropose("agent-b", scaleOn("default", "api"));
    expect(() => mockPropose("agent-b", scaleOn("default", "api"))).toThrow(expect.objectContaining({ reason: "RateLimited" }) as Error);
  });

  it("asks for the typed context name on a protected context", async () => {
    await allow();
    const p = mockPropose("agent-c", scaleOn("staging", "api"));
    await mockBackend.proposalClaim(p.id);
    await expect(mockBackend.proposalApprove(p.id, {})).rejects.toMatchObject({ reason: "NeedsApproval" });
    expect((await mockBackend.proposalApprove(p.id, { typed: "staging" })).state).toBe("executing");
  });

  it("refuses to approve an unclaimed proposal and records a rejection", async () => {
    const p = mockPropose("agent-d", scaleOn("default", "worker"));
    await expect(mockBackend.proposalApprove(p.id, {})).rejects.toMatchObject({ reason: "Conflict" });
    const r: Proposal = await mockBackend.proposalResolve(p.id, { kind: "rejected", reason: "not now" });
    expect(r.state).toBe("rejected");
  });

  it("expires a dev-set proposal whose set changed while shown", async () => {
    const set = mockDevSet("ds-orders-dev");
    expect(set).toBeDefined();
    const p = mockPropose("agent-e", { kind: "devSetUp", devSet: "ds-orders-dev", hash: set?.hash ?? "" });
    await mockBackend.proposalClaim(p.id);
    await expect(mockBackend.proposalApprove(p.id, { shownHash: "stale" })).rejects.toMatchObject({ reason: "NeedsApproval" });
    expect((await mockBackend.proposalsList()).find((x) => x.id === p.id)?.state).toBe("expired");
  });

  it("reads the context flags the UI saved (read-only blocks approval)", async () => {
    mockState.set("settings", { schema: 1, data: { contexts: { default: { protected: false, readOnly: true } } } });
    try {
      const p = mockPropose("agent-g", scaleOn("default", "proxy"));
      await mockBackend.proposalClaim(p.id);
      await expect(mockBackend.proposalApprove(p.id, {})).rejects.toMatchObject({ reason: "PolicyDenied" });
    } finally {
      mockState.delete("settings");
    }
  });

  it("cancels a client's waiting proposals when its token is revoked", async () => {
    const p = mockPropose("agent-f", scaleOn("default", "checkout"));
    await mockBackend.mcpClientRevoke("agent-f");
    expect((await mockBackend.proposalsList()).find((x) => x.id === p.id)?.state).toBe("cancelled");
  });
});

describe("mock dev sets", () => {
  it("refuses an agent update of a human set and strips human-only fields", () => {
    const human = mockDevSet("ds-shop");
    expect(human).toBeDefined();
    const draft = { id: human?.id, name: "shop", context: "default", forwards: [], rewrites: [], autoStart: true };
    expect(() => mockSaveDevSet(draft, { by: "agent", client: "claude-code", at: "now" })).toThrow(expect.objectContaining({ reason: "NotOwner" }) as Error);
    const { set } = mockSaveDevSet({ ...draft, id: undefined, name: "copy", connSecrets: [] }, { by: "agent", client: "claude-code", at: "now" });
    expect(set.autoStart).toBe(false);
    expect(set.connSecrets).toBeUndefined();
    expect(set.approvedHash).toBeUndefined();
  });

  it("refuses to start a set whose shown hash is stale", async () => {
    await expect(mockBackend.devSetUp("ds-shop", "stale")).rejects.toMatchObject({ reason: "NeedsApproval" });
    const set = mockDevSet("ds-shop");
    const started = await mockBackend.devSetUp("ds-shop", set?.hash ?? "");
    expect(started.map((f) => f.localPort)).toEqual([9094, 15432]);
    await mockBackend.devSetDown("ds-shop");
  });

  it("checks the typed workload name of a protected context's export (like Rust)", async () => {
    const workload = { gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "default", name: "web" };
    const req = { spec: { workload, format: "dotenv" as const }, context: "staging", rewrites: [], destination: "clipboard" as const };
    await expect(mockBackend.envExport(req)).rejects.toMatchObject({ reason: "ConfirmText" });
    await expect(mockBackend.envExport({ ...req, confirmText: "staging" })).rejects.toMatchObject({ reason: "ConfirmText" });
    await expect(mockBackend.envExport({ ...req, confirmText: "web" })).resolves.toMatchObject({ clearSeconds: 60 });
    await expect(mockBackend.envExport({ ...req, context: "default" })).resolves.toMatchObject({ clearSeconds: 60 });
  });
});

describe("__knsMock guard", () => {
  it("installs only in a dev build outside Tauri", () => {
    expect(shouldInstallKnsMock(true, false)).toBe(true);
    expect(shouldInstallKnsMock(false, false)).toBe(false);
    expect(shouldInstallKnsMock(true, true)).toBe(false);
    expect(shouldInstallKnsMock(false, true)).toBe(false);
  });
});

describe("mock redactor", () => {
  it("masks key lines, URL userinfo, bearer tokens and flags", () => {
    const { text, redactions } = mockRedact(
      "DB_PASSWORD: hunter2\nurl: postgres://app:pw1@db:5432/app\nAuthorization: Bearer abcdefgh12345\nargs: --db-password=x1y2",
    );
    for (const secret of ["hunter2", "pw1", "abcdefgh12345", "x1y2"]) expect(text).not.toContain(secret);
    expect(redactions.count).toBe(4);
  });
});
