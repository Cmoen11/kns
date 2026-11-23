import { describe, expect, it } from "vitest";
import type { DocView, ObjectRef, ShellView, ViewState, Workspace } from "../types";
import { computeGeometry } from "./geometry";
import { leafIds, MAX_LEAVES } from "./layout-tree";
import * as W from "./workspace";

function gen() {
  let n = 0;
  return () => `n${++n}`;
}
const pods = W.tableView(W.CORE_PODS);
const ref = (name: string): ObjectRef => ({ gvr: W.CORE_PODS, namespace: "default", name, uid: `uid-${name}` });
const doc = (name: string, format: DocView["format"] = "describe", mode: DocView["mode"] = "view"): DocView => ({
  kind: "doc", ref: ref(name), format, mode, managedFields: false, wrap: false,
});
const shell = (name: string): ShellView => ({ kind: "shell", target: { by: "object", ref: ref(name) }, session: "exec-1" });
const ok = (ws: Workspace) => expect(W.workspaceErrors(ws)).toEqual([]);
const rects = (ws: Workspace, w = 1600, h = 900) =>
  computeGeometry({ root: ws.root, width: w, height: h, mru: ws.mru, zoomed: ws.zoomed, min: () => ({ w: 240, h: 120 }) }).rects;

function start(views: ViewState[] = [pods]) {
  const ids = gen();
  return { ids, ws: W.newWorkspace("default", views, ids) };
}

describe("first-run layout", () => {
  it("depends on the window width", () => {
    expect(leafIds(W.defaultWorkspace("c", 1366, gen()).root)).toHaveLength(1);
    expect(leafIds(W.defaultWorkspace("c", 1920, gen()).root)).toHaveLength(2);
    const wide = W.defaultWorkspace("c", 3440, gen());
    expect(leafIds(wide.root).map((p) => W.viewOf(wide, p)!.kind)).toEqual(["home", "table", "table", "table"]);
    ok(wide);
    expect(W.viewOf(wide, wide.focused)!.kind).toBe("table");
  });
});

describe("split and open beside", () => {
  it("split clones the view, focuses the new pane and keeps pane states by reference", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const r = W.splitPane(ws, a, "right", ids);
    expect(r.pane).toBeDefined();
    expect(r.ws.focused).toBe(r.pane);
    expect(W.viewOf(r.ws, r.pane!)).toBe(pods);
    expect(r.ws.panes[a]).toBe(ws.panes[a]);
    expect(r.ws.mru).toEqual([r.pane, a]);
    ok(r.ws);
  });

  it("never clones a shell or an edit: the new pane shows the parent table or the doc as view", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const withShell = W.pushView(ws, a, shell("web"));
    const s = W.splitPane(withShell, a, "down", ids);
    expect(W.viewOf(s.ws, s.pane!)).toBe(pods);
    const withEdit = W.pushView(ws, a, doc("web", "yaml", "edit"));
    const e = W.splitPane(withEdit, a, "right", ids);
    expect(W.viewOf(e.ws, e.pane!)).toMatchObject({ kind: "doc", mode: "view" });
  });

  it("refuses at 12 leaves with a message", () => {
    let { ids, ws } = start();
    for (let i = 1; i < MAX_LEAVES; i++) ws = W.splitPane(ws, ws.focused, i % 2 ? "right" : "down", ids).ws;
    expect(leafIds(ws.root)).toHaveLength(MAX_LEAVES);
    ok(ws);
    const r = W.splitPane(ws, ws.focused, "right", ids);
    expect(r.ws).toBe(ws);
    expect(r.error).toBe(W.CAP_MESSAGE);
    expect(W.openBeside(ws, ws.focused, doc("x"), "right", ids).error).toBe(W.CAP_MESSAGE);
  });

  it("opens a following describe beside, keeps focus on the source and reuses it next time", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const first = W.openBeside(ws, a, doc("web"), "right", ids);
    const d = first.pane!;
    expect(first.reused).toBeUndefined();
    expect(first.ws.focused).toBe(a);
    expect(first.ws.panes[d].link).toEqual({ source: a, follow: true });
    ok(first.ws);
    const again = W.openBeside(first.ws, a, doc("api"), "right", ids);
    expect(again.reused).toBe(true);
    expect(again.pane).toBe(d);
    expect(leafIds(again.ws.root)).toHaveLength(2);
    expect(W.viewOf(again.ws, d)).toMatchObject({ ref: { name: "api" } });
    expect(again.ws.panes[d].history).toHaveLength(1);
    // another format opens a second pane
    const yaml = W.openBeside(again.ws, a, doc("api", "yaml"), "right", ids);
    expect(yaml.reused).toBeUndefined();
    expect(leafIds(yaml.ws.root)).toHaveLength(3);
  });

  it("never reuses a pinned pane; logs and shells are pinned and take focus", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const logs: ViewState = { kind: "logs", target: { by: "object", ref: ref("web") }, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false };
    const one = W.openBeside(ws, a, logs, "down", ids);
    expect(one.ws.focused).toBe(one.pane);
    expect(one.ws.panes[one.pane!].link).toEqual({ source: a, follow: false });
    const two = W.openBeside(one.ws, a, logs, "down", ids);
    expect(two.pane).not.toBe(one.pane);
    expect(leafIds(two.ws.root)).toHaveLength(3);
    // a doc pane the user unfollowed is not reused either
    const d1 = W.openBeside(ws, a, doc("web"), "right", ids);
    const pinned = W.toggleFollow(d1.ws, d1.pane!).ws;
    expect(pinned.panes[d1.pane!].link!.follow).toBe(false);
    expect(W.openBeside(pinned, a, doc("api"), "right", ids).reused).toBeUndefined();
  });

  it("a why pane beside follows by default, keeps focus on the source and is reused", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const why = (name: string): ViewState => ({ kind: "why", ref: ref(name) });
    const first = W.openBeside(ws, a, why("web"), "right", ids);
    expect(first.ws.focused).toBe(a);
    expect(first.ws.panes[first.pane!].link).toEqual({ source: a, follow: true });
    const again = W.openBeside(first.ws, a, why("api"), "right", ids);
    expect(again.reused).toBe(true);
    expect(W.viewOf(again.ws, first.pane!)).toMatchObject({ ref: { name: "api" } });
  });
});

describe("restore of logs targets", () => {
  const logs = (target: unknown) => ({ kind: "logs", target, container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false });
  it("keeps merged logs of several objects; drops an empty or broken list", () => {
    expect(W.sanitizeView(logs({ by: "objects", refs: [ref("a"), ref("b")] }))).not.toBeNull();
    expect(W.sanitizeView(logs({ by: "objects", refs: [] }))).toBeNull();
    expect(W.sanitizeView(logs({ by: "objects", refs: [{ name: "x" }] }))).toBeNull();
  });
  it("never restores a shell on an objects or selector target", () => {
    expect(W.sanitizeView({ kind: "shell", target: { by: "objects", refs: [ref("a")] } })).toBeNull();
    expect(W.sanitizeView({ kind: "shell", target: { by: "selector", selector: "app=x" } })).toBeNull();
  });
});

describe("close and reopen", () => {
  it("returns focus to the opener, unlinks followers and stacks the pane", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const b = W.splitPane(ws, a, "right", ids);
    const c = W.openBeside(b.ws, b.pane!, shell("web"), "down", ids);
    // c was opened from b; focus an unrelated pane first, then back to c
    let w = W.focusPane(W.focusPane(c.ws, a), c.pane!);
    w = W.closePane(w, c.pane!, 1, ids);
    expect(w.focused).toBe(b.pane);
    expect(w.closed).toHaveLength(1);
    expect(leafIds(w.root)).toEqual([a, b.pane]);
    ok(w);
    // closing a source unlinks its follower
    const d = W.openBeside(ws, a, doc("web"), "right", ids);
    const gone = W.closePane(d.ws, a, 2, ids);
    expect(gone.panes[d.pane!].link).toEqual({ source: null, follow: false });
    expect(gone.focused).toBe(d.pane);
    ok(gone);
  });

  it("closing the last pane resets it to home", () => {
    const { ids, ws } = start();
    const w = W.closePane(ws, ws.focused, 1, ids);
    expect(leafIds(w.root)).toHaveLength(1);
    expect(W.viewOf(w, w.focused)).toEqual({ kind: "home" });
    expect(w.closed).toHaveLength(1);
    ok(w);
  });

  it("reopens beside the former neighbour; shells come back as placeholders", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const b = W.splitPane(ws, a, "right", ids);
    const c = W.splitPane(b.ws, b.pane!, "down", ids, shell("web"));
    const closed = W.closePane(c.ws, c.pane!, 1, ids);
    expect(closed.root.kind === "split" && closed.root.children.length).toBe(2);
    const back = W.reopenPane(closed, ids);
    expect(back.pane).toBe(c.pane);
    expect(leafIds(back.ws.root)).toEqual([a, b.pane, c.pane]);
    expect(back.ws.root.kind === "split" && back.ws.root.children[1].kind).toBe("split");
    expect(W.viewOf(back.ws, c.pane!)).toEqual({ kind: "shell", target: { by: "object", ref: ref("web") } });
    expect(back.ws.focused).toBe(c.pane);
    expect(back.ws.closed).toHaveLength(0);
    ok(back.ws);
    expect(W.reopenPane(back.ws, ids).error).toBeDefined();
  });

  it("reopens next to a sibling subtree, and between siblings, with its old fraction", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const b = W.splitPane(ws, a, "right", ids);
    const c = W.splitPane(b.ws, b.pane!, "down", ids);
    // row[a 30%, col[b, c]]: closing a leaves col[b, c]; reopening restores the row around it
    const sized = W.setSizes(c.ws, (c.ws.root as { id: string }).id, [0.3, 0.7]);
    const closed = W.closePane(sized, a, 1, ids);
    expect(closed.root.kind === "split" && closed.root.dir).toBe("col");
    const back = W.reopenPane(closed, ids).ws;
    expect(leafIds(back.root)).toEqual([a, b.pane, c.pane]);
    const root = back.root as { dir: string; sizes: number[]; children: { kind: string }[] };
    expect(root.dir).toBe("row");
    expect(root.sizes[0]).toBeCloseTo(0.3);
    expect(root.children[1].kind).toBe("split");
    ok(back);
    // three columns 50/25/25: the middle one comes back in the middle at 25%
    let cols = W.splitPane(W.splitPane(ws, a, "right", ids).ws, a, "right", ids).ws;
    cols = W.setSizes(cols, (cols.root as { id: string }).id, [0.5, 0.25, 0.25]);
    const mid = leafIds(cols.root)[1];
    const again = W.reopenPane(W.closePane(cols, mid, 2, ids), ids).ws;
    expect(leafIds(again.root)).toEqual(leafIds(cols.root));
    expect((again.root as { sizes: number[] }).sizes.map((s) => Math.round(s * 100))).toEqual([50, 25, 25]);
  });

  it("close others keeps one pane and caps the reopen stack at 10", () => {
    let { ids, ws } = start();
    const keep = ws.focused;
    for (let i = 1; i < MAX_LEAVES; i++) ws = W.splitPane(ws, ws.focused, "right", ids).ws;
    const w = W.closeOthers(ws, keep, 5, ids);
    expect(leafIds(w.root)).toEqual([keep]);
    expect(w.closed).toHaveLength(W.CLOSED_CAP);
    expect(w.zoomed).toBeNull();
    ok(w);
  });
});

describe("focus, move, zoom, sizes", () => {
  function three() {
    // row[a, col[b, c]]
    const { ids, ws } = start();
    const a = ws.focused;
    const b = W.splitPane(ws, a, "right", ids);
    const c = W.splitPane(b.ws, b.pane!, "down", ids);
    return { ids, ws: c.ws, a, b: b.pane!, c: c.pane! };
  }

  it("focuses by direction, by number, next and last", () => {
    const { ws, a, b, c } = three();
    expect(ws.focused).toBe(c);
    const up = W.focusDir(ws, "up", rects(ws));
    expect(up.focused).toBe(b);
    expect(W.focusDir(up, "left", rects(up)).focused).toBe(a);
    expect(W.focusDir(ws, "down", rects(ws))).toBe(ws);
    expect(W.focusIndex(ws, 1).focused).toBe(a);
    expect(W.focusIndex(ws, 9)).toBe(ws);
    expect(W.focusNext(ws, 1).focused).toBe(a);
    expect(W.focusNext(ws, -1).focused).toBe(b);
    expect(W.focusLast(ws).focused).toBe(b);
    expect(W.focusLast(W.focusLast(ws)).focused).toBe(c);
    ok(W.focusLast(ws));
  });

  it("moves by swapping with the neighbour, and docks at the root from the outer edge", () => {
    const { ids, ws, a, b, c } = three();
    const swapped = W.movePane(ws, c, "left", rects(ws), ids);
    expect(leafIds(swapped.root)).toEqual([c, b, a]);
    ok(swapped);
    const docked = W.movePane(ws, c, "down", rects(ws), ids);
    expect(docked.root.kind === "split" && docked.root.dir).toBe("col");
    expect(leafIds(docked.root)).toEqual([a, b, c]);
    ok(docked);
    const inserted = W.insertPane(ws, a, c, "right", ids);
    expect(leafIds(inserted.root)).toEqual([b, c, a]);
    ok(inserted);
    expect(leafIds(W.swapPanes(ws, a, b).root)).toEqual([b, a, c]);
  });

  it("zoom leaves the tree alone and follows focus", () => {
    const { ws, a, c } = three();
    const z = W.toggleZoom(ws, c);
    expect(z.zoomed).toBe(c);
    expect(z.root).toBe(ws.root);
    expect(W.focusPane(z, a).zoomed).toBe(a);
    expect(W.toggleZoom(z, c).zoomed).toBeNull();
    const single = start().ws;
    expect(W.toggleZoom(single, single.focused)).toBe(single);
  });

  it("flips, equalizes and marks a named layout dirty", () => {
    const { ws, c } = three();
    const named = { ...ws, layoutId: "l1" };
    const flipped = W.flipSplit(named, c);
    expect(flipped.root.kind === "split" && flipped.root.children.length).toBe(3);
    expect(flipped.dirty).toBe(true);
    ok(flipped);
    const sized = W.setSizes(ws, (ws.root as { id: string }).id, [3, 1]);
    expect((sized.root as { sizes: number[] }).sizes).toEqual([0.75, 0.25]);
    expect((W.equalizeAll(sized).root as { sizes: number[] }).sizes).toEqual([0.5, 0.5]);
    expect(W.equalize(ws, c)).toBe(ws);
  });
});

describe("history", () => {
  it("pushes, goes back and forward, toggles last and truncates forward on a push from mid-stack", () => {
    const { ws } = start();
    const a = ws.focused;
    let w = W.pushView(ws, a, doc("one"));
    w = W.pushView(w, a, doc("two"));
    expect(w.panes[a].index).toBe(2);
    w = W.historyGo(w, a, -1);
    expect(W.viewOf(w, a)).toMatchObject({ ref: { name: "one" } });
    expect(W.canGoForward(w, a)).toBe(true);
    w = W.historyLast(w, a);
    expect(w.panes[a].index).toBe(2);
    w = W.historyLast(w, a);
    expect(w.panes[a].index).toBe(1);
    w = W.pushView(w, a, doc("three"));
    expect(w.panes[a].history.map((v) => (v.kind === "doc" ? v.ref.name : v.kind))).toEqual(["table", "one", "three"]);
    expect(W.canGoForward(w, a)).toBe(false);
    expect(W.historyGo(w, a, 1)).toBe(w);
    w = W.historyGo(W.historyGo(w, a, -1), a, -1);
    expect(W.canGoBack(w, a)).toBe(false);
    expect(W.historyGo(w, a, -1)).toBe(w);
  });

  it("caps the stack at 50 and keeps `last` pointing at the previous entry", () => {
    const { ws } = start();
    const a = ws.focused;
    let w = ws;
    for (let i = 0; i < 60; i++) w = W.pushView(w, a, doc(`d${i}`));
    const p = w.panes[a];
    expect(p.history).toHaveLength(W.HISTORY_CAP);
    expect(p.index).toBe(49);
    expect(p.last).toBe(48);
    ok(w);
  });

  it("replaceView edits the current entry without pushing", () => {
    const { ws } = start();
    const a = ws.focused;
    const w = W.replaceView(ws, a, (v) => (v.kind === "table" ? { ...v, namespace: "kube-system" } : v));
    expect(w.panes[a].history).toHaveLength(1);
    expect(W.viewOf(w, a)).toMatchObject({ namespace: "kube-system" });
    expect(W.replaceView(ws, a, (v) => v)).toBe(ws);
  });
});

describe("follow links", () => {
  it("toggles follow, refuses shells and panes without a source", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    expect(W.toggleFollow(ws, a).error).toBeDefined();
    const d = W.openBeside(ws, a, doc("web"), "right", ids);
    expect(W.followers(d.ws, a)).toEqual([d.pane]);
    const off = W.toggleFollow(d.ws, d.pane!);
    expect(W.followers(off.ws, a)).toEqual([]);
    const s = W.openBeside(ws, a, shell("web"), "right", ids);
    expect(W.toggleFollow(s.ws, s.pane!).error).toBe("a shell cannot follow");
  });
});

describe("sanitizeWorkspace", () => {
  it("round-trips a valid workspace through JSON", () => {
    const { ids, ws } = start();
    const b = W.splitPane(ws, ws.focused, "right", ids);
    const closed = W.closePane(W.splitPane(b.ws, b.pane!, "down", ids).ws, b.pane!, 3, ids);
    const back = W.sanitizeWorkspace(JSON.parse(JSON.stringify(closed)), "default");
    expect(back).toEqual(closed);
    ok(back!);
  });

  it("restores shells as placeholders and edits as views, and repairs a damaged tree", () => {
    const { ids, ws } = start([pods, shell("web"), doc("api", "yaml", "edit")]);
    const raw = JSON.parse(JSON.stringify(W.splitPane(ws, ws.focused, "down", ids).ws)) as Record<string, any>;
    raw.focused = "nope";
    raw.zoomed = "nope";
    raw.mru = ["nope"];
    raw.root.sizes = [9, "x", 0];
    raw.root.children.push({ kind: "leaf", pane: "ghost" });
    raw.panes.orphan = { id: "orphan", history: [{ kind: "home" }], index: 0 };
    raw.panes[Object.keys(raw.panes)[0]].index = 99;
    const back = W.sanitizeWorkspace(raw, "default")!;
    ok(back);
    const kinds = leafIds(back.root).map((p) => W.viewOf(back, p)!);
    expect(kinds.find((v) => v.kind === "shell")).toEqual({ kind: "shell", target: { by: "object", ref: ref("web") } });
    expect(kinds.find((v) => v.kind === "doc")).toMatchObject({ mode: "view" });
    expect(back.panes.orphan).toBeUndefined();
    expect(back.zoomed).toBeNull();
  });

  it("rejects garbage", () => {
    expect(W.sanitizeWorkspace(null, "c")).toBeNull();
    expect(W.sanitizeWorkspace({ root: { kind: "leaf", pane: "a" }, panes: {} }, "c")).toBeNull();
    expect(W.sanitizeWorkspace({ root: { kind: "leaf", pane: "a" }, panes: { a: { history: [{ kind: "bogus" }], index: 0 } } }, "c")).toBeNull();
  });
});

describe("pane context (§8.3)", () => {
  it("split and open beside inherit the source pane's context", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const inStaging = W.setPaneContext(ws, a, "staging");
    expect(W.contextOfPane(inStaging, a)).toBe("staging");
    const split = W.splitPane(inStaging, a, "right", ids);
    expect(W.contextOfPane(split.ws, split.pane!)).toBe("staging");
    const beside = W.openBeside(inStaging, a, doc("web"), "right", ids);
    expect(W.contextOfPane(beside.ws, beside.pane!)).toBe("staging");
    ok(beside.ws);
  });

  it("the workspace's own context is never stored on a pane", () => {
    const { ws } = start();
    const a = ws.focused;
    const back = W.setPaneContext(W.setPaneContext(ws, a, "staging"), a, "default");
    expect(back.panes[a].context).toBeUndefined();
    expect(W.isMixed(back)).toBe(false);
    expect(W.isMixed(W.setPaneContext(ws, a, "staging"))).toBe(true);
  });

  it("a context change restarts the history at the current view", () => {
    const { ws } = start();
    const a = ws.focused;
    const deep = W.pushView(W.pushView(ws, a, doc("web")), a, doc("api", "yaml"));
    const moved = W.setPaneContext(deep, a, "staging");
    expect(moved.panes[a].history).toHaveLength(1);
    expect(moved.panes[a].index).toBe(0);
    expect(W.viewOf(moved, a)).toMatchObject({ kind: "doc", format: "yaml" });
    expect(W.setPaneContext(deep, a, "staging", pods).panes[a].history).toEqual([pods]);
  });

  it("a pane opened in another context than its source does not follow it", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const r = W.openBeside(ws, a, doc("web"), "right", ids, { context: "staging" });
    expect(r.ws.panes[r.pane!].link).toEqual({ source: a, follow: false });
    expect(W.contextOfPane(r.ws, r.pane!)).toBe("staging");
    // a following describe of the source is not reused for another context
    const f = W.openBeside(ws, a, doc("web"), "right", ids);
    expect(f.ws.panes[f.pane!].link?.follow).toBe(true);
    const g = W.openBeside(f.ws, a, doc("api"), "right", ids, { context: "staging" });
    expect(g.reused).toBeUndefined();
    expect(g.pane).not.toBe(f.pane);
  });

  it("followers of a pane that changes context stop following", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const f = W.openBeside(ws, a, doc("web"), "right", ids);
    const moved = W.setPaneContext(f.ws, a, "staging");
    expect(moved.panes[f.pane!].link).toEqual({ source: a, follow: false });
  });

  it("restore keeps a pane's context, also one the kubeconfig may no longer have", () => {
    const { ws } = start();
    const a = ws.focused;
    const saved = JSON.parse(JSON.stringify(W.setPaneContext(ws, a, "gone"))) as unknown;
    expect(W.sanitizeWorkspace(saved, "default")!.panes[a].context).toBe("gone");
    const own = JSON.parse(JSON.stringify({ ...ws, panes: { [a]: { ...ws.panes[a], context: "default" } } })) as unknown;
    expect(W.sanitizeWorkspace(own, "default")!.panes[a].context).toBeUndefined();
  });
});

describe("follow across contexts (§8.3)", () => {
  it("leader f refuses a source in another context, and followers stay in their context", () => {
    const { ids, ws } = start();
    const a = ws.focused;
    const r = W.openBeside(ws, a, doc("web"), "right", ids, { context: "staging" });
    const t = W.toggleFollow(r.ws, r.pane!);
    expect(t.error).toBe("the source pane is in another context");
    expect(t.ws.panes[r.pane!].link?.follow).toBe(false);
    // a stale follow link to a pane in another context is not a follower
    const forced = { ...r.ws, panes: { ...r.ws.panes, [r.pane!]: { ...r.ws.panes[r.pane!], link: { source: a, follow: true } } } };
    expect(W.followers(forced, a)).toEqual([]);
  });
});
