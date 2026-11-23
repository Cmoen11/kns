import { describe, expect, it } from "vitest";
import type { Proposal, ProposalPayload } from "../ipc/types";
import { approvalTier, arrivals, askText, draftOfProposed, expectedTyped, exportSecretKeys, finished, isOpen, isWaiting, nextToReview, requestedBy, resultText, titleText, waitingCount } from "./proposal-model";

const DEPLOY = { group: "apps", version: "v1", resource: "deployments" };
const prop = (payload: ProposalPayload, over: Partial<Proposal> = {}): Proposal => ({
  id: "p1",
  client: "claude-code",
  context: "default",
  createdAt: "2026-11-22T10:00:00Z",
  expiresAt: "2026-11-22T10:10:00Z",
  state: "pending",
  payload,
  ...over,
});
const up: ProposalPayload = { kind: "devSetUp", devSet: "ds-1", hash: "h", exportEnv: { format: "dotenv" } };
const exportP: ProposalPayload = { kind: "envExport", spec: { workload: { gvr: DEPLOY, namespace: "shop", name: "orders" }, format: "dotenv" }, rewrites: [] };

describe("proposal model", () => {
  it("says what the agent asks for, with set names and cleaned client names", () => {
    expect(askText(up, (id) => (id === "ds-1" ? "orders-dev" : undefined))).toBe("start dev set orders-dev and export its env");
    expect(askText({ kind: "forward", context: "default", target: { kind: "service", namespace: "kafka", name: "kafka" }, remotePort: 9094 })).toBe("forward svc/kafka:9094");
    expect(askText({ kind: "scale", ref: { context: "default", gvr: DEPLOY, namespace: "default", name: "web" }, replicas: 3 })).toBe("scale deployments/default/web to 3");
    expect(titleText(prop(up, { client: "claude\u202E-code" }))).toBe("claude-code asks to start dev set ds-1 and export its env");
  });

  it("expects the typed text Rust expects", () => {
    const p = prop(up);
    expect(expectedTyped(p, { protected: false, includeSecrets: [] })).toBeNull();
    expect(expectedTyped(p, { protected: true, includeSecrets: [] })).toBe("default");
    expect(expectedTyped(p, { protected: false, includeSecrets: ["DATABASE_URL"], workload: "orders" })).toBe("orders");
    expect(expectedTyped(prop(exportP), { protected: true, includeSecrets: ["X"] })).toBe("orders");
    const secretApply = prop({ kind: "apply", context: "default", yaml: "", parsed: { gvr: { group: "", version: "v1", resource: "secrets" }, namespace: "a", name: "x", dryRun: "ok" } });
    expect(expectedTyped(secretApply, { protected: false, includeSecrets: [] })).toBe("default");
    expect(approvalTier(p, { protected: false, includeSecrets: [] })).toBe(1);
    // a well-known port in a protected context is tier 2
    const pg = prop({ kind: "forward", context: "staging", target: { kind: "service", namespace: "db", name: "postgres" }, remotePort: 5432 }, { context: "staging" });
    expect(approvalTier(pg, { protected: true, includeSecrets: [] })).toBe(2);
  });

  it("lists secret keys an export could include", () => {
    const rows = [
      { key: "A", source: "secret" as const, masked: true, hits: [] },
      { key: "B", source: "literal" as const, masked: false, hits: [] },
      { key: "C", source: "secret" as const, masked: true, hits: [] },
    ];
    expect(exportSecretKeys(rows, {})).toEqual(["A", "C"]);
    expect(exportSecretKeys(rows, { exclude: ["A"] })).toEqual(["C"]);
    expect(exportSecretKeys(rows, { include: ["A", "B"] })).toEqual(["A"]);
  });

  it("reports results from Rust's data, never values", () => {
    const done = prop(up, { state: "approved", result: { data: { up: { forwards: [{ key: "kafka", localPort: 9094 }, { key: "pg", localPort: 15432 }] }, export: { keys: 14, secretKeys: 1, path: "C:\\x\\.env.kns" } } } });
    expect(resultText(done)).toBe("Approved: start dev set ds-1 and export its env · 2 forwards up · 14 keys (1 secret) written");
    expect(resultText(prop(up, { state: "approved", result: { data: { up: { forwards: [] }, export: { cancelled: true } } } }))).toContain("export cancelled");
    expect(resultText(prop(up, { state: "rejected", result: { message: "not now" } }))).toBe("Rejected: start dev set ds-1 and export its env · not now");
    expect(resultText(prop(up, { state: "failed", result: { error: { code: 0, reason: "AddrInUse", message: "port 9094 taken" } } }))).toContain("port 9094 taken");
  });

  it("picks the next request and counts the waiting ones", () => {
    const a = prop(up, { id: "a", createdAt: "2026-11-22T10:02:00Z" });
    const b = prop(up, { id: "b", createdAt: "2026-11-22T10:01:00Z" });
    const c = prop(up, { id: "c", state: "reviewing" });
    const d = prop(up, { id: "d", state: "executing" });
    expect(nextToReview([a, b, c])?.id).toBe("b");
    expect(nextToReview([c, d])?.id).toBe("c");
    expect(waitingCount([a, b, c, d])).toBe(3);
    expect([a, c, d].every(isOpen) && !isWaiting(d)).toBe(true);
  });

  it("finds arrivals and finished proposals between two lists", () => {
    const before = [prop(up, { id: "a" }), prop(up, { id: "b", state: "executing" })];
    const after = [prop(up, { id: "a", state: "rejected" }), prop(up, { id: "b", state: "approved" }), prop(up, { id: "c" })];
    expect(arrivals(before, after).map((p) => p.id)).toEqual(["c"]);
    expect(finished(before, after).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("names the token and keeps the proposed set as the draft", () => {
    expect(requestedBy("claude-code", "2026-11-22T10:00:00Z")).toBe('claude-code (token "claude-code", created 2026-11-22)');
    const set = { id: "ds-1", name: "n", context: "default", forwards: [], rewrites: [], autoStart: true, connSecrets: [], origin: { by: "user" as const }, hash: "h", updatedAt: "t" };
    expect(draftOfProposed(set)).toEqual({ id: "ds-1", name: "n", context: "default", forwards: [], rewrites: [], env: undefined, autoStart: true, connSecrets: [] });
  });
});

describe("env changes of a dev-set update", () => {
  it("names what changes", async () => {
    const { envChanges } = await import("./proposal-model");
    const DEP = { group: "apps", version: "v1", resource: "deployments" };
    const a = { workload: { gvr: DEP, namespace: "p", name: "c" }, format: "dotenv" as const, overrides: [{ key: "G_GROUP_ID", value: "c" }] };
    expect(envChanges(undefined, a)).toEqual(["+ env export of deployments/c (dotenv)"]);
    expect(envChanges(a, undefined)).toEqual(["- env export of deployments/c"]);
    expect(envChanges(a, { ...a, format: "posix", overrides: [{ key: "G_GROUP_ID", value: "c-local" }] })).toEqual(["~ format dotenv → posix", "~ override G_GROUP_ID=c-local (was c)"]);
    expect(envChanges(a, a)).toEqual([]);
  });
});
