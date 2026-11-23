import { describe, expect, it } from "vitest";
import type { Column, Row, TableEvent, TableQuery } from "../ipc/types";
import { buildAliases, resolveAlias } from "./aliases";
import { createTables, tableKey, type TableDelta } from "./tables";

const col = (name: string): Column => ({ name, type: "string", format: "", description: "", priority: 0 });
const row = (uid: string, v = 0): Row => ({ uid, name: uid, namespace: "default", cells: [uid, v] });
const q = (resource = "pods", namespace?: string): TableQuery => ({ context: "c", gvr: { group: "", version: "v1", resource }, namespace });

function harness(opts: { graceMs?: number; pauseMs?: number } = {}) {
  const subs: { query: TableQuery; emit: (e: TableEvent) => void; stopped: boolean }[] = [];
  let frames: (() => void)[] = [];
  let scheduled = 0;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let now = 0;
  let seq = 0;
  const tables = createTables({
    subscribe: (query, emit) => {
      const s = { query, emit, stopped: false };
      subs.push(s);
      // like the mock backend: emits synchronously, before returning the unsubscribe
      emit({ type: "state", state: "syncing" });
      return () => {
        s.stopped = true;
      };
    },
    schedule: (fn) => {
      scheduled++;
      frames.push(fn);
    },
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    graceMs: opts.graceMs ?? 2000,
    pauseMs: opts.pauseMs ?? 30000,
  });
  return {
    tables,
    subs,
    frame() {
      const run = frames;
      frames = [];
      for (const fn of run) fn();
    },
    scheduled: () => scheduled,
    advance(ms: number) {
      now += ms;
      for (const t of [...timers].filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe("tableKey", () => {
  it("treats undefined, empty and * namespaces as the same query", () => {
    expect(tableKey(q("pods"))).toBe(tableKey(q("pods", "")));
    expect(tableKey(q("pods"))).toBe(tableKey(q("pods", "*")));
    expect(tableKey(q("pods", "a"))).not.toBe(tableKey(q("pods")));
    expect(tableKey(q("pods"))).not.toBe(tableKey({ ...q("pods"), labelSelector: "app=web" }));
  });
});

describe("shared subscriptions", () => {
  it("opens one backend subscription per unique query and passes all-namespaces as undefined", () => {
    const h = harness();
    const a = h.tables.acquire(q("pods", "*"));
    const b = h.tables.acquire(q("pods"));
    const c = h.tables.acquire(q("services"));
    expect(a.key).toBe(b.key);
    expect(h.subs).toHaveLength(2);
    expect(h.subs[0].query.namespace).toBeUndefined();
    expect(h.tables.openCount()).toBe(2);
    c.release();
    b.release();
    a.release();
  });

  it("keeps the subscription for a grace period after the last release, then stops it", () => {
    const h = harness({ graceMs: 2000 });
    const a = h.tables.acquire(q());
    const b = h.tables.acquire(q());
    a.release();
    h.advance(5000);
    expect(h.subs[0].stopped).toBe(false);
    b.release();
    b.release(); // double release is a no-op
    h.advance(1999);
    expect(h.subs[0].stopped).toBe(false);
    // navigating back inside the grace period reuses the same watch and its rows
    const again = h.tables.acquire(q());
    h.advance(5000);
    expect(h.subs).toHaveLength(1);
    expect(h.subs[0].stopped).toBe(false);
    again.release();
    h.advance(2000);
    expect(h.subs[0].stopped).toBe(true);
    expect(h.tables.openCount()).toBe(0);
    // a later acquire starts a fresh one
    h.tables.acquire(q());
    expect(h.subs).toHaveLength(2);
  });

  it("pauses the watch 30s after the last live holder, keeps rows as stale, and resumes", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    h.subs[0].emit({ type: "snapshot", columns: [col("Name")], rows: [row("a")] });
    h.frame();
    l.setLive(false);
    h.advance(29999);
    expect(h.subs[0].stopped).toBe(false);
    h.advance(1);
    expect(h.subs[0].stopped).toBe(true);
    h.frame();
    const snap = h.tables.get(l.key);
    expect(snap.stale).toBe(true);
    expect(snap.rows.map((r) => r.uid)).toEqual(["a"]);
    l.setLive(true);
    expect(h.subs).toHaveLength(2);
    h.frame();
    expect(h.tables.get(l.key).stale).toBe(false);
    // events of the stopped subscription are ignored
    h.subs[0].emit({ type: "delta", upserts: [row("zombie")], deletes: [] });
    h.frame();
    expect(h.tables.rowByUid(l.key, "zombie")).toBeUndefined();
  });
});

describe("snapshots and deltas", () => {
  it("is syncing with a stable empty snapshot until the first snapshot arrives", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    const before = h.tables.get(l.key);
    expect(before.synced).toBe(false);
    expect(before.state).toBe("syncing");
    expect(h.tables.get(l.key)).toBe(before);
    h.subs[0].emit({ type: "snapshot", columns: [col("Name")], rows: [row("a"), row("b")] });
    h.subs[0].emit({ type: "state", state: "live" });
    expect(h.tables.get(l.key)).toBe(before); // nothing is published before the frame
    h.frame();
    const after = h.tables.get(l.key);
    expect(after).not.toBe(before);
    expect(after).toMatchObject({ synced: true, state: "live", stale: false });
    expect(after.rows.map((r) => r.uid)).toEqual(["a", "b"]);
    expect(after.columns.map((c) => c.name)).toEqual(["Name"]);
  });

  it("copies the snapshot rows: a backend that mutates its array later does not leak in", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    const live = [row("a")];
    h.subs[0].emit({ type: "snapshot", columns: [], rows: live });
    h.frame();
    live.push(row("b"));
    expect(h.tables.get(l.key).rows).toHaveLength(1);
  });

  it("notifies at most once per frame for a burst, with one version bump", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    h.subs[0].emit({ type: "snapshot", columns: [], rows: [] });
    h.frame();
    const v0 = h.tables.get(l.key).version;
    const framesBefore = h.scheduled();
    let calls = 0;
    h.tables.subscribe(l.key, () => calls++);
    for (let i = 0; i < 500; i++) h.subs[0].emit({ type: "delta", upserts: [row(`r${i % 50}`, i)], deletes: [] });
    expect(calls).toBe(0);
    expect(h.scheduled() - framesBefore).toBe(1);
    h.frame();
    expect(calls).toBe(1);
    const snap = h.tables.get(l.key);
    expect(snap.version).toBe(v0 + 1);
    expect(snap.rows).toHaveLength(50);
    expect(h.tables.get(l.key)).toBe(snap);
    // an idle frame changes nothing
    h.frame();
    expect(calls).toBe(1);
    expect(h.tables.get(l.key)).toBe(snap);
  });

  it("keeps row order stable: updates stay in place, new rows go last, deletes leave no hole", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    h.subs[0].emit({ type: "snapshot", columns: [], rows: [row("a"), row("b"), row("c")] });
    h.frame();
    const first = h.tables.get(l.key).rows;
    h.subs[0].emit({ type: "delta", upserts: [row("b", 1), row("d")], deletes: [] });
    h.subs[0].emit({ type: "delta", upserts: [], deletes: ["a", "missing"] });
    h.frame();
    const rows = h.tables.get(l.key).rows;
    expect(rows.map((r) => r.uid)).toEqual(["b", "c", "d"]);
    expect(rows[0].cells[1]).toBe(1);
    // untouched rows keep their identity, so memoized row renderers skip them
    expect(rows[1]).toBe(first[2]);
    expect(h.tables.rowByUid(l.key, "b")).toBe(rows[0]);
    // a resync keeps the order of surviving rows
    h.subs[0].emit({ type: "snapshot", columns: [], rows: [row("e"), row("d"), row("b")] });
    h.frame();
    expect(h.tables.get(l.key).rows.map((r) => r.uid)).toEqual(["b", "d", "e"]);
  });

  it("reports what changed in the frame, with the previous row", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    const deltas: TableDelta[] = [];
    h.tables.subscribeDelta(l.key, (d) => deltas.push({ reset: d.reset, changed: new Map(d.changed), deleted: [...d.deleted] }));
    const a0 = row("a");
    h.subs[0].emit({ type: "snapshot", columns: [], rows: [a0, row("b")] });
    h.frame();
    expect(deltas[0].reset).toBe(true);
    h.subs[0].emit({ type: "delta", upserts: [row("a", 1)], deletes: [] });
    h.subs[0].emit({ type: "delta", upserts: [row("a", 2), row("n")], deletes: ["b"] });
    h.frame();
    expect(deltas).toHaveLength(2);
    expect(deltas[1].reset).toBe(false);
    expect(deltas[1].changed.get("a")).toBe(a0); // the row before the frame, not the intermediate one
    expect(deltas[1].changed.has("n")).toBe(true);
    expect(deltas[1].changed.get("n")).toBeUndefined();
    expect(deltas[1].deleted).toEqual(["b"]);
  });

  it("handles 5,000 rows and a burst of deltas in one frame", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    h.subs[0].emit({ type: "snapshot", columns: [], rows: Array.from({ length: 5000 }, (_, i) => row(`r${i}`)) });
    h.frame();
    let calls = 0;
    h.tables.subscribe(l.key, () => calls++);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) h.subs[0].emit({ type: "delta", upserts: [row(`r${(i * 7) % 5000}`, i)], deletes: [] });
    h.frame();
    const ms = performance.now() - t0;
    expect(calls).toBe(1);
    const rows = h.tables.get(l.key).rows;
    expect(rows).toHaveLength(5000);
    expect(rows[0].uid).toBe("r0");
    expect(rows[4999].uid).toBe("r4999");
    expect(ms).toBeLessThan(200);
  });

  it("refresh and resyncAll re-open the watch and keep the rows until the new snapshot", () => {
    const h = harness();
    const l = h.tables.acquire(q());
    h.subs[0].emit({ type: "snapshot", columns: [], rows: [row("a")] });
    h.subs[0].emit({ type: "state", state: "live" });
    h.frame();
    h.tables.refresh(l.key);
    expect(h.subs[0].stopped).toBe(true);
    expect(h.subs).toHaveLength(2);
    h.frame();
    expect(h.tables.get(l.key)).toMatchObject({ state: "syncing", synced: true });
    expect(h.tables.get(l.key).rows).toHaveLength(1);
    h.tables.resyncAll();
    expect(h.subs).toHaveLength(3);
    expect(h.tables.openCount()).toBe(1);
  });

  it("aggregates watch health", () => {
    const h = harness();
    h.tables.acquire(q("pods"));
    h.tables.acquire(q("services"));
    let pings = 0;
    h.tables.subscribeHealth(() => pings++);
    h.subs[0].emit({ type: "state", state: "reconnecting" });
    h.subs[1].emit({ type: "state", state: "error", message: "boom" });
    h.frame();
    expect(pings).toBe(1);
    expect(h.tables.health()).toEqual({ subscriptions: 2, reconnecting: 1, failed: 1 });
  });
});

describe("aliases", () => {
  const res = (group: string, resource: string, kind: string, shortNames: string[] = []) => ({
    gvr: { group, version: "v1", resource }, kind, singular: kind.toLowerCase(), namespaced: true, verbs: [], shortNames, categories: [], subresources: [],
  });
  it("resolves plural, singular, short name, kind and name.group; built-ins win a clash", () => {
    const map = buildAliases([
      res("example.com", "pods", "Pod", ["po"]),
      res("", "pods", "Pod", ["po"]),
      res("apps", "deployments", "Deployment", ["deploy", "dp"]),
      res("kustomize.toolkit.fluxcd.io", "kustomizations", "Kustomization", ["ks"]),
    ]);
    expect(resolveAlias(map, "po")?.gvr.group).toBe("");
    expect(resolveAlias(map, "Pods")?.gvr.group).toBe("");
    expect(resolveAlias(map, "pods.example.com")?.gvr.group).toBe("example.com");
    expect(resolveAlias(map, " deploy ")?.gvr.resource).toBe("deployments");
    expect(resolveAlias(map, "deployment.apps")?.kind).toBe("Deployment");
    expect(resolveAlias(map, "ks")?.kind).toBe("Kustomization");
    expect(resolveAlias(map, "nope")).toBeUndefined();
    expect(map.byGvr.get("apps/v1/deployments")?.kind).toBe("Deployment");
  });
});
