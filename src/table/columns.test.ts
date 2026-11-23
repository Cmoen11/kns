import { describe, expect, it } from "vitest";
import type { Column } from "../ipc/types";
import { buildSpecs, fitColumns, HYSTERESIS, NAME_COMFORT, orderSpecs, statusColumnId, threshold, type ColSpec } from "./columns";

const col = (name: string, type = "string", priority = 0): Column => ({ name, type, format: "", description: "", priority });
const PODS = [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age"), col("IP", "string", 1), col("Node", "string", 1), col("Nominated Node", "string", 1)];
const pods = (o: { ns?: boolean; metrics?: boolean } = {}) =>
  buildSpecs({ resource: "pods", flux: false, columns: PODS, namespaceColumn: !!o.ns, metrics: o.metrics ?? true });
/** names that fit the 120px minimum: the plain thresholds of the §12.2 table (no NAME_COMFORT reserve) */
const shortNames = (specs: ColSpec[]): ColSpec[] => specs.map((c) => (c.role === "name" ? { ...c, ideal: c.min } : c));
const ids = (specs: ColSpec[], width: number, wide = false, prevCount = -1) =>
  fitColumns({ specs, width, wide, prevCount }).cols.map((c) => (c.glyphOnly ? `${c.spec.id}*` : c.spec.id));

describe("buildSpecs", () => {
  it("pods: tiers of §12.2, CPU and MEM after AGE", () => {
    const s = pods();
    expect(s.map((c) => `${c.id}:${c.tier}`)).toEqual([
      "name:0", "ready:1", "status:1", "restarts:2", "age:2", "@cpu:3", "@mem:3", "@spark:5", "ip:4", "node:4", "nominated node:5",
    ]);
    expect(s.find((c) => c.id === "status")?.role).toBe("status");
    expect(s.find((c) => c.id === "age")).toMatchObject({ role: "age", delta: false });
    expect(s.find((c) => c.id === "@cpu")).toMatchObject({ delta: false, numeric: true });
  });
  it("no metrics-server: CPU and MEM are not in the set", () => {
    expect(pods({ metrics: false }).some((c) => c.id.startsWith("@"))).toBe(false);
  });
  it("all namespaces adds NAMESPACE at tier 1", () => {
    expect(pods({ ns: true })[1]).toMatchObject({ id: "@ns", tier: 1, min: 96, short: "NS" });
  });
  it("workloads get a derived STATUS column", () => {
    const s = buildSpecs({ resource: "deployments", flux: false, columns: [col("Name"), col("Ready"), col("Up-to-date", "integer"), col("Available", "integer"), col("Age")], namespaceColumn: false, metrics: false });
    expect(s.map((c) => `${c.id}:${c.tier}`)).toEqual(["name:0", "@status:1", "ready:1", "up-to-date:2", "available:3", "age:2"]);
  });
  it("CRDs: first two priority-0 columns tier 1, AGE 2, the rest 3, priority>0 tier 5", () => {
    const s = buildSpecs({ resource: "widgets", flux: false, columns: [col("Name"), col("Size"), col("Colour"), col("Owner"), col("Age"), col("Notes", "string", 1)], namespaceColumn: false, metrics: false });
    expect(s.map((c) => `${c.id}:${c.tier}`)).toEqual(["name:0", "size:1", "colour:1", "owner:3", "age:2", "notes:5"]);
  });
  it("flux kinds: the glyph sits on READY", () => {
    expect(statusColumnId("kustomizations", true, ["name", "age", "ready", "status"])).toBe("ready");
    const s = buildSpecs({ resource: "kustomizations", flux: true, columns: [col("Name"), col("Age"), col("Ready"), col("Status")], namespaceColumn: false, metrics: false });
    expect(s.map((c) => `${c.id}:${c.tier}:${c.role}`)).toEqual(["name:0:name", "age:2:age", "ready:1:status", "status:1:cell"]);
  });
  it("events: the involved object is the name column, the type carries the glyph", () => {
    const s = buildSpecs({ resource: "events", flux: false, columns: [col("Last Seen"), col("Type"), col("Reason"), col("Object"), col("Message")], namespaceColumn: false, metrics: false });
    expect(s[0]).toMatchObject({ id: "object", role: "name" });
    expect(s.find((c) => c.id === "type")?.role).toBe("status");
    expect(s.find((c) => c.id === "message")?.grow).toBe(true);
  });
  it("kinds without a status have no status column", () => {
    const s = buildSpecs({ resource: "configmaps", flux: false, columns: [col("Name"), col("Data", "integer"), col("Age")], namespaceColumn: false, metrics: false });
    expect(s.some((c) => c.role === "status")).toBe(false);
  });
});

describe("fitColumns (pods thresholds of §12.2)", () => {
  const s = shortNames(pods());
  it("thresholds: 228 STATUS, 272 READY, 356 RST+AGE, 460 CPU+MEM, 684 NODE+IP", () => {
    expect(threshold(s, 1)).toBe(228);
    expect(threshold(s, 2)).toBe(272);
    expect(threshold(s, 4)).toBe(356);
    expect(threshold(s, 6)).toBe(460);
    expect(threshold(s, 8)).toBe(684);
  });
  it("at the 160px floor: NAME and the status glyph alone", () => {
    expect(ids(s, 160)).toEqual(["name", "status*"]);
    expect(fitColumns({ specs: s, width: 160, wide: false, prevCount: -1 }).cols.map((c) => c.width)).toEqual([120, 20]);
  });
  it("at the 240px pane minimum: NAME and STATUS", () => {
    expect(ids(s, 240)).toEqual(["name", "status"]);
  });
  it("hides by tier, rightmost of a tier first, in display order", () => {
    expect(ids(s, 272)).toEqual(["name", "ready", "status"]);
    expect(ids(s, 320)).toEqual(["name", "ready", "status", "restarts"]);
    expect(ids(s, 356)).toEqual(["name", "ready", "status", "restarts", "age"]);
    expect(ids(s, 700)).toEqual(["name", "ready", "status", "restarts", "age", "@cpu", "@mem", "ip", "node"]);
  });
  it("tier 5 shows only with wide on, and then the table may exceed the pane", () => {
    expect(ids(s, 2000)).not.toContain("nominated node");
    const wide = fitColumns({ specs: s, width: 300, wide: true, prevCount: -1 });
    expect(wide.cols.map((c) => c.spec.id)).toContain("nominated node");
    expect(wide.total).toBeGreaterThan(300);
  });
  it("all namespaces shifts every threshold by 96", () => {
    const n = pods({ ns: true });
    // tier 1 is now STATUS, NS, READY
    expect(threshold(n, 3)).toBe(272 + 96);
    expect(threshold(n, 5)).toBe(356 + 96);
  });
  it("no metrics: later tiers move down by the freed width", () => {
    const n = shortNames(pods({ metrics: false }));
    expect(threshold(n, 6)).toBe(684 - 48 - 56);
  });
  it("hysteresis: a column appears at threshold + 24 and hides below the threshold", () => {
    expect(ids(s, 272 + HYSTERESIS - 1, false, 1)).toEqual(["name", "status"]);
    expect(ids(s, 272 + HYSTERESIS, false, 1)).toEqual(["name", "ready", "status"]);
    expect(ids(s, 272, false, 2)).toEqual(["name", "ready", "status"]);
    expect(ids(s, 271, false, 2)).toEqual(["name", "status"]);
  });
  it("spare width goes to the columns' ideal first, the rest to NAME, and the sum fills the pane", () => {
    const withIdeal = s.map((c) => (c.id === "status" ? { ...c, ideal: 140 } : c));
    const fit = fitColumns({ specs: withIdeal, width: 560, wide: false, prevCount: -1 });
    expect(fit.cols.find((c) => c.spec.id === "status")?.width).toBe(140);
    expect(fit.total).toBe(560);
    expect(fit.cols.reduce((n, c) => n + c.width, 0)).toBe(560 - 20);
  });
  it("tier 4 (IP, NODE) waits until NAME can show its content, up to NAME_COMFORT", () => {
    const long = s.map((c) => (c.id === "name" ? { ...c, ideal: 300 } : c));
    // 684 fits every minimum, but the names would be cut to 120px: IP and NODE stay out
    expect(ids(long, 684 - 120 + NAME_COMFORT - 120 - 1)).toEqual(["name", "ready", "status", "restarts", "age", "@cpu", "@mem"]);
    expect(ids(long, 684 + NAME_COMFORT - 120 - 1)).not.toContain("node");
    expect(ids(long, 684 + NAME_COMFORT - 120)).toContain("node");
    // names of 160px need 40 more, not the whole reserve
    const mid = s.map((c) => (c.id === "name" ? { ...c, ideal: 160 } : c));
    expect(ids(mid, 684 + 39)).not.toContain("node");
    expect(ids(mid, 684 + 40)).toContain("node");
    // a width the user set on NAME is the user's call: no reserve
    const o = { order: [], hidden: [], pinned: [], widths: { name: 120 } };
    expect(fitColumns({ specs: long, width: 684, wide: false, prevCount: -1, overrides: o }).cols.map((c) => c.spec.id)).toContain("node");
  });
  it("NAME reaches its content width before the other columns grow", () => {
    const withIdeal = s.map((c) => (c.id === "name" ? { ...c, ideal: 200 } : c.id === "node" ? { ...c, ideal: 300 } : c));
    // 700: without IP and NODE (NAME could not reach 200 next to them) the rest uses 460, NAME takes its 200
    expect(fitColumns({ specs: withIdeal, width: 700, wide: false, prevCount: -1 }).cols.find((c) => c.spec.id === "name")?.width).toBeGreaterThanOrEqual(200);
    const fit = fitColumns({ specs: withIdeal, width: 900, wide: false, prevCount: -1 });
    expect(fit.cols.find((c) => c.spec.id === "name")?.width).toBe(200);
    expect(fit.cols.find((c) => c.spec.id === "node")?.width).toBe(120 + 900 - 684 - 80);
    expect(fit.total).toBe(900);
  });
  it("a user width on NAME is a floor: the spare width still goes to it", () => {
    const o = { order: [], hidden: [], pinned: [], widths: { name: 130 } };
    const narrow = fitColumns({ specs: s, width: 694, wide: false, prevCount: -1, overrides: o });
    expect(narrow.cols.find((c) => c.spec.id === "name")?.width).toBe(130);
    const fit = fitColumns({ specs: s, width: 1200, wide: false, prevCount: -1, overrides: o });
    expect(fit.total).toBe(1200);
    expect(fit.cols.reduce((n, c) => n + c.width, 0)).toBe(1200 - 20);
    expect(fit.cols.find((c) => c.spec.id === "name")?.width).toBe(130 + 1200 - 694);
  });
  it("overrides: hidden, pinned (tier 0) and user widths", () => {
    const o = { order: [], hidden: ["ready"], pinned: ["node"], widths: { status: 100 } };
    const fit = fitColumns({ specs: s, width: 400, wide: false, prevCount: -1, overrides: o });
    const shown = fit.cols.map((c) => c.spec.id);
    expect(shown).not.toContain("ready");
    expect(shown).toContain("node");
    expect(fit.cols.find((c) => c.spec.id === "status")?.width).toBe(100);
    expect(ids(s, 160 + 120)).not.toContain("node");
    expect(fitColumns({ specs: s, width: 160 + 120, wide: false, prevCount: -1, overrides: o }).cols.map((c) => c.spec.id)).toContain("node");
  });
});

describe("orderSpecs", () => {
  it("applies the user order, keeps NAME first and unknown columns in natural order", () => {
    const s = pods({ metrics: false });
    expect(orderSpecs(s, ["age", "name", "status"]).map((c) => c.id)).toEqual(["name", "age", "status", "ready", "restarts", "ip", "node", "nominated node"]);
    expect(orderSpecs(s, []).map((c) => c.id)).toEqual(s.map((c) => c.id));
  });
});
