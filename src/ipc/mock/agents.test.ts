// The mock MCP server follows the Rust rules closely enough for the agents UI: server off, unknown
// client, policy off / read / propose, not connected, namespace allowlist, audit and status.
import { describe, expect, it } from "vitest";
import { agentsMock, mockMcpCall } from "./agents";

describe("mock MCP server", () => {
  it("runs the rules and records calls", async () => {
    expect(mockMcpCall("claude-code", "get_status")).toMatchObject({ ok: false, error: { code: "Unavailable" } });
    await agentsMock.mcpSetEnabled(true);
    expect(mockMcpCall("claude-code", "get_status")).toMatchObject({ ok: false, error: { code: "Unauthorized" } });
    expect(await agentsMock.mcpClientAdd("claude-code")).toEqual({ copied: true, excluded: true });
    await expect(agentsMock.mcpClientAdd("bad name")).rejects.toMatchObject({ reason: "Invalid" });

    const ref = (ns: string, name: string) => ({ context: "default", gvr: { group: "", version: "v1", resource: "pods" }, namespace: ns, name });
    await agentsMock.publishUiState({ context: "default", connected: [], cursor: ref("kafka", "k"), marked: [ref("kns-spike", "a")] });
    const st = mockMcpCall("claude-code", "get_status");
    expect(st.ok && st.data).toMatchObject({ contexts: [], hiddenContexts: 1 });
    expect(mockMcpCall("claude-code", "get_selection")).toMatchObject({ ok: false, error: { code: "PolicyDenied" } });

    await agentsMock.mcpPolicySet("default", "read", ["kns-spike"]);
    expect(mockMcpCall("claude-code", "get_selection")).toMatchObject({ ok: false, error: { code: "NotConnected" } });
    await agentsMock.publishUiState({ context: "default", connected: ["default"], cursor: ref("kafka", "k"), marked: [ref("kns-spike", "a")] });
    const sel = mockMcpCall("claude-code", "get_selection");
    expect(sel.ok && sel.data).toMatchObject({ context: "default", cursor: null, marked: [{ name: "a" }] });

    const s = await agentsMock.mcpStatus();
    expect(s.on).toBe(true);
    expect(s.tools.length).toBeGreaterThan(10);
    expect(s.policies).toEqual([{ context: "default", policy: "read", namespaces: ["kns-spike"] }]);
    expect(s.clients[0]).toMatchObject({ name: "claude-code", connected: true });
    expect(s.clients[0].calls).toBeGreaterThanOrEqual(4);

    const audit = await agentsMock.mcpAuditTail(50);
    expect(audit[0]).toMatchObject({ client: "claude-code", tool: "get_selection", outcome: "ok" });
    expect(audit.some((r) => r.outcome === "denied")).toBe(true);
    expect(audit.some((r) => r.tool === "token added")).toBe(true);

    await agentsMock.mcpClientRevoke("claude-code");
    expect(mockMcpCall("claude-code", "get_status")).toMatchObject({ ok: false, error: { code: "Unauthorized" } });
    await expect(agentsMock.mcpClientRevoke("claude-code")).rejects.toMatchObject({ code: 404 });
  });

  it("reports a taken port instead of starting", async () => {
    await agentsMock.mcpSetEnabled(false);
    await agentsMock.mcpSetPort(7100);
    const s = await agentsMock.mcpSetEnabled(true);
    expect(s.on).toBe(false);
    expect(s.error).toContain("7100");
    await agentsMock.mcpSetPort(7099);
    expect((await agentsMock.mcpSetEnabled(true)).on).toBe(true);
    await expect(agentsMock.mcpSetPort(80)).rejects.toMatchObject({ reason: "Invalid" });
  });
});
