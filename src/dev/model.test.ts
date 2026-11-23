import { describe, expect, it } from "vitest";
import type { DevSet, EnvReport, Forward } from "../ipc/types";
import {
  diffLines, draftFromForwards, draftFromReport, draftUpdate, forwardLine, initialIncluded, originText, parseDevCommand, rewriteLine, rewrittenText, specOf,
  statusText, suggestName, summary,
} from "./model";

const svc = (namespace: string, name: string) => ({ context: "default", gvr: { group: "", version: "v1", resource: "services" }, namespace, name });
const report: EnvReport = {
  container: "orders",
  containers: ["orders"],
  rows: [
    { key: "KAFKA", source: "literal", value: "x kafka.kafka.svc:9092", masked: false, hits: [{ service: "kafka", namespace: "kafka", port: 9092, span: [2, 22] }] },
    { key: "DATABASE_URL", source: "secret", from: "secret/c:DATABASE_URL", masked: true, hits: [{ service: "postgres", namespace: "payments", port: 5432 }] },
    { key: "API_PASSWORD", source: "secret", masked: true, hits: [] },
    { key: "POD_IP", source: "field", from: "status.podIP", masked: false, hits: [] },
  ],
  deps: [
    {
      service: svc("kafka", "kafka"), port: 9092, kind: "kafka", ready: true, notes: [],
      suggestedForward: { key: "kafka", target: { kind: "service", namespace: "kafka", name: "kafka" }, remotePort: 9094, localPort: 9094, pin: true },
      suggestedRewrite: { match: { service: "kafka", namespace: "kafka", port: 9092 }, to: { forward: "kafka" } },
    },
    {
      service: svc("payments", "postgres"), port: 5432, kind: "postgres", ready: true, notes: [],
      suggestedForward: { key: "postgres", target: { kind: "service", namespace: "payments", name: "postgres" }, remotePort: 5432, localPort: 15432, pin: true },
      suggestedRewrite: { match: { service: "postgres", namespace: "payments", port: 5432 }, to: { forward: "postgres" } },
    },
  ],
  warnings: ["GROUP: a local run joins"],
  overrides: [{ key: "GROUP", value: "g-local-me" }],
  redactions: { count: 0, byRule: {} },
};
const workload = { gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "shop", name: "orders" };

describe("env view model", () => {
  it("summarises the report", () => {
    expect(summary(report)).toBe("4 keys · 2 from secrets · 2 dependencies · 1 side-effect warning");
  });
  it("includes every exportable key at first, secrets too", () => {
    expect([...initialIncluded(report)].sort()).toEqual(["API_PASSWORD", "DATABASE_URL", "KAFKA"]);
  });
  it("shows the rewritten value, and where a secret would point", () => {
    expect(rewrittenText(report.rows[0], report.deps)).toBe("x localhost:9094");
    expect(rewrittenText(report.rows[1], report.deps)).toBe("localhost:15432");
    expect(rewrittenText(report.rows[2], report.deps)).toBeNull();
  });
  it("builds the spec and the draft", () => {
    const included = new Set(["KAFKA", "DATABASE_URL"]);
    const spec = specOf(report, workload, included, "dotenv");
    expect(spec.include).toEqual(["KAFKA", "DATABASE_URL"]);
    expect(spec.includeSecrets).toEqual(["DATABASE_URL"]);
    expect(spec.overrides).toEqual(report.overrides);
    const all = specOf(report, workload, initialIncluded(report), "posix");
    expect(all.include).toBeUndefined();
    const d = draftFromReport("orders-dev", "default", report, spec, false);
    expect(d.forwards.map((f) => f.localPort)).toEqual([9094, 15432]);
    expect(d.rewrites.map((r) => r.to.forward)).toEqual(["kafka", "postgres"]);
    expect(initialIncluded(report, spec)).toEqual(new Set(["KAFKA", "DATABASE_URL"]));
    expect(suggestName("Orders_API")).toBe("orders-api-dev");
  });
});

const set = (patch: Partial<DevSet> = {}): DevSet => ({
  id: "ds1", name: "orders-dev", context: "default",
  forwards: report.deps.map((d) => d.suggestedForward), rewrites: report.deps.map((d) => d.suggestedRewrite),
  autoStart: false, origin: { by: "user" }, hash: "h1", approvedHash: "h1", updatedAt: "", ...patch,
});

describe("dev sets model", () => {
  it("names origin and approval, with agent text cleaned", () => {
    expect(originText(set())).toBe("mine");
    expect(originText(set({ origin: { by: "agent", client: "claude‮code", at: "" }, approvedHash: undefined }))).toBe("agent: claudecode · not approved");
  });
  it("lists forwards and rewrites as the approval list does", () => {
    expect(forwardLine(set().forwards[0])).toBe("kafka: svc/kafka.kafka:9094 → 127.0.0.1:9094 (pinned)");
    expect(rewriteLine(set().rewrites[1], set().forwards)).toBe("postgres.payments:5432 → localhost:15432 (postgres)");
  });
  it("diffs against the approved snapshot", () => {
    const snap = set();
    const changed = set({ hash: "h2", forwards: [snap.forwards[0], { ...snap.forwards[1], localPort: 25432 }], approvedSnapshot: { ...snap } });
    const lines = diffLines(changed);
    expect(lines.some((l) => l.startsWith("+ postgres: svc/postgres.payments:5432 → 127.0.0.1:25432"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- postgres:"))).toBe(true);
    expect(diffLines(snap)).toEqual([]);
  });
  it("makes a set of the running forwards", () => {
    const f = (id: string, patch: Partial<Forward> = {}): Forward => ({
      id, context: "default", target: { kind: "service", namespace: "kafka", name: "kafka" }, pod: "kafka-0", namespace: "kafka", remotePort: 9094, localPort: 9094,
      address: "127.0.0.1", connections: 0, status: "active", owner: { by: "user" }, startedAt: 0, ...patch,
    });
    const d = draftFromForwards("mine", "default", [f("a"), f("b", { localPort: 9095 }), f("c", { devSet: "x" }), f("d", { context: "staging" })]);
    expect(d.forwards.map((x) => [x.key, x.localPort, x.pin])).toEqual([["kafka", 9094, true], ["kafka-2", 9095, true]]);
    expect(statusText([set()], ["ds1"], [f("a", { devSet: "ds1" }), f("b", { devSet: "ds1" })])).toBe("orders-dev up · 2 forwards");
    expect(statusText([set()], [], [])).toBeNull();
  });
  it("updating a set's env keeps its forwards and rewrites", () => {
    const custom = set({ forwards: [{ ...set().forwards[0], localPort: 29094 }], rewrites: [set().rewrites[0]], connSecrets: [] });
    const spec = specOf(report, workload, new Set(["KAFKA"]), "posix");
    const d = draftUpdate(custom, spec, "renamed", true);
    expect(d.forwards).toBe(custom.forwards);
    expect(d.rewrites).toBe(custom.rewrites);
    expect(d.connSecrets).toBe(custom.connSecrets);
    expect([d.id, d.name, d.autoStart, d.env?.format]).toEqual(["ds1", "renamed", true, "posix"]);
  });
  it("parses :dev", () => {
    expect(parseDevCommand([])).toEqual({ kind: "picker" });
    expect(parseDevCommand(["up", "x"])).toEqual({ kind: "up", name: "x" });
    expect(parseDevCommand(["down"])).toEqual({ kind: "down", name: undefined });
    expect(parseDevCommand(["save", "Bad Name"]).kind).toBe("error");
    expect(parseDevCommand(["names", "on"])).toEqual({ kind: "names", on: true });
    expect(parseDevCommand(["names", "on", "7081"])).toEqual({ kind: "names", on: true, port: 7081 });
    expect(parseDevCommand(["names", "on", "80"]).kind).toBe("error");
    expect(parseDevCommand(["names", "off", "7081"]).kind).toBe("error");
    expect(parseDevCommand(["wat"]).kind).toBe("error");
  });
});
