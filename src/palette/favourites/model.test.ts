import { describe, expect, it } from "vitest";
import { leafIds } from "../../store/layout-tree";
import { tableView } from "../../store/workspace";
import type { Gvr, SavedLayout, ViewState, Workspace } from "../../types";
import {
  favouriteSummary, fromFavouriteView, fromSavedLayout, matchesFavourite, sanitizeFavourites, sanitizeLayouts, toFavouriteView, toSavedLayout, treeSummary,
} from "./model";

const PODS: Gvr = { group: "", version: "v1", resource: "pods" };
const SVC: Gvr = { group: "", version: "v1", resource: "services" };
const pod = { gvr: PODS, namespace: "web", name: "api-1", uid: "u1" };

function workspace(): Workspace {
  const logs: ViewState = { kind: "logs", target: { by: "object", ref: pod }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false };
  const shell: ViewState = { kind: "shell", target: { by: "object", ref: pod }, session: "exec-1" };
  return {
    schema: 1, context: "default", focused: "b", zoomed: null, mru: ["b", "a", "c", "d"], closed: [], dirty: false,
    root: {
      kind: "split", id: "s1", dir: "row", sizes: [0.5, 0.5],
      children: [{ kind: "leaf", pane: "a" }, { kind: "split", id: "s2", dir: "col", sizes: [0.4, 0.3, 0.3], children: [{ kind: "leaf", pane: "b" }, { kind: "leaf", pane: "c" }, { kind: "leaf", pane: "d" }] }],
    },
    panes: {
      a: { id: "a", history: [tableView(PODS, "web", { cursorUid: "u1" })], index: 0 },
      b: { id: "b", history: [tableView(SVC, "*")], index: 0 },
      c: { id: "c", history: [tableView(PODS), logs], index: 1, link: { source: "a", follow: false } },
      d: { id: "d", history: [shell], index: 0 },
    },
  };
}

describe("favourite views", () => {
  const view = tableView(PODS, "web", { filters: [{ mode: "re", text: "api" }], faultsOnly: true, cursorUid: "u1" });

  it("keeps resource, namespace, filters, faults, sort and wide, not the cursor", () => {
    const fav = toFavouriteView(view, false);
    expect(fav).toEqual({ kind: "table", gvr: PODS, namespace: "web", filters: [{ mode: "re", text: "api" }], faultsOnly: true, sort: null, wide: false });
    expect(fromFavouriteView(fav, "other")).toEqual({ ...fav, namespace: "web" });
  });

  it("'current' resolves to the target pane's namespace at recall", () => {
    const fav = toFavouriteView(view, true);
    expect(fav.namespace).toEqual({ current: true });
    expect(fromFavouriteView(fav, "db").namespace).toBe("db");
    expect(fromFavouriteView(fav, undefined).namespace).toBe("*");
  });

  it("matches the pane view it would open", () => {
    expect(matchesFavourite(toFavouriteView(view, false), view)).toBe(true);
    expect(matchesFavourite(toFavouriteView(view, false), { ...view, namespace: "db" })).toBe(false);
    expect(matchesFavourite(toFavouriteView(view, true), { ...view, namespace: "db" })).toBe(true);
    expect(matchesFavourite(toFavouriteView(view, false), { ...view, filters: [] })).toBe(false);
    expect(matchesFavourite(toFavouriteView(view, false), { kind: "home" })).toBe(false);
  });

  it("summary", () => {
    expect(favouriteSummary(toFavouriteView(view, false))).toBe("pods · web · /api · faults");
    expect(favouriteSummary(toFavouriteView(tableView(SVC), true))).toBe("services · current");
  });

  it("sanitize drops broken entries and duplicate slots", () => {
    const good = { id: "1", name: "a", slot: 3, view: toFavouriteView(view, true) };
    const out = sanitizeFavourites([good, { id: "2", name: "b", slot: 3, view: toFavouriteView(view, false) }, { id: "3", name: "c", view: { gvr: 1 } }, null, { ...good }]);
    expect(out.map((f) => [f.id, f.slot])).toEqual([["1", 3], ["2", undefined]]);
    expect(out[0].view.namespace).toEqual({ current: true });
    expect(sanitizeFavourites("nope")).toEqual([]);
  });
});

describe("saved layouts", () => {
  it("text summary", () => {
    const ws = workspace();
    const l = toSavedLayout(ws, "L1", "triage");
    expect(treeSummary(l.root, l.views)).toBe("pods | (services / logs / shell)");
  });

  it("saves one view per pane, links, and never a pod name or a live session", () => {
    const l = toSavedLayout(workspace(), "L1", "triage", 2);
    expect(l.slot).toBe(2);
    expect(l.views.a).toEqual(tableView(PODS, "web"));
    expect(l.views.c).toMatchObject({ kind: "logs", target: { by: "paneSelection", pane: "a" } });
    // no link: the first table pane stands in
    expect(l.views.d).toEqual({ kind: "shell", target: { by: "paneSelection", pane: "a" } });
    expect(l.links).toEqual({ c: { source: "a", follow: false } });
    expect(l.focused).toBe("b");
    expect(JSON.stringify(l)).not.toContain("api-1");
  });

  it("a log pane with no table to follow comes back as home", () => {
    const ws = workspace();
    const only: Workspace = { ...ws, root: { kind: "leaf", pane: "d" }, panes: { d: ws.panes.d }, focused: "d", mru: ["d"] };
    expect(toSavedLayout(only, "L", "x").views.d).toEqual({ kind: "home" });
  });

  it("recall builds a fresh workspace with remapped ids, links and selections", () => {
    const l = toSavedLayout(workspace(), "L1", "triage");
    let n = 0;
    const ws = fromSavedLayout(l, "staging", () => `n${n++}`);
    const [a, b, c, d] = leafIds(ws.root);
    expect(new Set([a, b, c, d, "a", "b", "c", "d"]).size).toBe(8);
    expect(ws.context).toBe("staging");
    expect(ws.layoutId).toBe("L1");
    expect(ws.dirty).toBe(false);
    expect(ws.focused).toBe(b);
    expect(ws.mru[0]).toBe(b);
    expect([...ws.mru].sort()).toEqual([a, b, c, d].sort());
    expect(ws.panes[c].link).toEqual({ source: a, follow: false });
    expect(ws.panes[c].history[0]).toMatchObject({ kind: "logs", target: { by: "paneSelection", pane: a } });
    expect(ws.panes[d].history).toEqual([{ kind: "shell", target: { by: "paneSelection", pane: a } }]);
    expect(ws.root.kind === "split" && ws.root.sizes).toEqual([0.5, 0.5]);
    // the stored layout is not touched
    expect(leafIds(l.root)).toEqual(["a", "b", "c", "d"]);
  });

  it("sanitize keeps valid layouts and repairs references", () => {
    const l = toSavedLayout(workspace(), "L1", "triage", 1);
    const broken: unknown = { ...l, id: "L2", slot: 1, focused: "zzz", links: { c: { source: "gone", follow: true } }, views: { a: l.views.a } };
    const out = sanitizeLayouts(JSON.parse(JSON.stringify([l, broken, { id: "L3", name: "x", root: null, views: {} }])) as unknown);
    expect(out.map((x) => x.id)).toEqual(["L1", "L2"]);
    expect(out[0]).toEqual(l);
    const second = out[1] as SavedLayout;
    expect(second.slot).toBeUndefined();
    expect(second.focused).toBe("a");
    expect(second.links).toEqual({});
    expect(second.views.b).toEqual({ kind: "home" });
  });
});

describe("isLayoutUnedited", () => {
  it("is true right after recall, false after navigating a pane or editing the tree", async () => {
    const { isLayoutUnedited } = await import("./model");
    const l = toSavedLayout(workspace(), "L1", "triage");
    let n = 0;
    const ws = fromSavedLayout(l, "default", () => `n${n++}`);
    expect(isLayoutUnedited(ws, l)).toBe(true);
    expect(isLayoutUnedited({ ...ws, dirty: true }, l)).toBe(false);
    expect(isLayoutUnedited({ ...ws, layoutId: "other" }, l)).toBe(false);
    const first = leafIds(ws.root)[0];
    const pane = ws.panes[first];
    const moved: Workspace = { ...ws, panes: { ...ws.panes, [first]: { ...pane, history: [...pane.history, tableView(SVC, "db")], index: 1 } } };
    expect(isLayoutUnedited(moved, l)).toBe(false);
    // only the cursor moved: still the same layout
    const cursor: Workspace = { ...ws, panes: { ...ws.panes, [first]: { ...pane, history: [{ ...tableView(PODS, "web"), cursorUid: "zzz" }] } } };
    expect(isLayoutUnedited(cursor, l)).toBe(true);
  });
});

describe("layouts and pane contexts (§8.3)", () => {
  it("a pane saved in its own context comes back in it", () => {
    const ws = workspace();
    const mixed: Workspace = { ...ws, panes: { ...ws.panes, b: { ...ws.panes.b, context: "staging" } } };
    const l = toSavedLayout(mixed, "L1", "prod | staging");
    expect(l.contexts).toEqual({ b: "staging" });
    expect(toSavedLayout(ws, "L2", "plain").contexts).toBeUndefined();
    const [back] = sanitizeLayouts(JSON.parse(JSON.stringify([l])));
    expect(back.contexts).toEqual({ b: "staging" });
    let n = 0;
    const again = fromSavedLayout(back, "default", () => `x${++n}`);
    expect(Object.values(again.panes).filter((p) => p.context === "staging")).toHaveLength(1);
    // recalled in the window's own context of that pane: stored as the workspace's own
    const inStaging = fromSavedLayout(back, "staging", () => `y${++n}`);
    expect(Object.values(inStaging.panes).some((p) => p.context !== undefined)).toBe(false);
  });
});
