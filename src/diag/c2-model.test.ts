import { describe, expect, it } from "vitest";
import type { TimelineRow, Trap } from "../ipc/types";
import { appendSample, GAP, mergeSeed, SLOT_MS, sparkPeak, sparkText } from "./spark";
import { logsTarget, nextSince, parseSince, rowTarget, sinceLabel, timeLabel } from "./timeline-model";
import { journalStatusText, parseJournalArg, rowBundle, trapDetail, trapRows, trapStatusText, untilFor } from "./traps-model";

const pod = { group: "", version: "v1", resource: "pods" };
const row = (over: Partial<TimelineRow> = {}): TimelineRow => ({
  at: "2026-11-22T10:05:30Z",
  source: "event",
  what: "Pod/web-1: BackOff ×2: x",
  ref: { context: "c", gvr: pod, namespace: "ns", name: "web-1" },
  severity: "warn",
  ...over,
});

describe("timeline model", () => {
  it("parses :timeline windows", () => {
    expect(parseSince([])).toBe(60);
    expect(parseSince(["180"])).toBe(180);
    expect(parseSince(["3h"])).toBe(180);
    expect(parseSince(["2d"])).toBe(2880);
    expect(parseSince(["30d"])).toBe(7 * 1440);
    expect(parseSince(["0"])).toBeNull();
    expect(parseSince(["soon"])).toBeNull();
    expect(sinceLabel(60)).toBe("1h");
    expect(sinceLabel(2880)).toBe("2d");
    expect(sinceLabel(45)).toBe("45m");
    expect(nextSince(60, 1)).toBe(180);
    expect(nextSince(60, -1)).toBe(15);
  });

  it("Enter describes the row's object; rows without one open nothing", () => {
    expect(rowTarget(row())).toMatchObject({ kind: "doc", format: "describe", ref: { name: "web-1", namespace: "ns" } });
    expect(rowTarget(row({ ref: undefined }))).toBeNull();
  });

  it("l opens the pod's logs around the row's time", () => {
    const now = Date.parse("2026-11-22T10:08:00Z");
    const base = { gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "ns", name: "web" };
    const v = logsTarget(row(), base, now);
    expect(v?.since).toBe("5m");
    expect(v?.timestamps).toBe(true);
    expect(v?.target).toEqual({ by: "object", ref: { gvr: pod, namespace: "ns", name: "web-1" } });
    expect(v?.match).toEqual({ mode: "re", text: "2026-11-22T10:05" });
    // a ReplicaSet row: the timeline's own workload; older than an hour: the tail
    const rs = row({ ref: { context: "c", gvr: { group: "apps", version: "v1", resource: "replicasets" }, namespace: "ns", name: "web-1" }, at: "2026-11-22T07:00:00Z" });
    const w = logsTarget(rs, base, now);
    expect(w?.target).toEqual({ by: "object", ref: base });
    expect(w?.since).toBe("tail");
    // a terminated container: the previous run
    expect(logsTarget(row({ source: "container", what: "container main terminated: exit 1" }), base, now)?.previous).toBe(true);
    // a node row on a Service-less kind: nothing
    expect(logsTarget(row({ ref: { context: "c", gvr: { group: "", version: "v1", resource: "nodes" }, name: "n1" } }), { ...base, gvr: { group: "", version: "v1", resource: "configmaps" } }, now)).toBeNull();
  });

  it("labels today's times by the clock, older ones with the date", () => {
    const now = new Date(2026, 10, 22, 12, 0, 0);
    expect(timeLabel(new Date(2026, 10, 22, 10, 5, 3).toISOString(), now)).toBe("10:05:03");
    expect(timeLabel(new Date(2026, 10, 21, 9, 4, 0).toISOString(), now)).toBe("11-21 09:04");
  });
});

describe("sparklines", () => {
  const now = 1_000_000_000;
  const s = (slotsAgo: number, mb: number) => ({ at: now - slotsAgo * SLOT_MS + 1, cpuMilli: 1, memBytes: mb * 1048576 });

  it("draws one block per sample, pads on the left and marks missed slots", () => {
    const text = sparkText([s(4, 10), s(3, 20), s(1, 40), s(0, 30)], now, 6);
    expect(text).toBe(" ▁▃·█▆");
    // jitter (14 s and 16 s apart) is not a gap
    const jitter = sparkText([{ at: now - 30_000, cpuMilli: 0, memBytes: 1 }, { at: now - 16_000, cpuMilli: 0, memBytes: 2 }, { at: now - 1_000, cpuMilli: 0, memBytes: 3 }], now, 3);
    expect(jitter).not.toContain(GAP);
    // polling stopped a minute ago: trailing gaps
    expect(sparkText([s(5, 1), s(4, 2)], now, 6).endsWith(GAP.repeat(3))).toBe(true);
  });

  it("is empty without samples, low for a flat series", () => {
    expect(sparkText([], now)).toBe("");
    expect(sparkText([s(1, 5), s(0, 5)], now, 2)).toBe("▁▁");
    expect(sparkPeak([s(1, 5), s(0, 9)], now)).toBe(9 * 1048576);
  });

  it("appends at most one sample per 10 s and merges a seed by time", () => {
    let series = appendSample([], { at: 0, cpuMilli: 1, memBytes: 1 });
    series = appendSample(series, { at: 5_000, cpuMilli: 2, memBytes: 2 });
    series = appendSample(series, { at: 15_000, cpuMilli: 3, memBytes: 3 });
    expect(series.map((x) => x.at)).toEqual([0, 15_000]);
    const merged = mergeSeed(series, [{ at: -15_000, cpuMilli: 0, memBytes: 0 }, { at: 2_000, cpuMilli: 9, memBytes: 9 }]);
    expect(merged.map((x) => x.at)).toEqual([-15_000, 0, 15_000]);
  });
});

describe("traps model", () => {
  const trap = (over: Partial<Trap> = {}): Trap => ({
    id: "t1",
    ref: { context: "c", gvr: pod, namespace: "ns", name: "web-1" },
    armedAt: "2026-11-22T10:00:00Z",
    triggers: ["restart", "oomKilled"],
    fired: [],
    ...over,
  });

  it("lists bundles under their trap, newest first; Enter opens the newest", () => {
    const t = trap({ fired: [{ at: "2026-11-22T10:01:00Z", bundleId: "b1" }, { at: "2026-11-22T10:02:00Z", bundleId: "b2" }] });
    const rows = trapRows([t, trap({ id: "t2" })]);
    expect(rows.map((r) => r.key)).toEqual(["t1", "t1/b2", "t1/b1", "t2"]);
    expect(rowBundle(rows[0])).toBe("b2");
    expect(rowBundle(rows[2])).toBe("b1");
    expect(rowBundle(rows[3])).toBeNull();
    expect(trapDetail(t)).toBe("restart, OOMKilled · fired 2×");
    expect(trapStatusText([t, trap()])).toBe("2 armed · fired 2×");
    expect(trapStatusText([])).toBeNull();
  });

  it("reads :journal arguments and the status", () => {
    expect(parseJournalArg([], false)).toBe(true);
    expect(parseJournalArg([], true)).toBe(false);
    expect(parseJournalArg(["on"], true)).toBe(true);
    expect(parseJournalArg(["OFF"], true)).toBe(false);
    expect(parseJournalArg(["maybe"], true)).toBeNull();
    expect(journalStatusText([{ context: "default", on: true, rows: 3, bytes: 9 }])).toBe("on for default");
    expect(journalStatusText([{ context: "a", on: true, rows: 0, bytes: 0 }, { context: "b", on: true, rows: 0, bytes: 0 }])).toBe("on for 2 contexts");
    expect(journalStatusText([{ context: "a", on: false, rows: 9, bytes: 9 }])).toBeNull();
  });

  it("turns a duration into an until time", () => {
    expect(untilFor("open")).toBeUndefined();
    expect(untilFor("1h", 0)).toBe(new Date(3_600_000).toISOString());
  });
});
