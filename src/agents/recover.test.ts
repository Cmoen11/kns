// H3: requests an earlier page left `executing` are ended cleanly by the next page (against the
// mock, which follows Rust's rule: failed before the first step, approved with what ran after).
import { describe, expect, it } from "vitest";
import { mockBackend } from "../ipc/mock";
import { mockPropose } from "../ipc/mock/agents";
import { mockSaveDevSet } from "../ipc/mock/dev";
import { interrupted, recoverInterrupted } from "./recover";

const ref = { context: "default", gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "default", name: "web" };
const stateOf = async (id: string) => (await mockBackend.proposalsList()).find((p) => p.id === id);

describe("recovering requests left executing", () => {
  it("fails one approved before its first step and leaves open ones alone", async () => {
    await mockBackend.mcpPolicySet("default", "propose");
    const left = mockPropose("recover-a", { kind: "scale", ref, replicas: 2 });
    await mockBackend.proposalClaim(left.id);
    await mockBackend.proposalApprove(left.id, {});
    const open = mockPropose("recover-b", { kind: "restart", ref });
    const list = await mockBackend.proposalsList();
    expect(interrupted(list).map((p) => p.id)).toEqual([left.id]);
    expect(await recoverInterrupted(mockBackend, list)).toBe(1);
    const end = await stateOf(left.id);
    expect(end?.state).toBe("failed");
    expect(end?.result?.error?.reason).toBe("Interrupted");
    expect((await stateOf(open.id))?.state).toBe("pending");
    // nothing runs afterwards, and a second pass finds nothing
    await expect(mockBackend.scale(ref, 2, left.id)).rejects.toMatchObject({ reason: "Conflict" });
    expect(await recoverInterrupted(mockBackend, await mockBackend.proposalsList())).toBe(0);
  });

  it("ends one reloaded between its steps as approved with what ran", async () => {
    await mockBackend.mcpPolicySet("default", "propose");
    const set = mockSaveDevSet(
      { name: "recover-set", context: "default", forwards: [{ key: "ui", target: { kind: "service", namespace: "kafka", name: "kafka-ui" }, remotePort: 8080, localPort: 18181, pin: true }], rewrites: [], autoStart: false },
      { by: "agent", client: "recover-c", at: "t" },
    ).set;
    const p = mockPropose("recover-c", { kind: "devSetUp", devSet: set.id, hash: set.hash, exportEnv: { format: "dotenv" } });
    await mockBackend.proposalClaim(p.id);
    await mockBackend.proposalApprove(p.id, { shownHash: set.hash, owner: { by: "user" } });
    await mockBackend.devSetUp(set.id, set.hash, p.id);
    expect((await stateOf(p.id))?.state).toBe("executing");
    expect(await recoverInterrupted(mockBackend, await mockBackend.proposalsList())).toBe(1);
    const end = await stateOf(p.id);
    expect(end?.state).toBe("approved");
    const data = end?.result?.data as Record<string, { error?: { reason: string } }>;
    expect(data.up).toBeTruthy();
    expect(data.export?.error?.reason).toBe("Interrupted");
    expect(end?.result?.message).toContain('"export" did not run');
    await mockBackend.devSetDown(set.id).catch(() => {});
  });
});
