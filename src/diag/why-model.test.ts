import { describe, expect, it } from "vitest";
import type { Diagnosis, EventRow, ObjRef } from "../ipc/types";
import { canWhy, countLabel, escapeRe, evidenceContext, evidenceTarget, evidenceText, findingTarget, findingsText, nextFinding, whyRows, type EvidenceEnv } from "./why-model";

const pod: ObjRef = { context: "default", gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name: "crashy-1" };
const rs = (name: string): ObjRef => ({ context: "default", gvr: { group: "apps", version: "v1", resource: "replicasets" }, namespace: "kns-spike", name });
const ev = (over: Partial<EventRow> = {}): EventRow => ({
  type: "Warning", reason: "BackOff", message: "Back-off restarting failed container main", count: 4, source: "kubelet", objectKind: "Pod", objectName: "crashy-1", namespace: "kns-spike", ...over,
});
const env: EvidenceEnv = {
  resolve: (k) => (k === "Pod" ? { gvr: { group: "", version: "v1", resource: "pods" }, namespaced: true } : k === "Node" ? { gvr: { group: "", version: "v1", resource: "nodes" }, namespaced: false } : undefined),
};

const diag: Diagnosis = {
  ref: pod,
  at: "2026-11-22T10:10:00Z",
  checked: ["phase", "containers"],
  redactions: { count: 2, byRule: { key: 2 } },
  findings: [
    {
      severity: "error",
      title: "container main restarts: last exit 1 (Error) after 3s",
      detail: "application error; CrashLoopBackOff, 12 restarts",
      evidence: [
        { type: "field", ref: pod, path: "/status/containerStatuses/0/lastState/terminated/exitCode", value: "1" },
        { type: "logLine", pod: "crashy-1", container: "main", previous: true, ts: "2026-11-22T10:00:02Z", text: "panic: missing env (KAFKA)*" },
        { type: "event", event: ev() },
      ],
    },
    {
      severity: "info",
      title: "revision 2 changed: image a:1 → a:2",
      evidence: [{ type: "diff", left: "spec.containers[main].image: a:1", right: "spec.containers[main].image: a:2", leftRef: rs("web-1"), rightRef: rs("web-2") }],
    },
  ],
};

describe("canWhy", () => {
  it("the kinds diagnose.rs has rules for", () => {
    expect(canWhy({ group: "", version: "v1", resource: "pods" })).toBe(true);
    expect(canWhy({ group: "apps", version: "v1", resource: "deployments" })).toBe(true);
    expect(canWhy({ group: "", version: "v1", resource: "services" })).toBe(true);
    expect(canWhy({ group: "", version: "v1", resource: "configmaps" })).toBe(false);
    expect(canWhy({ group: "batch", version: "v1", resource: "jobs" })).toBe(true);
    expect(canWhy({ group: "networking.k8s.io", version: "v1", resource: "ingresses" })).toBe(true);
    expect(canWhy({ group: "kustomize.toolkit.fluxcd.io", version: "v1", resource: "kustomizations" })).toBe(true);
    expect(canWhy({ group: "networking.k8s.io", version: "v1", resource: "networkpolicies" })).toBe(false);
    expect(canWhy(undefined)).toBe(false);
  });
});

describe("rows", () => {
  it("a finding row, then its evidence rows", () => {
    const rows = whyRows(diag);
    expect(rows.map((r) => r.type)).toEqual(["finding", "evidence", "evidence", "evidence", "finding", "evidence"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(whyRows(null)).toEqual([]);
  });
  it("no findings: next steps (describe, logs, events); a Service has no logs row", () => {
    const rows = whyRows({ ...diag, findings: [] });
    expect(rows.map((r) => (r.type === "next" ? r.label : r.type))).toEqual(["describe pod/crashy-1 (kns-spike)", "logs of pod/crashy-1 (kns-spike)", "events of pod/crashy-1 (kns-spike)"]);
    expect(rows[2].type === "next" && rows[2].view).toMatchObject({ kind: "table", namespace: "kns-spike", filters: [{ mode: "fuzzy", text: "crashy-1" }] });
    const svc = { ...pod, gvr: { group: "", version: "v1", resource: "services" }, name: "db" };
    expect(whyRows({ ...diag, ref: svc, findings: [] }).map((r) => r.type === "next" && r.label)).toEqual(["describe service/db (kns-spike)", "events of service/db (kns-spike)"]);
  });
  it("jumps between findings", () => {
    const rows = whyRows(diag);
    expect(nextFinding(rows, 0, 1)).toBe(4);
    expect(nextFinding(rows, 4, 1)).toBe(4);
    expect(nextFinding(rows, 5, -1)).toBe(4);
    expect(nextFinding(rows, 3, -1)).toBe(0);
  });
});

describe("evidence routing (Enter)", () => {
  it("log line → the previous logs of that container, searched for the line", () => {
    const v = evidenceTarget(diag.findings[0].evidence[1], pod, env);
    expect(v).toMatchObject({ kind: "logs", target: { by: "object", ref: { name: "crashy-1", namespace: "kns-spike" } }, container: "main", previous: true, filterLines: false });
    expect(v && v.kind === "logs" && v.match).toEqual({ mode: "re", text: "panic: missing env \\(KAFKA\\)\\*" });
    expect(new RegExp(v && v.kind === "logs" && v.match ? v.match.text : "").test("panic: missing env (KAFKA)*")).toBe(true);
  });
  it("event → describe of the involved object; unknown kinds open nothing", () => {
    expect(evidenceTarget(diag.findings[0].evidence[2], pod, env)).toMatchObject({ kind: "doc", format: "describe", ref: { name: "crashy-1", namespace: "kns-spike" } });
    expect(evidenceTarget({ type: "event", event: ev({ objectKind: "Node", objectName: "n1" }) }, pod, env)).toMatchObject({ ref: { name: "n1", namespace: undefined } });
    expect(evidenceTarget({ type: "event", event: ev({ objectKind: "Widget" }) }, pod, env)).toBeNull();
  });
  it("diff → the diff view of both objects; without refs nothing", () => {
    expect(evidenceTarget(diag.findings[1].evidence[0], pod, env)).toEqual({ kind: "diff", left: { ref: { gvr: rs("x").gvr, namespace: "kns-spike", name: "web-1" } }, right: { ref: { gvr: rs("x").gvr, namespace: "kns-spike", name: "web-2" } }, managedFields: false, split: false });
    expect(evidenceTarget({ type: "diff", left: "a", right: "b" }, pod, env)).toBeNull();
  });
  it("field → YAML; object → describe; contexts", () => {
    expect(evidenceTarget(diag.findings[0].evidence[0], pod, env)).toMatchObject({ kind: "doc", format: "yaml" });
    expect(evidenceTarget({ type: "object", ref: rs("web-2") }, pod, env)).toMatchObject({ kind: "doc", format: "describe", ref: { name: "web-2" } });
    expect(evidenceContext({ type: "object", ref: { ...pod, context: "staging" } }, pod)).toBe("staging");
    expect(evidenceContext(diag.findings[0].evidence[1], pod)).toBe("default");
  });
  it("Enter on a finding follows its first evidence that opens something", () => {
    expect(findingTarget(diag.findings[0], pod, env)?.evidence).toBe(0);
    expect(findingTarget({ severity: "warn", title: "x", evidence: [{ type: "diff", left: "", right: "" }, { type: "object", ref: pod }] }, pod, env)?.evidence).toBe(1);
    expect(findingTarget({ severity: "warn", title: "x", evidence: [] }, pod, env)).toBeNull();
  });
  it("escapeRe", () => {
    expect(escapeRe("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("text", () => {
  it("evidence lines", () => {
    expect(evidenceText(diag.findings[0].evidence[0])).toBe("/status/containerStatuses/0/lastState/terminated/exitCode = 1");
    expect(evidenceText(diag.findings[0].evidence[2])).toBe("Warning BackOff ×4: Back-off restarting failed container main");
    expect(evidenceText(diag.findings[1].evidence[0])).toBe("1 field changed: web-1 → web-2");
  });
  it("copy text lists findings, evidence, checks and redactions", () => {
    const t = findingsText(diag);
    expect(t).toContain("why pod/crashy-1 (kns-spike) · context default");
    expect(t).toContain("ERROR  container main restarts: last exit 1 (Error) after 3s");
    expect(t).toContain("  - log (previous): main 2026-11-22T10:00:02Z  panic: missing env (KAFKA)*");
    expect(t).toContain("      + spec.containers[main].image: a:2");
    expect(t).toContain("Checked: phase, containers");
    expect(t).toContain("Redacted 2 values.");
  });
  it("no known cause", () => {
    const t = findingsText({ ...diag, findings: [] });
    expect(t).toContain("No known cause found.");
    expect(countLabel({ ...diag, findings: [] })).toBe("no cause");
    expect(countLabel(diag)).toBe("1 finding");
    expect(countLabel(null)).toBe("");
  });
});
