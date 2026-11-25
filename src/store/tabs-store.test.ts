// Context tabs against the real stores (§8.2): a switch keeps the tab left behind open and warm,
// its shells keep running and its tables stay watched; closing the tab ends them, its workspace stays.
import { beforeAll, describe, expect, it } from "vitest";
import type { ViewState, Workspace } from "../types";
import { warmQueries } from "../table/warm";
import { addSession, getSession, initSessions } from "../views/shell/state";
import { getWorkspace, layoutStore, openTabs, openWorkspaces, removeTab, replaceView, sanitizeLayout, setLayoutContext, tabContexts } from "./layout";

const shell = (session: string): ViewState => ({
  kind: "shell",
  target: { by: "object", ref: { gvr: { group: "", version: "v1", resource: "pods" }, namespace: "shop", name: "web-1" } },
  session,
} as ViewState);

beforeAll(async () => {
  await layoutStore.hydrated;
  initSessions();
});

describe("context tabs", () => {
  it("a switch opens a tab and keeps the one left behind", () => {
    setLayoutContext("dev", 1440);
    setLayoutContext("prod", 1440);
    expect(openTabs()).toEqual(["dev", "prod"]);
    expect(layoutStore.getState().current).toBe("prod");
    expect(openWorkspaces().map((w) => w.context).sort()).toEqual(["dev", "prod"]);
    expect(tabContexts().sort()).toEqual(["dev", "prod"]);
  });

  it("a shell in a tab that is not on screen keeps running until its tab closes", () => {
    setLayoutContext("dev", 1440);
    const ws = getWorkspace() as Workspace;
    replaceView(ws.focused, shell("s1"));
    addSession({ id: "s1", kind: "shell", context: "dev", namespace: "shop", pod: "web-1" });
    setLayoutContext("prod", 1440);
    expect(getSession("s1")?.status).toBe("connecting");

    removeTab("dev");
    expect(openTabs()).toEqual(["prod"]);
    expect(getSession("s1")).toBeUndefined();
    // the workspace is remembered: opening dev again lands where it was
    expect(layoutStore.getState().workspaces.dev?.panes[ws.focused]).toBeDefined();
  });

  it("the tab on screen is never removed", () => {
    removeTab("prod");
    expect(openTabs()).toEqual(["prod"]);
  });

  it("tables of background tabs are watched with the query their pane uses", () => {
    setLayoutContext("dev", 1440);
    setLayoutContext("prod", 1440);
    const dev = layoutStore.getState().workspaces.dev;
    const keys = [...warmQueries([dev]).values()];
    expect(keys.every((q) => q.context === "dev")).toBe(true);
  });

  it("restores the tab strip, dropping contexts without a workspace", () => {
    const s = layoutStore.getState();
    const out = sanitizeLayout({ workspaces: s.workspaces, current: "prod", tabs: ["dev", "gone", "prod"] });
    expect(out.tabs).toEqual(["dev", "prod"]);
    expect(sanitizeLayout({ workspaces: s.workspaces, current: "prod" }).tabs).toEqual(["prod"]);
  });
});
