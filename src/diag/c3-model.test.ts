import { describe, expect, it } from "vitest";
import type { ReachCheck, RelationNode } from "../ipc/types";
import { parsePort, parseReachArgs, reachRows, reachTitle, verdict } from "./reach-model";
import { canFold, countNodes, flatten, fold, statusSeverity } from "./relations-model";
import { progressOf, rowLine, STALL_MS, watchable } from "./rollout-model";

const pod = { gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name: "envdemo-1" };

describe("parseReachArgs", () => {
  it("reads the usual spellings", () => {
    expect(parseReachArgs(["web:80"], "kns-spike")).toEqual({ to: { gvr: { group: "", version: "v1", resource: "services" }, namespace: "kns-spike", name: "web" }, port: 80 });
    expect(parseReachArgs(["svc/web", "http"], "kns-spike")).toMatchObject({ to: { name: "web" }, port: "http" });
    expect(parseReachArgs(["web.other:5432"], "kns-spike")).toMatchObject({ to: { name: "web", namespace: "other" }, port: 5432 });
    expect(parseReachArgs(["db.data.svc:5432"], "x")).toMatchObject({ to: { name: "db", namespace: "data" } });
    expect(parseReachArgs(["web"], "kns-spike")).toMatchObject({ to: { name: "web" }, port: undefined });
    expect(parseReachArgs(["pod/web-1", "8080"], "kns-spike")).toMatchObject({ to: { gvr: { resource: "pods" }, name: "web-1" }, port: 8080 });
  });
  it("refuses what it cannot use", () => {
    expect(parseReachArgs([], "a")).toMatch(/name a Service/);
    expect(parseReachArgs(["Web"], "a")).toMatch(/not a valid name/);
    expect(parseReachArgs(["web:99999"], "a")).toMatch(/not a port/);
    expect(parseReachArgs(["web:80", "81"], "a")).toMatch(/once/);
    expect(parseReachArgs(["pod/web-1"], "a")).toMatch(/needs a port/);
    expect(parseReachArgs(["a.b.c"], "a")).toMatch(/not a Service address/);
    expect(parseReachArgs(["web;rm"], "a")).toMatch(/not a valid name/);
  });
  it("ports", () => {
    expect(parsePort("0")).toBeNull();
    expect(parsePort("grpc-web")).toBe("grpc-web");
    expect(parsePort("UPPER")).toBeNull();
  });
});

const check = (ok: boolean | null, port: number | string | undefined = 80): ReachCheck => ({
  from: { ...pod, context: "default" },
  to: { context: "default", gvr: { group: "", version: "v1", resource: "services" }, namespace: "kns-spike", name: "web" },
  port,
  steps: [
    { name: "Service", ok: true, detail: "web (ClusterIP)" },
    { name: "ingress to destination", ok, detail: "x" },
  ],
  ok,
});

describe("reach rows", () => {
  it("steps, then the probe; the result and debug offer follow the probe state", () => {
    const idle = reachRows(check(true), { state: "idle" }, true);
    expect(idle.map((r) => r.type)).toEqual(["step", "step", "probe"]);
    expect(idle[2]).toMatchObject({ label: "probe from inside the pod", disabled: undefined });
    const done = reachRows(check(true), { state: "done", result: { ok: false, command: "x", output: "", needsDebug: true } }, true);
    expect(done.map((r) => r.type)).toEqual(["step", "step", "probe", "result", "debug"]);
    const forbidden = reachRows(check(true), { state: "idle" }, "forbidden: cannot create pods/exec");
    expect(forbidden.find((r) => r.type === "probe")).toMatchObject({ disabled: "forbidden: cannot create pods/exec" });
    expect(forbidden[forbidden.length - 1]?.type).toBe("debug");
    expect(reachRows({ ...check(true), port: undefined }, { state: "idle" }, true).find((r) => r.type === "probe")).toMatchObject({ disabled: "no port to probe" });
    expect(reachRows(null, { state: "idle" }, true)).toEqual([]);
  });
  it("verdict and title", () => {
    expect(verdict(check(true)).glyph).toBe("ok");
    expect(verdict(check(false)).text).toBe("not reachable: ingress to destination");
    expect(verdict(check(null)).glyph).toBe("warn");
    expect(reachTitle({ from: pod, to: check(true).to, port: 80 })).toBe("pod/envdemo-1 (kns-spike) → svc/web:80");
  });
});

const ref = (name: string) => ({ context: "default", gvr: { group: "", version: "v1", resource: "pods" }, namespace: "n", name });
const tree: RelationNode = {
  ref: ref("root"), kind: "Pod", relation: "self", children: [
    { ref: ref("rs"), kind: "ReplicaSet", relation: "owner", children: [{ ref: ref("deploy"), kind: "Deployment", relation: "owner", children: [] }] },
    { ref: ref("cm"), kind: "ConfigMap", relation: "uses", children: [] },
  ],
};

describe("relations model", () => {
  it("flattens with fold state", () => {
    expect(flatten(tree, new Set()).map((r) => `${r.depth}:${r.node.ref.name}`)).toEqual(["0:root", "1:rs", "2:deploy", "1:cm"]);
    expect(flatten(tree, new Set(["0"])).map((r) => r.node.ref.name)).toEqual(["root", "rs", "cm"]);
    expect(countNodes(tree)).toBe(4);
  });
  it("h folds or goes to the parent; l unfolds or goes to the first child", () => {
    const rows = flatten(tree, new Set());
    let s = fold(rows, "0", new Set(), "collapse");
    expect([...s.collapsed]).toEqual(["0"]);
    s = fold(rows, "0.0", new Set(), "collapse");
    expect(s.cursor).toBe("0");
    s = fold(rows, "", new Set(), "expand");
    expect(s.cursor).toBe("0");
    const folded = flatten(tree, new Set(["0"]));
    s = fold(folded, "0", new Set(["0"]), "expand");
    expect(s.collapsed.has("0")).toBe(false);
    expect(canFold(rows.find((r) => r.key === "1"), "expand")).toBe("nothing below this row");
  });
  it("status severity", () => {
    expect(statusSeverity("missing")).toBe("error");
    expect(statusSeverity("2/3 ready")).toBe("warn");
    expect(statusSeverity("3/3 ready")).toBeNull();
    expect(statusSeverity("Running 2/2")).toBeNull();
    expect(statusSeverity("CrashLoopBackOff 1/2")).toBe("error");
  });
});

const DEPLOY = { group: "apps", version: "v1", resource: "deployments" };
describe("rollout model", () => {
  it("watchable kinds", () => {
    expect(watchable(DEPLOY)).toBe(true);
    expect(watchable({ group: "helm.toolkit.fluxcd.io", version: "v2", resource: "helmreleases" })).toBe(true);
    expect(watchable({ group: "", version: "v1", resource: "pods" })).toBe(false);
  });
  it("deployment progress until done", () => {
    const mid = { metadata: { generation: 4 }, spec: { replicas: 3 }, status: { observedGeneration: 4, replicas: 4, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 2, unavailableReplicas: 1 } };
    expect(progressOf(DEPLOY, mid)).toEqual({ done: false, text: "2/3 updated · 1 unavailable · 2 old" });
    const unobserved = { metadata: { generation: 5 }, spec: { replicas: 3 }, status: { observedGeneration: 4, replicas: 3, updatedReplicas: 3, availableReplicas: 3 } };
    expect(progressOf(DEPLOY, unobserved).done).toBe(false);
    const done = { metadata: { generation: 5 }, spec: { replicas: 3 }, status: { observedGeneration: 5, replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3 } };
    expect(progressOf(DEPLOY, done)).toEqual({ done: true, text: "3/3 updated" });
    const stuck = { metadata: {}, spec: {}, status: { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] } };
    expect(progressOf(DEPLOY, stuck)).toMatchObject({ done: true, failed: true, text: "stuck: ProgressDeadlineExceeded" });
  });
  it("flux reconcile waits for the request to be handled", () => {
    const ks = { group: "kustomize.toolkit.fluxcd.io", version: "v1", resource: "kustomizations" };
    const before = { metadata: { generation: 1 }, status: { observedGeneration: 1, lastHandledReconcileAt: "a", conditions: [{ type: "Ready", status: "True" }] } };
    expect(progressOf(ks, before, "b")).toEqual({ done: false, text: "waiting for the controller" });
    const after = { ...before, status: { ...before.status, lastHandledReconcileAt: "b", lastAppliedRevision: "main@sha1:abc" } };
    expect(progressOf(ks, after, "b")).toEqual({ done: true, text: "Ready · main@sha1:abc" });
    const failed = { ...after, status: { ...after.status, conditions: [{ type: "Ready", status: "False", reason: "BuildFailed" }] } };
    expect(progressOf(ks, failed, "b")).toMatchObject({ done: true, failed: true });
  });
  it("row line: waiting, stalled, done", () => {
    const p = { done: false, text: "1/3 updated" };
    expect(rowLine(p, 0, 0, undefined, 40_000)).toEqual({ text: "1/3 updated · waiting 40s", state: "progress" });
    expect(rowLine(p, 0, 0, undefined, STALL_MS + 1000).state).toBe("warn");
    expect(rowLine({ done: true, text: "3/3 updated" }, 0, 0, 34_000, 60_000)).toEqual({ text: "3/3 updated · done in 34s", state: "ok" });
    expect(rowLine(null, 0, 0, undefined, 1).text).toBe("reading…");
  });
});
