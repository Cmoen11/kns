// The R1 flow (docs/plan-features.md §5.7) end to end against the mock: the scripted agent drafts,
// saves and proposes; a "human" claims, approves with a ticked secret key, and the executor runs
// the steps through the mock gate. Then the refusals: a scale on a context whose policy is off, a
// save over the human's set, an agent-written override that points elsewhere, and Esc → pending.
import { describe, expect, it } from "vitest";
import { mockBackend } from "../ipc/mock";
import { mockMcpCallAsync, mockDemoSetup, mockPropose } from "../ipc/mock/agents";
import { mockSaveDevSet } from "../ipc/mock/dev";
import type { Json, Proposal, ProposalPayload } from "../ipc/types";
import { execute } from "./approve";
import { demoScript } from "./demo";

const C = "claude-code";
const call = (tool: string, args: Record<string, unknown> = {}) => mockMcpCallAsync(C, tool, args);

async function waitFor(pred: () => Promise<Proposal | undefined>): Promise<Proposal> {
  for (let i = 0; i < 200; i++) {
    const p = await pred();
    if (p) return p;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("the dev-config flow in the mock", () => {
  it("drafts, saves, proposes, and the approved steps run through the gate", async () => {
    await mockBackend.publishUiState({ context: "default", connected: ["default"], marked: [] });
    expect(await mockDemoSetup(C)).toContain("propose");
    const logs: string[] = [];
    const human = (async () => {
      const p = await waitFor(async () => (await mockBackend.proposalsList()).find((x) => x.state === "pending" && x.payload.kind === "devSetUp"));
      // Esc puts it back; then it is reviewed again and approved with one secret key ticked
      await mockBackend.proposalClaim(p.id);
      expect((await mockBackend.proposalUnclaim(p.id)).state).toBe("pending");
      await mockBackend.proposalClaim(p.id);
      const set = (await mockBackend.devSetsList()).find((s) => p.payload.kind === "devSetUp" && s.id === p.payload.devSet)!;
      // the typed workload name is required once a secret is ticked
      await expect(mockBackend.proposalApprove(p.id, { includeSecrets: ["DATABASE_URL"], shownHash: set.hash })).rejects.toMatchObject({ reason: "NeedsApproval" });
      const approved = await mockBackend.proposalApprove(p.id, { includeSecrets: ["DATABASE_URL"], typed: "orders", shownHash: set.hash, owner: { by: "user" } });
      return execute(approved);
    })();
    const out = await demoScript(call, async () => {}, (s) => logs.push(s));
    const end = await human;
    expect(out).toBe("approved");
    expect(end?.state).toBe("approved");
    const data = end?.result?.data as { up: { forwards: { key: string; localPort: number }[] }; export: { keys: number; secretKeys: number; path: string } };
    expect(data.up.forwards.map((f) => f.localPort)).toEqual([9094, 18081, 15432]);
    expect(data.export.secretKeys).toBe(1);
    expect(data.export.path).toContain(".env.kns");
    // result data never carries a value
    expect(JSON.stringify(end?.result)).not.toContain("s3cr3t");
    // forwards are the human's, requested by the agent
    const fwds = (await mockBackend.listForwards()).filter((f) => f.requestedBy === C);
    expect(fwds.length).toBe(3);
    expect(fwds.every((f) => f.owner.by === "user")).toBe(true);
    // the refusals at the end of the script
    expect(logs.some((l) => l.includes("propose_scale on staging: PolicyDenied"))).toBe(true);
    expect(logs.some((l) => l.includes("shop: NotOwner"))).toBe(true);
    // stop_dev_set: the agent may stop what its proposal started
    const set = (await mockBackend.devSetsList()).find((s) => s.name === "orders-agent")!;
    expect(await call("stop_dev_set", { id: set.id })).toMatchObject({ ok: true, data: { stopped: 3 } });
  });

  it("runs every proposal kind through its gated command", async () => {
    await mockBackend.mcpPolicySet("default", "propose");
    const ref = { context: "default", gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "default", name: "web" };
    const human = (await mockBackend.devSetsList()).find((s) => s.id === "ds-shop")!;
    const spare = mockSaveDevSet({ name: "spare-set", context: "default", forwards: [], rewrites: [], autoStart: false }, { by: "agent", client: "kinds", at: "t" }).set;
    const cases: { name: string; payload: ProposalPayload; data: (d: Record<string, unknown>) => void }[] = [
      { name: "forward", payload: { kind: "forward", context: "default", target: { kind: "service", namespace: "kafka", name: "kafka-ui" }, remotePort: 8080 }, data: (d) => expect(d.forward).toMatchObject({ address: "127.0.0.1" }) },
      { name: "envExport", payload: { kind: "envExport", spec: { workload: { gvr: ref.gvr, namespace: "shop", name: "orders" }, format: "posix" }, rewrites: [] }, data: (d) => expect(d.export).toMatchObject({ secretKeys: 0 }) },
      { name: "devSetDelete", payload: { kind: "devSetDelete", devSet: spare.id }, data: (d) => expect(d.delete).toEqual({ deleted: true }) },
      { name: "devSetUpdate", payload: { kind: "devSetUpdate", devSet: human.id, proposed: { ...human, forwards: human.forwards.slice(0, 1) } }, data: (d) => expect(d.update).toEqual({ set: human.id }) },
      { name: "scale", payload: { kind: "scale", ref, replicas: 2 }, data: (d) => expect(d.scale).toEqual({ ok: true }) },
      { name: "restart", payload: { kind: "restart", ref }, data: (d) => expect(d.restart).toEqual({ ok: true }) },
      { name: "delete", payload: { kind: "delete", ref: { ...ref, gvr: { group: "", version: "v1", resource: "pods" }, name: "web-1" } }, data: (d) => expect(d.delete).toEqual({ ok: true }) },
      { name: "reconcile", payload: { kind: "reconcile", ref: { ...ref, gvr: { group: "kustomize.toolkit.fluxcd.io", version: "v1", resource: "kustomizations" } }, withSource: false }, data: (d) => expect(d.reconcile).toEqual({ ok: true }) },
      { name: "apply", payload: { kind: "apply", context: "default", yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  namespace: default\n", parsed: { gvr: { group: "", version: "v1", resource: "configmaps" }, namespace: "default", name: "x", dryRun: "ok" } }, data: (d) => expect(d.apply).toEqual({ ok: true }) },
    ];
    for (const c of cases) {
      const p = mockPropose(`kinds-${c.name}`, c.payload);
      await mockBackend.proposalClaim(p.id);
      const approved = await mockBackend.proposalApprove(p.id, {});
      const end = await execute(approved, c.payload.kind === "devSetUpdate" ? { set: c.payload.proposed } : undefined);
      expect([c.name, end?.state]).toEqual([c.name, "approved"]);
      c.data((end?.result?.data ?? {}) as Record<string, unknown>);
    }
    // a step that does not match the approved payload ends the proposal failed
    const p = mockPropose("kinds-mismatch", { kind: "scale", ref, replicas: 2 });
    await mockBackend.proposalClaim(p.id);
    await mockBackend.proposalApprove(p.id, {});
    await expect(mockBackend.scale(ref, 9, p.id)).rejects.toMatchObject({ reason: "Invalid" });
    expect((await mockBackend.proposalsList()).find((x) => x.id === p.id)?.state).toBe("failed");
  });

  it("refuses overrides that point elsewhere, human-only fields and sets of others", async () => {
    const draft = await call("draft_dev_set_from_workload", { ref: { kind: "deployments", namespace: "shop", name: "orders" }, name: "other-dev" });
    expect(draft.ok).toBe(true);
    const set = (draft as unknown as { data: { set: Record<string, Json> } }).data.set;
    const env = set.env as Record<string, Json>;
    const evil = { ...set, env: { ...env, overrides: [{ key: "DATABASE_URL", value: "postgres://u@evil:5432/x" }] } };
    expect(await call("save_dev_set", { set: evil })).toMatchObject({ ok: false, error: { code: "Invalid" } });
    expect(await call("save_dev_set", { set: { ...set, autoStart: true } })).toMatchObject({ ok: false, error: { code: "Invalid" } });
    expect(await call("save_dev_set", { set: { ...set, env: { ...env, includeSecrets: ["DATABASE_URL"] } } })).toMatchObject({ ok: false, error: { code: "Invalid" } });
    // a change to the human's set becomes a proposal only when asked
    const human = { ...set, id: "ds-shop", name: "shop" };
    expect(await call("save_dev_set", { set: human })).toMatchObject({ ok: false, error: { code: "NotOwner" } });
    const asked = await call("save_dev_set", { set: human, asProposal: true, reason: "add schema-registry" });
    expect(asked).toMatchObject({ ok: true, data: { proposal: { state: "pending", kind: "devSetUpdate" } } });
    // one waiting proposal per client
    expect(await call("propose_forward", { target: { kind: "service", namespace: "kafka", name: "kafka" }, remotePort: 9094 })).toMatchObject({ ok: false, error: { code: "RateLimited" } });
    const id = (asked as unknown as { data: { proposal: { id: string } } }).data.proposal.id;
    expect(await call("cancel_proposal", { id })).toMatchObject({ ok: true, data: { proposal: { state: "cancelled" } } });
  });
});
