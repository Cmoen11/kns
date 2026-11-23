import { describe, expect, it } from "vitest";
import toolsMd from "../../docs/tools.md?raw";
import { KEYMAP_ROWS } from "../actions/keymap-data";
import { NOT_BUILT_FEATURES } from "../features.pending";
import type { CurrentObject } from "../store/current";
import type { ObjectRef } from "../types";
import { ALLOWED_TAGS, blockTag, inlineTag, parseMarkdown, type Inline } from "../views/text/markdown";
import { registerTool, STATUS_BY, STATUSLESS, toolById, TOOLS, type ToolEntry } from "./catalog";
import { docAnchor, docAnchors, docSection, docSections, hubRows, mousePaths, refLabel, resolveTry, rowIndex, stepRow, viewFits, type TryEnv } from "./model";
import { HUB_STATUS, mcpStatusLine } from "./status";

const ref = (resource: string, name: string, group = ""): ObjectRef => ({ gvr: { group, version: "v1", resource }, namespace: "kns-spike", name, uid: `u-${name}` });
const cur = (r: ObjectRef, over: Partial<CurrentObject> = {}): CurrentObject => ({ paneId: "p1", ref: r, marked: [], kind: "table", ...over });
const env = (over: Partial<TryEnv> = {}): TryEnv => ({
  focused: "p2", focusedKind: "hub", previousKind: null, current: null, label: (id) => id.split(".").pop()!, ...over,
});
/** A copy of an entry that reports itself built, with a given try. */
const built = (t: ToolEntry, tr?: ToolEntry["try"]): ToolEntry => ({ ...t, built: () => true, try: tr ?? t.try });

describe("catalog coverage", () => {
  it("lists every feature entry point (commands and view openers of §2.7) under some tool", () => {
    const named = new Set(TOOLS.flatMap((t) => [...t.actions, ...(t.try ? [t.try.action] : [])]));
    const feature = new Set<string>(NOT_BUILT_FEATURES);
    const entry = KEYMAP_ROWS.filter((r) => feature.has(r.id) && (r.command || r.opens) && !/^(picker\.|env\.|dev\.(up|down|edit|delete)$|agents\.(revoke|stopServer)$|hub\.)/.test(r.id));
    expect(entry.map((r) => r.id).filter((id) => !named.has(id as never))).toEqual([]);
  });

  it("has a docs/tools.md section for every tool", () => {
    const anchors = new Set(docAnchors(toolsMd));
    expect(TOOLS.map((t) => docAnchor(t.doc)).filter((a) => !anchors.has(a))).toEqual([]);
    expect(anchors.has("agents")).toBe(true);
    expect(toolsMd).toContain("<!-- mcp:begin -->");
    expect(toolsMd).toContain("<!-- mcp:end -->");
  });

  it("puts every tool in exactly one status bucket", () => {
    for (const t of TOOLS) {
      const n = (STATUSLESS.has(t.id) ? 1 : 0) + (STATUS_BY[t.id] ? 1 : 0);
      expect(n, t.id).toBe(1);
    }
    for (const [id, by] of Object.entries(STATUS_BY)) if (by.startsWith("hub") || by.includes("hub fallback")) expect(HUB_STATUS[id as never], id).toBeTypeOf("function");
  });
});

describe("registerTool", () => {
  it("replaces an entry in place and keeps the order", () => {
    const before = TOOLS.map((t) => t.id);
    const why = toolById("why")!;
    registerTool({ ...why, summary: "refined by C1" });
    expect(toolById("why")?.summary).toBe("refined by C1");
    expect(TOOLS.map((t) => t.id)).toEqual(before);
    registerTool({ ...why });
  });
});

describe("hub rows", () => {
  it("groups in order and filters on title, summary, commands and help", () => {
    const rows = hubRows(TOOLS);
    expect(rows[0]).toMatchObject({ type: "group", label: "Basics" });
    expect(rows.filter((r) => r.type === "group").map((r) => r.label)).toEqual(["Basics", "Debug", "Logs", "Diff", "Local dev", "Agents"]);
    const why = hubRows(TOOLS, "broken").filter((r) => r.type === "item").map((r) => r.key);
    expect(why).toContain("why");
    expect(hubRows(TOOLS, ":diff applied").some((r) => r.key === "diff")).toBe(true);
    expect(hubRows(TOOLS, "zzzz-nothing")).toEqual([]);
  });

  it("walks items only and finds the selected tool", () => {
    const rows = hubRows(TOOLS);
    const i = rowIndex(rows, "why");
    expect(rows[i]).toMatchObject({ key: "why" });
    expect(rows[rowIndex(rows, undefined)]).toMatchObject({ key: "palette" });
    const next = stepRow(rows, rowIndex(rows, "filter"), 1); // across the "Debug" label
    expect(rows[next]).toMatchObject({ key: "why" });
    expect(rows[stepRow(rows, -1, rows.length)].type).toBe("item");
  });
});

describe("try it", () => {
  const why = built(toolById("why")!);

  it("runs on the table the hub was opened over in place: back first, then wait for its cursor", () => {
    const pod = ref("pods", "crashy");
    const plan = resolveTry(why, env({ focused: "p1", focusedKind: "hub", previousKind: "table", current: cur(pod) }));
    expect(plan).toMatchObject({ ok: true, pane: "p1", back: true, waitFor: pod, label: "Try: why → pod/crashy" });
  });

  it("runs in another visible table without going back", () => {
    const plan = resolveTry(why, env({ focused: "p2", current: cur(ref("deployments", "web", "apps"), { paneId: "p1" }) }));
    expect(plan).toMatchObject({ ok: true, pane: "p1", back: false, label: "Try: why → deployment/web" });
  });

  it("says what is missing", () => {
    expect(resolveTry(why, env())).toMatchObject({ ok: false, reason: "select a row in a table first" });
    const debug = built(toolById("debug")!);
    expect(resolveTry(debug, env({ current: cur(ref("services", "web")) }))).toMatchObject({ ok: false, reason: "select a pod first" });
    const env_ = built(toolById("env")!);
    expect(resolveTry(env_, env({ current: cur(ref("services", "web")) })).ok).toBe(false);
    expect(resolveTry(env_, env({ current: cur(ref("statefulsets", "db", "apps")) })).ok).toBe(true);
    const diff = built(toolById("diff")!);
    expect(resolveTry(diff, env({ current: cur(ref("pods", "a")) }))).toMatchObject({ ok: false, reason: "mark two rows first (Space)" });
    const marked = [ref("pods", "a"), ref("pods", "b")];
    expect(resolveTry(diff, env({ current: cur(ref("pods", "a"), { marked, paneId: "p1" }) }))).toMatchObject({ ok: true, label: "Try: diff → 2 marked" });
    // marks do not survive going back to a table
    expect(resolveTry(diff, env({ focused: "p1", current: cur(ref("pods", "a"), { marked }) })).ok).toBe(false);
  });

  it("does not try unbuilt tools", () => {
    expect(resolveTry({ ...toolById("why")!, built: () => false }, env({ current: cur(ref("pods", "x")) }))).toMatchObject({ ok: false, reason: "not built yet" });
  });

  it("marks writing tools and keeps the container of a containers view", () => {
    const debug = built(toolById("debug")!);
    const plan = resolveTry(debug, env({ current: cur(ref("pods", "web-1"), { paneId: "p1", kind: "containers", container: "nginx" }) }));
    expect(plan).toMatchObject({ ok: true, writes: true, label: "Try: debug → pod/web-1 · nginx" });
  });

  it("finds a logs pane for log tools", () => {
    const st = built(toolById("logs-structured")!);
    expect(resolveTry(st, env())).toMatchObject({ ok: false });
    expect(resolveTry(st, env({ panes: { logsPane: ["p3"] } }))).toMatchObject({ ok: true, pane: "p3", back: false });
    expect(resolveTry(st, env({ focused: "p1", previousKind: "logs", previousFits: ["logsPane"] }))).toMatchObject({ ok: true, pane: "p1", back: true });
    expect(resolveTry(st, env({ focused: "p3", focusedKind: "logs", focusedFits: ["logsPane"] }))).toMatchObject({ ok: true, pane: "p3", back: false, label: "Try: structured → these logs" });
  });

  it("finds a YAML view, the env view or the forwards for the tools that work there", () => {
    const owners = built(toolById("owners")!);
    expect(resolveTry(owners, env())).toMatchObject({ ok: false, reason: "open YAML first (y on a row)" });
    expect(resolveTry(owners, env({ panes: { yamlPane: ["p4"] } }))).toMatchObject({ ok: true, pane: "p4", label: "Try: fieldOwners → the YAML" });
    const conn = built(toolById("conn-string")!);
    expect(resolveTry(conn, env())).toMatchObject({ ok: false });
    expect(resolveTry(conn, env({ panes: { pfPane: ["p5"] } }))).toMatchObject({ ok: true, pane: "p5" });
  });

  it("reads which pane needs a view meets", () => {
    const pod = ref("pods", "x");
    expect(viewFits({ kind: "doc", ref: pod, format: "yaml", mode: "view", managedFields: false, wrap: false })).toEqual(["yamlPane"]);
    expect(viewFits({ kind: "doc", ref: pod, format: "yaml", mode: "edit", managedFields: false, wrap: false })).toEqual([]);
    expect(viewFits({ kind: "doc", ref: pod, format: "describe", mode: "view", managedFields: false, wrap: false })).toEqual([]);
    expect(viewFits({ kind: "portforwards" } as never)).toEqual(["pfPane"]);
    expect(viewFits(null)).toEqual([]);
  });

  it("opens a pod's containers for the crash card only from the pods table, with its own label", () => {
    const crash = built(toolById("crash")!);
    expect(resolveTry(crash, env({ current: cur(ref("pods", "oomy-1"), { paneId: "p1" }) }))).toMatchObject({ ok: true, label: "Try: containers → pod/oomy-1", action: "nav.open" });
    expect(resolveTry(crash, env({ current: cur(ref("pods", "oomy-1"), { paneId: "p1", kind: "containers" }) }))).toMatchObject({ ok: false, reason: "select a pod in the pods table first" });
    expect(resolveTry(crash, env({ current: cur(ref("deployments", "oomy", "apps"), { paneId: "p1" }) })).ok).toBe(false);
  });

  it("runs needs-nothing tools where the hub is", () => {
    expect(resolveTry(built(toolById("palette")!), env())).toMatchObject({ ok: true, pane: null, back: false });
  });

  it("labels refs like kubectl", () => {
    expect(refLabel(ref("ingresses", "x"))).toBe("ingress/x");
    expect(refLabel(ref("ingressclasses", "x"))).toBe("ingressclass/x");
    expect(refLabel(ref("policies", "x"))).toBe("policy/x");
  });
});

describe("mouse paths", () => {
  it("derives paths from the pointer registries", () => {
    const lists = { rowBar: new Set(["res.why"]), rowMenu: new Set(["res.why"]), bulk: new Set(["res.diff"]), windowMenu: new Set(["hub.open"]), titlebar: new Map([["hub.open", "tools"]]) };
    const label = (id: string) => ({ "res.why": "why", "res.diff": "diff marked", "hub.open": "tools" })[id] ?? "";
    expect(mousePaths(["res.why"], lists, label)).toEqual(["Hover a table row → why", "Right-click a row → why"]);
    expect(mousePaths(["res.diff"], lists, label)).toEqual(["Mark rows → bulk bar → diff marked"]);
    expect(mousePaths(["hub.open"], lists, label)).toEqual(["Titlebar: the tools button", "Titlebar ⋯ menu → tools"]);
    expect(mousePaths(["res.why", "res.diff"], { ...lists, rowBar: new Set(["res.why", "res.diff"]) }, label)[0]).toBe("Hover a table row → why, diff marked");
  });
});

describe("docs/tools.md", () => {
  it("cuts one tool's section without the next one or the anchor lines", () => {
    const s = docSection(toolsMd, "why")!;
    expect(s.title).toBe("Why is this broken?");
    expect(s.body).toContain("`W`");
    expect(s.body).not.toContain("<a id");
    expect(s.body).not.toContain("Crash card");
    const agents = docSection(toolsMd, "agents")!;
    expect(agents.body).toContain("### Threat model");
    expect(agents.body).not.toContain("mcp:begin");
    expect(docSection(toolsMd, "nope")).toBeNull();
  });

  it("splits the whole page by chapter", () => {
    const titles = docSections(toolsMd).map((s) => s.title);
    expect(titles).toEqual(["kns tools", "Getting started", "Basics", "Debug", "Logs", "Diff", "Local dev", "Agents", "Working with agents"]);
  });

  it("renders only through the allowed tags", () => {
    const allowed = new Set<string>(ALLOWED_TAGS);
    const walk = (nodes: Inline[]): void => {
      for (const n of nodes) {
        if (n.t !== "text") expect(allowed.has(inlineTag(n))).toBe(true);
        if (n.t === "strong" || n.t === "em") walk(n.children);
      }
    };
    for (const s of docSections(toolsMd)) {
      for (const b of parseMarkdown(s.body)) {
        expect(allowed.has(blockTag(b))).toBe(true);
        if (b.t === "heading" || b.t === "paragraph") walk(b.children);
        if (b.t === "list") b.items.forEach(walk);
      }
    }
  });
});

describe("status lines", () => {
  it("says off, or on with port and clients", () => {
    expect(mcpStatusLine(null)).toBeNull();
    expect(mcpStatusLine({ on: false, port: 7099, clients: [], tools: [] })).toEqual({ text: "off", state: "off" });
    const on = mcpStatusLine({ on: true, port: 7099, clients: [{} as never], tools: [] });
    expect(on).toEqual({ text: "on · 127.0.0.1:7099 · 1 client", state: "ok" });
  });
});
