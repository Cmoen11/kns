import { describe, expect, it } from "vitest";
import type { Json, Revision } from "../ipc/types";
import type { ObjectRef } from "../types";
import { APPLIED, diffView, isApplied, marksProblem, parseDiffArgs, prevPair, sideOwner } from "./args";
import { LAST_APPLIED, MASK, buildDiff, lastApplied, maskSecrets, normalize, project, refLabel, type SideData } from "./model";

const deploy = (name: string): ObjectRef => ({ gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "default", name });
const secret = (name: string): ObjectRef => ({ gvr: { group: "", version: "v1", resource: "secrets" }, namespace: "default", name });

const obj = (name: string, image: string, extra: Record<string, Json> = {}): Json => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name, namespace: "default", uid: `uid-${name}`, resourceVersion: "123", generation: 4, creationTimestamp: "2026-11-01T00:00:00Z",
    labels: { app: name },
    annotations: { "deployment.kubernetes.io/revision": "4", team: "core" },
    managedFields: [{ manager: "kubectl" }],
  },
  spec: { replicas: 2, template: { spec: { containers: [{ name: "main", image }] } } },
  status: { replicas: 2 },
  ...extra,
});

describe("normalize", () => {
  it("drops noise, managedFields and status by default", () => {
    const n = normalize(obj("api", "x:1"), false) as { metadata: Record<string, Json>; status?: Json };
    expect(Object.keys(n.metadata).sort()).toEqual(["annotations", "labels", "name", "namespace"]);
    expect(n.metadata.annotations).toEqual({ team: "core" });
    expect(n.status).toBeUndefined();
  });
  it("keeps everything with full (m)", () => {
    const n = normalize(obj("api", "x:1"), true) as { metadata: Record<string, Json>; status?: Json };
    expect(n.metadata.managedFields).toBeDefined();
    expect(n.status).toEqual({ replicas: 2 });
  });
  it("never shows a Secret's last-applied, even full", () => {
    const s = { kind: "Secret", metadata: { name: "s", annotations: { [LAST_APPLIED]: '{"data":{"pw":"eA=="}}' } }, data: { pw: "eA==" } };
    expect(JSON.stringify(normalize(s, true, true))).not.toContain("last-applied");
  });
  it("does not mutate its input", () => {
    const o = obj("api", "x:1");
    normalize(o, false);
    expect((o as { status?: Json }).status).toBeDefined();
  });
});

describe("project", () => {
  it("keeps only fields last-applied names, in its key order", () => {
    const live: Json = { b: 1, a: { x: 1, y: 2, defaulted: true }, list: [{ name: "m", image: "v2", pull: "Always" }, { name: "extra" }], z: 9 };
    const applied: Json = { a: { y: 0, x: 0 }, b: 0, list: [{ name: "m", image: "v1" }] };
    expect(project(live, applied)).toEqual({ a: { y: 2, x: 1 }, b: 1, list: [{ name: "m", image: "v2" }, { name: "extra" }] });
    expect(Object.keys(project(live, applied) as object)).toEqual(["a", "b", "list"]);
  });
  it("drops a field live no longer has", () => {
    expect(project({ a: 1 }, { a: 0, gone: 1 })).toEqual({ a: 1 });
  });
});

describe("lastApplied", () => {
  it("parses the annotation", () => {
    const o = { metadata: { annotations: { [LAST_APPLIED]: '{"spec":{"replicas":1}}' } } };
    expect(lastApplied(o)).toEqual({ applied: { spec: { replicas: 1 } } });
  });
  it("says why when it is missing (Flux, server-side apply)", () => {
    const r = lastApplied({ metadata: {} });
    expect("error" in r && r.error).toMatch(/server-side/);
  });
  it("rejects bad JSON", () => {
    expect("error" in lastApplied({ metadata: { annotations: { [LAST_APPLIED]: "{" } } })).toBe(true);
  });
});

describe("maskSecrets", () => {
  it("masks every value and tags keys whose values differ", () => {
    const [a, b] = maskSecrets({ data: { same: "eA==", diff: "YQ==", onlyA: "Yg==" } }, { data: { same: "eA==", diff: "Yw==" }, stringData: { s: "plain" } });
    expect(a).toEqual({ data: { same: MASK, diff: `${MASK} (differs)`, onlyA: MASK } });
    expect(b).toEqual({ data: { same: MASK, diff: `${MASK} (differs)` }, stringData: { s: MASK } });
  });
});

describe("buildDiff", () => {
  it("two objects: noise is gone, the real change stays", () => {
    const t = buildDiff({ by: "object", ref: deploy("api"), obj: obj("api", "x:1") }, { by: "object", ref: deploy("web"), obj: obj("web", "x:2") }, false);
    expect(t.before).toContain("image: x:1");
    expect(t.after).toContain("image: x:2");
    expect(t.before).not.toContain("uid");
    expect(t.before).not.toContain("resourceVersion");
    expect(t.leftLabel).toBe("deploy/default/api");
  });
  it("two Secrets: no value reaches the text", () => {
    const s = (v: string): Json => ({ kind: "Secret", metadata: { name: "s" }, data: { password: v } });
    const t = buildDiff({ by: "object", ref: secret("a"), obj: s("czNjcjN0LXZhbHVl") }, { by: "object", ref: secret("b"), obj: s("b3RoZXI=") }, true);
    expect(t.before + t.after).not.toContain("czNjcjN0LXZhbHVl");
    expect(t.before + t.after).not.toContain("b3RoZXI=");
    expect(t.after).toContain("(differs)");
  });
  it("revisions show their templates; Helm says why it cannot", () => {
    const rev = (n: number, template?: Json): Revision => ({
      id: `r${n}`, revision: n, createdAt: "", image: `x:${n}`, ref: { context: "c", gvr: { group: "apps", version: "v1", resource: "replicasets" }, name: `r${n}` },
      ...(template === undefined ? {} : { template }),
    });
    const owner = deploy("api");
    const t = buildDiff({ by: "revision", owner, rev: rev(1, { spec: { a: 1 } }) }, { by: "revision", owner, rev: rev(2, { spec: { a: 2 } }) }, false);
    expect(t.before).toBe("spec:\n  a: 1\n");
    expect(t.rightLabel).toBe("deploy/default/api rev 2 · x:2");
    expect(() => buildDiff({ by: "revision", owner, rev: rev(1) }, { by: "revision", owner, rev: rev(2) }, false)).toThrow(/Helm/);
  });
  it("live vs last-applied: projected, with a note; m shows everything", () => {
    const applied = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "api" }, spec: { replicas: 1 } };
    const live = obj("api", "x:1") as { metadata: { annotations: Record<string, string> } };
    live.metadata.annotations[LAST_APPLIED] = JSON.stringify(applied);
    const sides: [SideData, SideData] = [{ by: "applied", owner: deploy("api"), live: live as unknown as Json }, { by: "object", ref: deploy("api"), obj: live as unknown as Json }];
    const t = buildDiff(sides[0], sides[1], false);
    expect(t.before).toBe("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 1\n");
    expect(t.after).toBe("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n");
    expect(t.note).toMatch(/last-applied/);
    expect(t.leftLabel).toBe("deploy/default/api last-applied");
    const full = buildDiff(sides[0], sides[1], true);
    expect(full.after).toContain("managedFields");
    expect(full.note).toBeNull();
  });
  it("last-applied of a Flux object: the reason, not an empty diff", () => {
    expect(() => buildDiff({ by: "applied", owner: deploy("api"), live: obj("api", "x") }, { by: "object", ref: deploy("api"), obj: obj("api", "x") }, false)).toThrow(/Flux/);
  });
  it("a Secret's last-applied is refused", () => {
    expect(() => buildDiff({ by: "applied", owner: secret("s"), live: {} }, { by: "object", ref: secret("s"), obj: {} }, false)).toThrow(/Secret/);
  });
});

describe("args", () => {
  it("parses :diff words", () => {
    expect(parseDiffArgs([])).toEqual({ mode: "marks" });
    expect(parseDiffArgs(["prev"])).toEqual({ mode: "prev" });
    expect(parseDiffArgs(["applied"])).toEqual({ mode: "applied" });
    expect("error" in parseDiffArgs(["nope"])).toBe(true);
    expect("error" in parseDiffArgs(["prev", "x"])).toBe(true);
  });
  it("needs exactly two marks", () => {
    expect(marksProblem([deploy("a")])).toMatch(/two/);
    expect(marksProblem([deploy("a"), deploy("b"), deploy("c")])).toMatch(/3 rows/);
    expect(marksProblem([deploy("a"), deploy("b")])).toBeNull();
  });
  it("prev pairs the one before the newest with the newest", () => {
    expect(prevPair([{ revision: 1 }, { revision: 3 }, { revision: 2 }])).toEqual([{ revision: 2 }, { revision: 3 }]);
    expect(prevPair([{ revision: 1 }])).toMatch(/one revision/);
  });
  it("last-applied is a reserved revision id", () => {
    const v = diffView({ revision: { owner: deploy("a"), id: APPLIED } }, { ref: deploy("a") });
    expect(isApplied(v.left)).toBe(true);
    expect(isApplied(v.right)).toBe(false);
    expect(sideOwner(v.left).name).toBe("a");
    expect(v.split).toBe(true);
    expect(v.managedFields).toBe(false);
  });
  it("labels refs with short kinds", () => {
    expect(refLabel({ gvr: { group: "", version: "v1", resource: "pods" }, name: "p" })).toBe("pod/p");
  });
});
