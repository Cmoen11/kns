import { describe, expect, it } from "vitest";
import type { AuditRow, McpStatus } from "../ipc/types";
import { auditCells, auditGlyph, buildUiState, bytes, clientDetail, parseMcpArgs, policyContexts, policyOf, policyText, sameUiState, statusLine } from "./model";

const status = (over: Partial<McpStatus> = {}): McpStatus => ({ on: false, port: 7099, clients: [], tools: [], policies: [], ...over });
const client = (name: string, connected = false) => ({ name, createdAt: "2026-11-22T10:00:00Z", connected, calls: 3, bytes: 2048, redactions: 1, lastUsedAt: "2026-11-22T10:01:00Z" });

describe(":mcp words", () => {
  it("parses every verb", () => {
    expect(parseMcpArgs([])).toEqual({ kind: "setup" });
    for (const v of ["on", "off", "setup", "status", "demo"] as const) expect(parseMcpArgs([v])).toEqual({ kind: v });
    expect(parseMcpArgs(["add", "claude-code"])).toEqual({ kind: "add", name: "claude-code" });
    expect(parseMcpArgs(["revoke", "cursor.1"])).toEqual({ kind: "revoke", name: "cursor.1" });
    expect(parseMcpArgs(["port", "7100"])).toEqual({ kind: "port", port: 7100 });
    expect(parseMcpArgs(["policy", "propose"])).toEqual({ kind: "policy", policy: "propose" });
    expect(parseMcpArgs(["policy", "read", "staging", "kns-spike,shop"])).toEqual({ kind: "policy", policy: "read", context: "staging", namespaces: ["kns-spike", "shop"] });
  });

  it("refuses bad input with a usage line", () => {
    for (const bad of [["on", "x"], ["add"], ["add", "a b"], ["add", "ø"], ["port", "80"], ["port", "x"], ["policy", "write"], ["policy", "read", "c", "Bad_NS"], ["nope"]]) {
      const r = parseMcpArgs(bad);
      expect(r.kind, bad.join(" ")).toBe("error");
    }
  });
});

describe("status line", () => {
  it("off, on, connected, error", () => {
    expect(statusLine(null)).toBeNull();
    expect(statusLine(status())).toEqual({ text: "off", state: "off" });
    expect(statusLine(status({ on: true, clients: [client("a")] }))).toEqual({ text: "on · 127.0.0.1:7099 · 1 client", state: "ok" });
    expect(statusLine(status({ on: true, clients: [client("a", true), client("b")] }))).toEqual({ text: "on · 127.0.0.1:7099 · 1 client connected", state: "active" });
    expect(statusLine(status({ error: "port 7099 is in use" }))?.state).toBe("warn");
  });
});

describe("rows", () => {
  it("formats clients, policies and audit", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2.0 KB");
    expect(bytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(clientDetail(client("a", true), () => "10:01")).toBe("connected · 3 calls · 2.0 KB · redacted 1 · used 10:01");
    expect(policyText("read", ["a", "b"])).toBe("read · namespaces a, b");
    const s = status({ policies: [{ context: "zeta", policy: "read" }] });
    expect(policyOf(s, "zeta").policy).toBe("read");
    expect(policyOf(s, "default").policy).toBe("off");
    expect(policyContexts(["default", "staging"], s)).toEqual(["default", "staging", "zeta"]);
    const row: AuditRow = { ts: "t", client: "claude-code", tool: "get_logs", resultBytes: 2048, redactions: 2, outcome: "denied", ms: 12 };
    expect(auditCells(row, () => "10:00:00")).toEqual(["10:00:00  claude-code  get_logs", "denied · 12 ms · 2.0 KB · redacted 2"]);
    expect(auditGlyph(row)).toBe("warn");
    expect(auditCells({ ...row, resultBytes: 0, ms: 0, redactions: 0, outcome: "ok", tool: "token added" }, () => "x")[1]).toBe("ok");
  });
});

describe("ui state", () => {
  const ref = (name: string) => ({ context: "default", gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name });
  it("caps and drops empty fields", () => {
    const s = buildUiState({ context: "default", connected: ["default"], pane: { kind: "table", title: "x".repeat(500) }, cursor: ref("crashy"), marked: Array.from({ length: 300 }, (_, i) => ref(`p${i}`)) });
    expect(s.marked).toHaveLength(200);
    expect(s.pane?.title).toHaveLength(200);
    expect(s.connected).toEqual(["default"]);
    expect("filter" in s).toBe(false);
    const empty = buildUiState({ context: null, connected: [], pane: null, cursor: null, marked: [] });
    expect(empty).toEqual({ marked: [], connected: [] });
    expect(sameUiState(null, empty)).toBe(false);
    expect(sameUiState(buildUiState({ context: null, connected: [], pane: null, cursor: null, marked: [] }), empty)).toBe(true);
  });
});
