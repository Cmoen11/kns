import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent, LogQuery, ObjRef, PodRef, TableEvent, TableQuery } from "../../ipc/types";
import type { PaneWatch } from "../../store/pane-status";
import { ERROR, GAP, LINE, LogSession, NOTE } from "./session";
import { StreamManager, type StreamDeps } from "./streams";
import type { StreamConfig } from "./targets";

interface Opened {
  query: LogQuery;
  emit: (e: LogEvent) => void;
  closed: boolean;
}

const pod = (name: string, extra: Partial<PodRef> = {}): PodRef => ({
  namespace: "ns", name, containers: ["main"], initContainers: [], ephemeralContainers: [], phase: "Running", ...extra,
});

const cfgFor = (resource: string, name: string, extra: Partial<StreamConfig> = {}): StreamConfig => ({
  context: "ctx",
  target: { by: "object", ref: { gvr: { group: resource === "pods" ? "" : "apps", version: "v1", resource }, namespace: "ns", name } },
  container: "*", since: "tail", previous: false, ...extra,
});

const ts = (sec: number, nanos = "000000000") => `2024-01-01T00:00:${String(sec).padStart(2, "0")}.${nanos}Z`;

function setup() {
  const opened: Opened[] = [];
  const watches: (PaneWatch | null)[] = [];
  let pods: PodRef[] | Error = [pod("a")];
  const tables: { query: TableQuery; emit: (e: TableEvent) => void; closed: boolean }[] = [];
  const deps: StreamDeps = {
    backend: {
      podsFor: (ref: ObjRef) => {
        if (pods instanceof Error) return Promise.reject({ code: 0, reason: "Network", message: pods.message });
        return Promise.resolve(ref.gvr.resource === "pods" ? pods.filter((p) => p.name === ref.name) : pods);
      },
      streamLogs: (query, onEvent) => {
        const o: Opened = { query, emit: onEvent, closed: false };
        opened.push(o);
        return () => {
          o.closed = true;
        };
      },
      subscribeTable: (query, onEvent) => {
        const t = { query, emit: onEvent, closed: false };
        tables.push(t);
        return () => {
          t.closed = true;
        };
      },
    },
    report: (s) => watches.push(s.watch),
  };
  const session = new LogSession({ cap: 1000, schedule: () => {} });
  const streams = new StreamManager(session, deps);
  const settle = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    session.flush();
  };
  const rows = () => Array.from({ length: session.rowCount }, (_, r) => session.entryAtRow(r)!);
  const texts = () => rows().map((e) => e.text);
  const live = () => opened.filter((o) => !o.closed);
  const line = (sec: number, text: string, target = "a/main", nanos?: string) => {
    const [p, c] = target.split("/");
    return { ts: ts(sec, nanos), pod: p, container: c, text };
  };
  return { opened, watches, tables, session, streams, settle, rows, texts, live, line, setPods: (p: PodRef[] | Error) => (pods = p) };
}

describe("StreamManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:30Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("opens one stream per container and feeds the session", async () => {
    const t = setup();
    t.setPods([pod("a", { containers: ["main", "sidecar"], initContainers: ["init"] })]);
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    expect(t.opened.map((o) => o.query.targets[0].container)).toEqual(["init", "main", "sidecar"]);
    expect(t.opened[1].query).toMatchObject({ context: "ctx", follow: true, tailLines: 500 });
    expect(t.opened[1].query.targets).toHaveLength(1);
    t.opened[1].emit({ type: "lines", lines: [t.line(1, "hello"), t.line(2, "world")] });
    await t.settle();
    expect(t.texts()).toEqual(["hello", "world"]);
    expect(t.session.gutterMode).toBe("container");
    expect(t.watches[t.watches.length - 1]).toBe("live");
  });

  it("streams one chosen container, or reports that none matches", async () => {
    const t = setup();
    t.setPods([pod("a", { containers: ["main", "sidecar"] })]);
    t.streams.configure(cfgFor("pods", "a", { container: "sidecar" }));
    await t.settle();
    expect(t.live().map((o) => o.query.targets[0].container)).toEqual(["sidecar"]);
    t.streams.configure(cfgFor("pods", "a", { container: "nope" }));
    await t.settle();
    expect(t.live()).toHaveLength(0);
    expect(t.session.status).toEqual({ phase: "empty", message: 'No container named "nope".' });
  });

  it("maps since and previous to the query", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a", { since: "5m" }));
    await t.settle();
    expect(t.opened[0].query).toMatchObject({ follow: true, sinceSeconds: 300 });
    expect(t.opened[0].query.tailLines).toBeUndefined();
    t.streams.configure(cfgFor("pods", "a", { previous: true }));
    await t.settle();
    expect(t.opened[1].query).toMatchObject({ follow: false, previous: true, tailLines: 500 });
    expect(t.opened[0].closed).toBe(true);
  });

  it("after an error: a visible error row, a retry with backoff, a gap marker and no repeated lines", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(10, "one"), t.line(11, "two")] });
    t.opened[0].emit({ type: "error", pod: "a", container: "main", message: "connection reset" });
    await t.settle();
    expect(t.rows().map((e) => e.kind)).toEqual([LINE, LINE, ERROR]);
    expect(t.texts()[2]).toBe("a/main: connection reset");
    expect(t.watches[t.watches.length - 1]).toBe("error");
    expect(t.opened).toHaveLength(1);

    await t.settle(2000);
    expect(t.opened).toHaveLength(2);
    // everything after the last line seen (00:00:11), with a second of overlap
    expect(t.opened[1].query.sinceSeconds).toBe(22);
    expect(t.opened[1].query.tailLines).toBeUndefined();

    t.opened[1].emit({ type: "lines", lines: [t.line(10, "one"), t.line(11, "two"), t.line(12, "three")] });
    await t.settle();
    expect(t.rows().map((e) => e.kind)).toEqual([LINE, LINE, ERROR, GAP, LINE]);
    expect(t.texts().slice(3)).toEqual(["a/main reattached", "three"]);
    expect(t.watches[t.watches.length - 1]).toBe("live");
  });

  it("deduplicates on nanoseconds, not only milliseconds", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(10, "a", "a/main", "123000001")] });
    t.opened[0].emit({ type: "error", pod: "a", container: "main", message: "x" });
    await t.settle(2000);
    t.opened[1].emit({ type: "lines", lines: [t.line(10, "a", "a/main", "123000001"), t.line(10, "b", "a/main", "123000002")] });
    await t.settle();
    expect(t.rows().filter((e) => e.kind === LINE).map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("backs off further on repeated errors and reports the same error once", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    t.opened[0].emit({ type: "error", pod: "a", container: "main", message: "refused" });
    await t.settle(2000);
    t.opened[1].emit({ type: "error", pod: "a", container: "main", message: "refused" });
    await t.settle(3999);
    expect(t.opened).toHaveLength(2);
    await t.settle(1);
    expect(t.opened).toHaveLength(3);
    expect(t.rows().filter((e) => e.kind === ERROR)).toHaveLength(1);
  });

  it("an ended stream is noted and reattached; a finished init container is final and silent", async () => {
    const t = setup();
    t.setPods([pod("a", { initContainers: ["init"] })]);
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    const [init, main] = t.opened;
    init.emit({ type: "lines", lines: [t.line(1, "migrated", "a/init")] });
    init.emit({ type: "end", pod: "a", container: "init" });
    main.emit({ type: "lines", lines: [t.line(2, "serving")] });
    await t.settle(60_000);
    expect(t.opened).toHaveLength(2);
    expect(t.texts()).toEqual(["migrated", "serving"]);
    expect(t.watches[t.watches.length - 1]).toBe("live");

    main.emit({ type: "end", pod: "a", container: "main" });
    await t.settle();
    expect(t.rows().map((e) => e.kind)).toEqual([LINE, LINE, NOTE]);
    expect(t.texts()[2]).toBe("a/main: stream ended");
    expect(t.watches[t.watches.length - 1]).toBe("reconnecting");
    await t.settle(2000);
    expect(t.opened).toHaveLength(3);
    expect(t.opened[2].query.targets[0].container).toBe("main");
  });

  it("previous logs are a one-shot read: no reattach after end or error", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a", { previous: true }));
    await t.settle();
    t.opened[0].emit({ type: "error", pod: "a", container: "main", message: "previous terminated container not found" });
    await t.settle(120_000);
    expect(t.opened).toHaveLength(1);
    expect(t.texts()).toEqual(["a/main: previous terminated container not found"]);
  });

  it("says when every stream ran to its end (previous logs read), and not while one is live", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a", { previous: true }));
    await t.settle();
    expect(t.session.ended).toBe(false);
    t.opened[0].emit({ type: "lines", lines: [t.line(1, "last words")] });
    expect(t.session.ended).toBe(false);
    t.opened[0].emit({ type: "end", pod: "a", container: "main" });
    expect(t.session.ended).toBe(true);
    // back to the running instance: live again
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    expect(t.session.ended).toBe(false);
    // a followed stream that ends is retried, not finished
    t.opened[1].emit({ type: "lines", lines: [t.line(2, "serving")] });
    t.opened[1].emit({ type: "end", pod: "a", container: "main" });
    expect(t.session.ended).toBe(false);
  });

  it("re-resolves a workload: a pod that goes away never restarts the others", async () => {
    const t = setup();
    t.setPods([pod("web-1"), pod("web-2")]);
    t.streams.configure(cfgFor("deployments", "web"));
    await t.settle();
    expect(t.opened.map((o) => o.query.targets[0].pod)).toEqual(["web-1", "web-2"]);
    t.setPods([pod("web-2"), pod("web-3")]);
    await t.settle(5000);
    expect(t.opened[0].closed).toBe(true);
    expect(t.opened[1].closed).toBe(false);
    expect(t.opened.map((o) => o.query.targets[0].pod)).toEqual(["web-1", "web-2", "web-3"]);
    expect(t.texts()).toEqual(["web-1/main is gone"]);
    expect(t.session.sources.map((s) => s.marker)).toEqual(["a", "b", "c"]);
  });

  it("caps a merged stream at eight pods and says so", async () => {
    const t = setup();
    t.setPods(Array.from({ length: 10 }, (_, i) => pod(`web-${i}`)));
    t.streams.configure(cfgFor("deployments", "web"));
    await t.settle();
    expect(t.opened).toHaveLength(8);
    expect(t.texts()).toEqual(["showing 8 of 10 pods"]);
  });

  it("resolves a selector target through a pod watch", async () => {
    const t = setup();
    t.setPods([pod("api-1"), pod("api-2")]);
    t.streams.configure({ context: "ctx", target: { by: "selector", namespace: "ns", selector: "app=api" }, container: "*", since: "tail", previous: false });
    expect(t.tables[0].query).toMatchObject({ namespace: "ns", labelSelector: "app=api", gvr: { resource: "pods" } });
    const row = (name: string) => ({ uid: `u-${name}`, name, namespace: "ns", cells: [] });
    t.tables[0].emit({ type: "snapshot", columns: [], rows: [row("api-1")] });
    await t.settle(300);
    expect(t.live().map((o) => o.query.targets[0].pod)).toEqual(["api-1"]);
    t.tables[0].emit({ type: "delta", upserts: [row("api-2")], deletes: ["u-api-1"] });
    await t.settle(300);
    expect(t.live().map((o) => o.query.targets[0].pod)).toEqual(["api-2"]);
    t.streams.detach();
    expect(t.tables[0].closed).toBe(true);
  });

  it("a failed resolve shows the error and is retried", async () => {
    const t = setup();
    t.setPods(new Error("dial tcp: timeout"));
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    expect(t.session.status).toEqual({ phase: "error", message: "dial tcp: timeout" });
    t.setPods([pod("a")]);
    await t.settle(5000);
    expect(t.session.status.phase).toBe("streaming");
    expect(t.opened).toHaveLength(1);
  });

  it("a remount within the buffer's lifetime reattaches with a gap marker", async () => {
    const t = setup();
    const cfg = cfgFor("pods", "a");
    t.streams.configure(cfg);
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(20, "before")] });
    await t.settle();
    t.streams.detach();
    expect(t.opened[0].closed).toBe(true);
    expect(t.watches[t.watches.length - 1]).toBeNull();

    t.streams.configure(cfg);
    await t.settle();
    expect(t.opened[1].query.sinceSeconds).toBe(11);
    t.opened[1].emit({ type: "lines", lines: [t.line(20, "before"), t.line(25, "after")] });
    await t.settle();
    expect(t.rows().map((e) => e.kind)).toEqual([LINE, GAP, LINE]);
    expect(t.texts()).toEqual(["before", "reattached", "after"]);
  });

  it("another target after a detach starts from an empty buffer", async () => {
    const t = setup();
    t.setPods([pod("a"), pod("b")]);
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(1, "from a")] });
    await t.settle();
    t.streams.detach();
    t.streams.configure(cfgFor("pods", "b"));
    await t.settle();
    expect(t.texts()).toEqual([]);
    expect(t.session.sources.map((s) => s.pod)).toEqual(["b"]);
  });

  it("a follow link that moves the target keeps the buffer and shows the seam", async () => {
    const t = setup();
    t.setPods([pod("a"), pod("b")]);
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(1, "from a")] });
    await t.settle();
    t.streams.configure(cfgFor("pods", "b"));
    await t.settle();
    expect(t.opened[0].closed).toBe(true);
    expect(t.texts()).toEqual(["from a", "target changed to b"]);
    expect(t.opened[1].query).toMatchObject({ tailLines: 500 });
  });

  it("changing container or since clears the buffer; an unchanged config does nothing", async () => {
    const t = setup();
    t.setPods([pod("a", { containers: ["main", "sidecar"] })]);
    const cfg = cfgFor("pods", "a");
    t.streams.configure(cfg);
    await t.settle();
    t.opened[0].emit({ type: "lines", lines: [t.line(1, "x")] });
    await t.settle();
    t.streams.configure({ ...cfg });
    await t.settle();
    expect(t.opened).toHaveLength(2);
    t.streams.configure({ ...cfg, container: "main" });
    await t.settle();
    expect(t.texts()).toEqual([]);
    expect(t.live().map((o) => o.query.targets[0].container)).toEqual(["main"]);
  });

  it("ignores events of a stream it has closed", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a"));
    await t.settle();
    const old = t.opened[0];
    t.streams.detach();
    old.emit({ type: "lines", lines: [t.line(1, "late")] });
    await t.settle();
    expect(t.texts()).toEqual([]);
  });

  it("head mode starts paused at the top", async () => {
    const t = setup();
    t.streams.configure(cfgFor("pods", "a", { since: "head" }));
    await t.settle();
    expect(t.session.headMode).toBe(true);
    expect(t.session.follow).toBe(false);
    expect(t.opened[0].query.tailLines).toBeUndefined();
    expect(t.opened[0].query.sinceSeconds).toBeUndefined();
  });
});

describe("StreamManager with merged objects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:30Z"));
  });
  afterEach(() => vi.useRealTimers());

  const objects = (...names: string[]): StreamConfig => ({
    context: "ctx",
    target: { by: "objects", refs: names.map((name) => ({ gvr: { group: "", version: "v1", resource: "pods" }, namespace: "ns", name })) },
    container: "*", since: "tail", previous: false,
  });

  it("opens one stream per marked pod, parsed, with one marker per pod", async () => {
    const t = setup();
    t.setPods([pod("a"), pod("b"), pod("c")]);
    t.streams.configure(objects("a", "c"));
    await t.settle();
    expect(t.live().map((o) => o.query.targets[0].pod).sort()).toEqual(["a", "c"]);
    expect(t.live().every((o) => o.query.parse === true)).toBe(true);
    t.live()[0].emit({ type: "lines", lines: [{ ...t.line(1, "x", "a/main"), level: "warn", msg: "x" }] });
    await t.settle();
    expect(t.rows()[0]).toMatchObject({ text: "x", plevel: "warn", msg: "x" });
    expect(t.session.sources.map((s) => `${s.marker}${s.podIndex}${s.namespace}`)).toEqual(["a0ns", "b1ns"]);
    expect(t.session.gutterMode).toBe("pod");
  });

  it("streams only the marked pods that still exist", async () => {
    const t = setup();
    t.setPods([pod("a")]);
    t.streams.configure(objects("a", "gone"));
    await t.settle();
    expect(t.live().map((o) => o.query.targets[0].pod)).toEqual(["a"]);
  });
});
