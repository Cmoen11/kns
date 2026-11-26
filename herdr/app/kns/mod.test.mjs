// Tests for the Herdr mod's pure modules (no Herdr runtime needed): `node --test herdr/app/kns/`.
// The same cases as kns-tui's diff.rs/model.rs tests, so both frontends agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3, unified, conflictLines } from "./diff.js";
import * as M from "./model.js";
import { Utf8Stream, decode } from "./utf8.js";

test("merge3 replays disjoint changes and marks overlaps", () => {
  const base = "a\nb\nc\nd\ne";
  assert.deepEqual(merge3(base, "a\nB\nc\nd\ne", "a\nb\nc\nd\nE"), { text: "a\nB\nc\nd\nE", conflicts: 0 });
  const r = merge3(base, "a\nB\nc\nd\ne", "a\nX\nc\nd\ne");
  assert.equal(r.conflicts, 1);
  assert.deepEqual(conflictLines(r.text), [2, 4, 6]);
  assert.equal(merge3(base, "a\nB\nc", "a\nB\nc").conflicts, 0);
});

test("unified diff has context and gaps", () => {
  const a = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n");
  const b = a.replace("\n10\n", "\nten\n");
  const d = unified(a, b, 2);
  assert.deepEqual(d.map((x) => x.kind), ["@", " ", " ", "-", "+", " ", " "]);
  assert.equal(d[0].text, "@@ line 8 @@");
  assert.equal(unified(a, a).length, 0);
  assert.equal(unified("", "x: 1\ny: 2\n").filter((x) => x.kind === "+").length, 2);
});

test("table snapshot, delta, health", () => {
  const t = new M.Table();
  t.apply({ type: "snapshot", columns: [{ name: "Name" }, { name: "Ready" }, { name: "Status" }, { name: "IP", priority: 1 }], rows: [
    { uid: "1", name: "a", cells: ["a", "1/1", "Running", "x"] },
    { uid: "2", name: "b", cells: ["b", "0/1", "CrashLoopBackOff", "y"] },
  ] });
  assert.deepEqual(t.columns.map((c) => c.name), ["Name", "Ready", "Status"]);
  assert.equal(M.health(t, t.rows[0]), M.OK);
  assert.equal(M.health(t, t.rows[1]), M.BAD);
  t.apply({ type: "delta", upserts: [{ uid: "3", name: "c", cells: ["c", "0/1", "Completed"] }], deletes: ["1"] });
  assert.deepEqual(t.rows.map((r) => r.name), ["b", "c"]);
  assert.equal(M.health(t, t.rows[1]), M.DONE);
  t.apply({ type: "state", state: "forbidden", message: "no" });
  assert.equal(t.state, "forbidden");
});

test("selectors, conflicts, gitops owner, project file, cells", () => {
  assert.equal(M.selectorOf({ spec: { selector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["a", "b"] }] } } }), "app=web,tier in (a,b)");
  assert.equal(M.selectorOf({ spec: { selector: { app: "svc" } } }), "app=svc");
  assert.equal(M.conflictOf({ code: 409, reason: "Conflict", message: 'Apply failed with 1 conflict: conflict with "kubectl"' }), "fieldManager");
  assert.equal(M.conflictOf({ code: 409, reason: "Conflict", message: "the object has been modified" }), "version");
  assert.equal(M.conflictOf({ code: 422, reason: "Invalid", message: "x" }), null);
  assert.equal(M.gitopsOwner({ metadata: { labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } } }), "Flux Kustomization flux-system/apps");
  assert.deepEqual(M.parseProject('context = "staging"\nnamespace = "billett" # team\nbogus = "x"\n'), { context: "staging", namespace: "billett" });
  assert.equal(M.cellText("\x1b[31mred\x1b[0m\tx"), "red    x");
  assert.equal(M.fromDiscovery({ gvr: { group: "apps", version: "v1", resource: "deployments" }, kind: "Deployment", namespaced: true, verbs: ["list"] }).resource, "deployments");
  assert.equal(M.fromDiscovery({ gvr: { group: "", version: "v1", resource: "pods/log" }, verbs: ["get"] }), null);
});

test("utf8 stream keeps split characters", () => {
  const bytes = new Uint8Array([...Buffer.from('{"n":"æø'), ...Buffer.from('å😀"}')]);
  const s = new Utf8Stream();
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) out += s.push(bytes.subarray(i, i + 3));
  assert.equal(out, '{"n":"æøå😀"}');
  assert.equal(decode(Buffer.from("plain ascii")), "plain ascii");
});
