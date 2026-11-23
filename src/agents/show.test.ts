import { describe, expect, it } from "vitest";
import { agentPanes, viewFor } from "./show";
import { staleMarks } from "./drafts";

const ref = { context: "default", gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name: "crashy" };

describe("show_in_kns views", () => {
  it("maps every view, and refuses one without its target", () => {
    expect(viewFor({ view: "why", ref })).toEqual({ kind: "why", ref: { gvr: ref.gvr, namespace: "kns-spike", name: "crashy" } });
    expect(viewFor({ view: "describe", ref })).toMatchObject({ kind: "doc", format: "describe", mode: "view" });
    expect(viewFor({ view: "yaml", ref })).toMatchObject({ kind: "doc", format: "yaml", mode: "view" });
    expect(viewFor({ view: "logs", ref })).toMatchObject({ kind: "logs", target: { by: "object" } });
    expect(viewFor({ view: "timeline", ref })).toMatchObject({ kind: "timeline", sinceMinutes: 60 });
    expect(viewFor({ view: "devset", devSet: "ds-1" })).toEqual({ kind: "devsets", selected: "ds-1" });
    expect(viewFor({ view: "devset" })).toBeNull();
    expect(viewFor({ view: "why" })).toBeNull();
  });

  it("orders agent panes oldest first and forgets closed ones", () => {
    const panes = { a: {}, b: { agent: "claude-code" }, c: { agent: "claude-code" } };
    expect(agentPanes(panes, ["c", "x"])).toEqual(["c", "b"]);
    expect(agentPanes({ a: {} }, ["b"])).toEqual([]);
  });
});

describe("agent drafts", () => {
  it("are swept once their pane stops editing (or after a reload)", () => {
    const m = (key: string, pane: string | null) => ({ key, text: "t", pane, at: 0 });
    const editing = (p: string) => p === "live";
    expect(staleMarks([m("a", "live"), m("b", "gone"), m("c", null)], editing).map((x) => x.key)).toEqual(["b", "c"]);
  });
});

describe("agent panes after a reload", () => {
  it("are not restored (they would pass as the human's own without the AGENT label)", async () => {
    const { sanitizeWorkspace } = await import("../store/workspace");
    const home = { kind: "home" };
    const raw = {
      root: { kind: "split", id: "s", dir: "row", children: [{ kind: "leaf", pane: "a" }, { kind: "leaf", pane: "b" }], sizes: [0.5, 0.5] },
      panes: { a: { history: [home], index: 0 }, b: { history: [home], index: 0, agent: "claude-code" } },
      focused: "b",
      closed: [{ pane: { id: "c", history: [home], index: 0, agent: "claude-code" }, parent: "s", at: 1 }],
    };
    const ws = sanitizeWorkspace(raw, "default");
    expect(Object.keys(ws?.panes ?? {})).toEqual(["a"]);
    expect(ws?.focused).toBe("a");
    expect(ws?.closed).toEqual([]);
  });
});
