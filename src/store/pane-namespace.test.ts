import { describe, expect, it } from "vitest";
import type { ObjectRef, PaneState, ViewState, Workspace } from "../types";
import { paneNamespaceIn, viewNamespace } from "./pane-namespace";

const pod = (namespace?: string): ObjectRef => ({ gvr: { group: "", version: "v1", resource: "pods" }, namespace, name: "p" });
const table = (namespace: string): ViewState => ({ kind: "table", gvr: { group: "", version: "v1", resource: "pods" }, namespace, filters: [], faultsOnly: false, sort: null, wide: false });
const hub: ViewState = { kind: "hub" };
const logs = (ref: ObjectRef): ViewState => ({ kind: "logs", target: { by: "object", ref }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false });

function ws(panes: Record<string, { history: ViewState[]; index?: number }>): Workspace {
  const out: Record<string, PaneState> = {};
  for (const [id, p] of Object.entries(panes)) out[id] = { id, history: p.history, index: p.index ?? p.history.length - 1 };
  return { schema: 1, context: "c", root: { kind: "leaf", pane: "a" }, panes: out, focused: "a", zoomed: null } as unknown as Workspace;
}

describe("pane namespace (`:pods` from a view without one)", () => {
  it("uses the object the view is about", () => {
    expect(viewNamespace(logs(pod("shop")))).toBe("shop");
    expect(viewNamespace({ kind: "why", ref: pod("ops") })).toBe("ops");
    expect(viewNamespace({ kind: "env", ref: pod("dev") })).toBe("dev");
    expect(viewNamespace({ kind: "shell", target: { by: "object", ref: pod("x") } })).toBe("x");
    expect(viewNamespace(table("*"))).toBe("*");
    expect(viewNamespace(hub)).toBeUndefined();
  });
  it("falls back to the newest namespaced entry of the pane's history", () => {
    const w = ws({ a: { history: [table("old"), table("kns-spike"), { kind: "doc", ref: { ...pod(), gvr: { group: "", version: "v1", resource: "nodes" } }, format: "yaml", mode: "view", managedFields: false, wrap: false }, hub] } });
    expect(paneNamespaceIn(w, "a")).toBe("kns-spike");
  });
  it("never reads entries after the current one", () => {
    const w = ws({ a: { history: [hub, table("later")], index: 0 } });
    expect(paneNamespaceIn(w, "a")).toBeUndefined();
  });
  it("follows a paneSelection target to its pane, without looping", () => {
    const w = ws({
      a: { history: [{ kind: "logs", target: { by: "paneSelection", pane: "b" }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false }] },
      b: { history: [table("web")] },
      c: { history: [{ kind: "shell", target: { by: "paneSelection", pane: "c" } }] },
    });
    expect(paneNamespaceIn(w, "a")).toBe("web");
    expect(paneNamespaceIn(w, "c")).toBeUndefined();
  });
});
