import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRegistry, type ActionContext, type ActionId, type HandlerMap } from "../actions/registry";
import { LAYERS, tableScopes, viewScopes } from "../actions/scopes";
import type { Platform, Stroke } from "./chord";
import { createEngine, type EngineEvent } from "./engine";
import { createKeymap } from "./keymap";
import { newPanePrefixHandlers } from "./prefix";

/** A stroke as the normaliser would produce it for simple cases. */
function k(chord: string, extra: Partial<Stroke> = {}): Stroke {
  const typing = chord === "Space" || chord === "Shift+Space" || (!chord.includes("+") && [...chord].length === 1) || chord === "+";
  const bare = chord.replace(/^(Ctrl\+|Cmd\+)/, "").replace(/^Shift\+([A-Z])$/, "$1");
  return { chord, bare: /^[A-Z]$/.test(bare) && chord.startsWith("Ctrl+") && !chord.includes("Shift") ? bare.toLowerCase() : bare, typing, altGr: false, ...extra };
}

function setup(platform: Platform = "win") {
  const registry = createRegistry();
  const keymap = createKeymap(registry);
  const engine = createEngine({ registry, keymap, platform });
  const ran: { id: ActionId; ctx: ActionContext }[] = [];
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  const build = (ids: ActionId[], extra: HandlerMap = {}) => {
    const map: HandlerMap = {};
    for (const id of ids) map[id] = (ctx) => void ran.push({ id, ctx });
    return registry.register({ ...map, ...extra });
  };
  const ids = () => ran.map((r) => r.id);
  return { registry, keymap, engine, ran, ids, events, build };
}

const pods = tableScopes({ resource: "pods", namespaced: true });
const deployments = tableScopes({ resource: "deployments", namespaced: true });

describe("scope resolution", () => {
  it("runs a built action in an active scope and passes everything else", () => {
    const t = setup();
    t.build(["res.describe"]);
    t.engine.setBaseScopes(pods);
    expect(t.engine.handle(k("d"))).toBe("consumed");
    expect(t.ids()).toEqual(["res.describe"]);
    // not built: the key is unbound (principle 12)
    expect(t.engine.handle(k("y"))).toBe("pass");
    // built but out of scope
    t.engine.setBaseScopes(viewScopes({ kind: "logs" }));
    expect(t.engine.handle(k("d"))).toBe("pass");
  });

  it("resolves the same key per kind", () => {
    const t = setup();
    t.build(["pod.shell", "workload.scale", "logs.autoscroll"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("s"));
    t.engine.setBaseScopes(deployments);
    t.engine.handle(k("s"));
    t.engine.setBaseScopes(viewScopes({ kind: "logs" }));
    t.engine.handle(k("s"));
    expect(t.ids()).toEqual(["pod.shell", "workload.scale", "logs.autoscroll"]);
  });

  it("prefers the more specific scope, and falls back while the specific action is not built", () => {
    const t = setup();
    t.build(["copy.name"]);
    t.engine.setBaseScopes(tableScopes({ resource: "nodes", namespaced: false }));
    t.engine.handle(k("c"));
    t.build(["node.cordon"]);
    t.engine.handle(k("c"));
    expect(t.ids()).toEqual(["copy.name", "node.cordon"]);
  });

  it("walks the Esc ladder through `when` (§4.2)", () => {
    const t = setup();
    const state = { marks: true, chips: true, depth: 2 };
    t.build([], {
      "mark.clear": { when: () => state.marks, run: () => void (state.marks = false) },
      "filter.clear": { when: () => state.chips, run: () => void (state.chips = false) },
      "nav.back": { when: () => state.depth > 1, run: () => void state.depth-- },
    });
    t.engine.setBaseScopes(pods);
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    expect(state).toEqual({ marks: false, chips: true, depth: 2 });
    t.engine.handle(k("Esc"));
    expect(state).toEqual({ marks: false, chips: false, depth: 2 });
    t.engine.handle(k("Esc"));
    expect(state.depth).toBe(1);
    // root: no-op, the key is not ours
    expect(t.engine.handle(k("Esc"))).toBe("pass");
  });

  it("runs an alias row's binding as its target, only in the alias scope", () => {
    const t = setup();
    t.build(["pane.next", "pane.zoom"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("Tab"));
    t.engine.handle(k("F6"));
    t.engine.setBaseScopes(viewScopes({ kind: "doc", format: "yaml", mode: "edit" }), { mode: "EDIT" });
    expect(t.engine.handle(k("Tab"))).toBe("pass");
    t.engine.handle(k("F6"));
    t.engine.setBaseScopes(viewScopes({ kind: "logs" }));
    t.engine.handle(k("f"));
    expect(t.ids()).toEqual(["pane.next", "pane.next", "pane.next", "pane.zoom"]);
  });

  it("passes the digit of an N-family binding", () => {
    const t = setup();
    t.build(["fav.viewN", "namespace.favN"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("Ctrl+3"));
    t.engine.handle(k("7"));
    expect(t.ran.map((r) => [r.id, r.ctx.digit])).toEqual([["fav.viewN", 3], ["namespace.favN", 7]]);
  });

  it("a layer with below:'none' hides everything under it", () => {
    const t = setup();
    t.build(["palette.open", "res.describe", "dialog.confirm"]);
    t.engine.setBaseScopes(pods);
    const pop = t.engine.pushScope(LAYERS.dialog);
    expect(t.engine.handle(k("Ctrl+K"))).toBe("pass");
    expect(t.engine.handle(k("d"))).toBe("pass");
    expect(t.engine.handle(k("Enter"))).toBe("consumed");
    pop();
    expect(t.engine.handle(k("Ctrl+K"))).toBe("consumed");
    expect(t.ids()).toEqual(["dialog.confirm", "palette.open"]);
  });

  it("a layer with below:'chords' lets only command chords through (§5.2)", () => {
    const t = setup();
    t.build(["palette.open", "res.describe", "filter.apply", "nav.open", "pane.next"]);
    t.engine.setBaseScopes(pods);
    t.engine.pushScope(LAYERS.filterInput);
    expect(t.engine.snapshot().mode).toBe("FILTER");
    expect(t.engine.handle(k("d"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("d"))).toBe("pass");
    t.engine.handle(k("Enter"), { editable: true });
    t.engine.handle(k("Ctrl+K"), { editable: true });
    t.engine.handle(k("F6"), { editable: true });
    expect(t.ids()).toEqual(["filter.apply", "palette.open", "pane.next"]);
  });

  it("a layer with below:'chords+esc' also lets Esc through, unless a stricter layer is above", () => {
    const t = setup();
    t.build(["palette.open", "res.describe", "nav.open", "nav.back", "vim.escape"], {
      "vim.escape": { when: () => false, run: () => undefined },
    });
    t.engine.setBaseScopes(pods);
    t.engine.pushScope(LAYERS.vim);
    expect(t.engine.handle(k("d"))).toBe("pass");
    expect(t.engine.handle(k("Enter"))).toBe("pass");
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    expect(t.engine.handle(k("Ctrl+K"))).toBe("consumed");
    const pop = t.engine.pushScope(LAYERS.palette);
    expect(t.engine.handle(k("Esc"))).toBe("pass");
    pop();
    expect(t.ids()).toEqual(["nav.back", "palette.open"]);
  });

  it("a layer with below:'global-chords' lets only global command chords through (side panels)", () => {
    const t = setup();
    t.build(["palette.open", "res.delete", "pod.kill", "mark.all", "copy.cell", "pane.focusLeft", "pane.next", "pane.splitRight", "side.down", "activity.stop"]);
    t.engine.setBaseScopes(pods);
    t.engine.pushScope(LAYERS.activity);
    expect(t.engine.snapshot().mode).toBe("SIDE");
    // the table under the panel: not its single keys, and not its chords either (delete, kill)
    for (const chord of ["d", "Ctrl+Backspace", "Ctrl+Shift+Backspace", "Ctrl+A", "Ctrl+C"]) expect(t.engine.handle(k(chord)), chord).toBe("pass");
    for (const chord of ["j", "x", "Delete", "Ctrl+K", "Alt+H", "F6"]) expect(t.engine.handle(k(chord)), chord).toBe("consumed");
    t.engine.handle(k("Ctrl+."));
    t.engine.handle(k("r"));
    expect(t.ids()).toEqual(["side.down", "activity.stop", "activity.stop", "palette.open", "pane.focusLeft", "pane.next", "pane.splitRight"]);
    // k9s mode binds delete to Ctrl+D: still not through a panel
    expect(t.engine.available().some((a) => a.action.id === "res.delete")).toBe(false);
  });
});

describe("text inputs (§5.2)", () => {
  it("leaves typed characters and text-editing chords to the input", () => {
    const t = setup();
    t.build(["res.describe", "mark.all", "mark.toggle", "palette.open", "res.delete"]);
    t.engine.setBaseScopes(pods);
    expect(t.engine.handle(k("d"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Space"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Ctrl+A"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Ctrl+Backspace"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Ctrl+K"), { editable: true })).toBe("consumed");
    expect(t.ids()).toEqual(["palette.open"]);
  });

  it("lets only the input's own layer claim caret keys", () => {
    const t = setup();
    let empty = false;
    t.build(["nav.down", "list.down"], { "filter.chipRemove": { when: () => empty, run: () => {} } });
    t.engine.setBaseScopes(pods);
    // an input with no layer of its own: Down stays with the input
    expect(t.engine.handle(k("Down"), { editable: true })).toBe("pass");
    const pop = t.engine.pushScope(LAYERS.palette);
    expect(t.engine.handle(k("Down"), { editable: true })).toBe("consumed");
    pop();
    t.engine.pushScope(LAYERS.filterInput);
    expect(t.engine.handle(k("Backspace"), { editable: true })).toBe("pass");
    empty = true;
    expect(t.engine.handle(k("Backspace"), { editable: true })).toBe("consumed");
    expect(t.ids()).toEqual(["list.down"]);
  });

  it("AltGr characters are text in inputs and single keys in NORMAL", () => {
    const t = setup();
    t.build(["history.back"]);
    t.engine.setBaseScopes(pods);
    const altGr: Stroke = { chord: "[", bare: "[", typing: true, altGr: true };
    expect(t.engine.handle(altGr, { editable: true })).toBe("pass");
    expect(t.engine.handle(altGr)).toBe("consumed");
    expect(t.ids()).toEqual(["history.back"]);
  });

  it("'single keys off' disables character keys but not chords", () => {
    const t = setup();
    t.build(["res.describe", "palette.open", "nav.open", "pane.splitRight"]);
    t.engine.setBaseScopes(pods);
    t.engine.setEnv({ singleKeys: false });
    expect(t.engine.handle(k("d"))).toBe("pass");
    t.engine.handle(k("Ctrl+K"));
    t.engine.handle(k("Enter"));
    t.engine.handle(k("Ctrl+."));
    t.engine.handle(k("r"));
    expect(t.ids()).toEqual(["palette.open", "nav.open", "pane.splitRight"]);
    expect(t.engine.hints().some((h) => h.action.id === "res.describe")).toBe(false);
  });
});

describe("terminal scope (§5.3)", () => {
  it("Windows: the shell gets everything except the app's list", () => {
    const t = setup("win");
    t.build(["palette.open", "pane.close", "fav.viewN", "terminal.copy", "pane.focusLeft", "help.overlay", "nav.back"]);
    t.engine.setBaseScopes(viewScopes({ kind: "shell", live: true }), { mode: "TERM" });
    expect(t.engine.snapshot().mode).toBe("TERM");
    for (const chord of ["Ctrl+K", "Ctrl+W", "Ctrl+C", "Ctrl+R", "Esc", "Tab", "d", "?", "Ctrl+Enter", "Ctrl++"]) {
      expect(t.engine.handle(k(chord)), chord).toBe("pass");
    }
    for (const chord of ["Ctrl+Shift+P", "Ctrl+2", "Ctrl+Shift+C", "Ctrl+Insert", "Alt+Left", "F1"]) {
      expect(t.engine.handle(k(chord)), chord).toBe("consumed");
    }
    // pane focus with Alt+h/j/k/l leaves a shell pane too; other Alt+letters are the shell's
    expect(t.engine.handle(k("Alt+H"))).toBe("consumed");
    expect(t.engine.handle(k("Alt+B"))).toBe("pass");
    // close is leader x
    t.engine.handle(k("Ctrl+."));
    t.engine.handle(k("x"));
    expect(t.ids()).toEqual(["palette.open", "fav.viewN", "terminal.copy", "terminal.copy", "pane.focusLeft", "help.overlay", "pane.focusLeft", "pane.close"]);
  });

  it("macOS: every Cmd chord is the app's, Ctrl goes to the shell", () => {
    const t = setup("mac");
    t.build(["palette.open", "pane.close", "terminal.copy"]);
    t.engine.setBaseScopes(viewScopes({ kind: "shell", live: true }), { mode: "TERM" });
    expect(t.engine.handle(k("Cmd+K"))).toBe("consumed");
    expect(t.engine.handle(k("Cmd+W"))).toBe("consumed");
    expect(t.engine.handle(k("Cmd+C"))).toBe("consumed");
    expect(t.engine.handle(k("Ctrl+C"))).toBe("pass");
    expect(t.engine.handle(k("Ctrl+K"))).toBe("pass");
  });

  it("macOS: Option+h/j/k/l moves pane focus, from a shell pane too", () => {
    const t = setup("mac");
    t.build(["pane.focusLeft", "pane.focusRight"]);
    expect(t.engine.handle(k("Alt+H"))).toBe("consumed");
    t.engine.setBaseScopes(viewScopes({ kind: "shell", live: true }), { mode: "TERM" });
    expect(t.engine.handle(k("Alt+L"))).toBe("consumed");
    expect(t.engine.handle(k("Alt+B"))).toBe("pass");
    expect(t.ids()).toEqual(["pane.focusLeft", "pane.focusRight"]);
  });
});

describe("sticky modes capture every key", () => {
  it.each([
    ["a live shell", viewScopes({ kind: "shell", live: true }), "TERM" as const],
    ["an editor", viewScopes({ kind: "doc", format: "yaml", mode: "edit" }), "EDIT" as const],
  ])("MOVE, RESIZE and COPY work while focus is in %s", (_name, scopes, mode) => {
    const t = setup();
    t.build(["move.targetLeft", "resize.stepLeft", "copy.select", "copy.yank", "palette.open", "editor.leave"]);
    t.engine.setBaseScopes(scopes, { mode });
    for (const [layer, key, id] of [
      [LAYERS.move, "h", "move.targetLeft"],
      [LAYERS.resize, "h", "resize.stepLeft"],
      [LAYERS.copy, "v", "copy.select"],
    ] as const) {
      const pop = t.engine.pushScope(layer);
      expect(t.engine.snapshot().mode).toBe(layer.mode);
      expect(t.engine.handle(k(key), { editable: true })).toBe("consumed");
      expect(t.ids()[t.ids().length - 1]).toBe(id);
      // keys with no action in the mode are swallowed, never typed into the shell or editor
      expect(t.engine.handle(k("q"), { editable: true })).toBe("consumed");
      expect(t.engine.handle(k("Ctrl+K"), { editable: true })).toBe("consumed");
      expect(t.engine.handle(k("Ctrl+C"), { editable: true })).toBe("consumed");
      pop();
    }
    expect(t.ids()).toEqual(["move.targetLeft", "resize.stepLeft", "copy.select"]);
    // the OS chords are never taken
    t.engine.pushScope(LAYERS.copy);
    expect(t.engine.handle(k("Alt+F4"))).toBe("pass");
  });
});

describe("sequences and the leader", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("runs leader sequences, shows PANE, and has no timeout", () => {
    const t = setup();
    t.build(["pane.splitRight", "pane.last", "pane.moveLeft"]);
    t.engine.setBaseScopes(pods);
    expect(t.engine.handle(k("Ctrl+."))).toBe("consumed");
    expect(t.engine.snapshot()).toMatchObject({ mode: "PANE", leader: true, pending: ["Ctrl+."] });
    expect(t.engine.continuations().map((c) => c.chord).sort()).toEqual(["Ctrl+.", "H", "r"]);
    vi.advanceTimersByTime(60_000);
    expect(t.engine.snapshot().mode).toBe("PANE");
    t.engine.handle(k("r"));
    expect(t.engine.snapshot().mode).toBe("NORMAL");
    t.engine.handle(k("Ctrl+."));
    t.engine.handle(k("Ctrl+."));
    expect(t.ids()).toEqual(["pane.splitRight", "pane.last"]);
  });

  it("ignores a still-held Ctrl on the key after the leader (rule 11)", () => {
    const t = setup();
    t.build(["pane.splitRight", "pane.moveLeft", "view.refresh"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("Ctrl+."));
    t.engine.handle({ chord: "Ctrl+R", bare: "r", typing: false, altGr: false });
    t.engine.handle(k("Ctrl+."));
    t.engine.handle({ chord: "Ctrl+Shift+H", bare: "H", typing: false, altGr: false });
    expect(t.ids()).toEqual(["pane.splitRight", "pane.moveLeft"]);
  });

  it("consumes an unmatched key after the leader, and Esc cancels", () => {
    const t = setup();
    t.build(["pane.splitRight", "res.describe", "nav.back"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("Ctrl+."));
    expect(t.engine.handle(k("d"))).toBe("consumed");
    expect(t.engine.snapshot().pending).toEqual([]);
    t.engine.handle(k("Ctrl+."));
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    expect(t.ids()).toEqual([]);
  });

  it("ignores auto-repeat while a sequence is pending, and reset() disarms it", () => {
    const t = setup();
    t.build(["pane.splitRight", "pane.last"]);
    t.engine.handle(k("Ctrl+."));
    expect(t.engine.handle(k("Ctrl+."), { repeat: true })).toBe("consumed");
    expect(t.engine.snapshot().pending).toEqual(["Ctrl+."]);
    t.engine.reset();
    expect(t.engine.snapshot().pending).toEqual([]);
    expect(t.ids()).toEqual([]);
  });

  it("supports user sequences with a timeout", () => {
    const t = setup();
    t.build(["nav.top", "nav.down"]);
    t.keymap.setOverrides({ "nav.top": { win: [["g", "g"]] } });
    t.engine.setBaseScopes(pods);
    expect(t.engine.handle(k("g"))).toBe("consumed");
    expect(t.engine.snapshot()).toMatchObject({ pending: ["g"], leader: false, mode: "NORMAL" });
    t.engine.handle(k("g"));
    expect(t.ids()).toEqual(["nav.top"]);
    t.engine.handle(k("g"));
    vi.advanceTimersByTime(1000);
    expect(t.engine.snapshot().pending).toEqual([]);
    // a non-continuing key drops the sequence and is handled as a fresh key
    t.engine.handle(k("g"));
    t.engine.handle(k("j"));
    expect(t.ids()).toEqual(["nav.top", "nav.down"]);
  });

  it("repeats only actions declared with repeat", () => {
    const t = setup();
    t.build(["nav.down", "res.describe"]);
    t.engine.setBaseScopes(pods);
    t.engine.handle(k("j"), { repeat: true });
    expect(t.engine.handle(k("d"), { repeat: true })).toBe("consumed");
    expect(t.ran.map((r) => [r.id, r.ctx.repeat])).toEqual([["nav.down", true]]);
  });
});

describe("the + prefix (§4.1)", () => {
  function prefixed() {
    const t = setup();
    t.registry.register(newPanePrefixHandlers(t.engine));
    t.build(["res.describe", "workload.scale", "palette.open", "nav.down"]);
    t.engine.setBaseScopes(deployments);
    return t;
  }

  it("+ opens right, + + opens below, a third + cancels", () => {
    const t = prefixed();
    t.engine.handle(k("+"));
    expect(t.engine.snapshot().mode).toBe("NEW →");
    t.engine.handle(k("d"));
    expect(t.engine.snapshot().mode).toBe("NORMAL");
    t.engine.handle(k("+"));
    t.engine.handle(k("+"));
    expect(t.engine.snapshot().mode).toBe("NEW ↓");
    t.engine.handle(k("Ctrl+K"));
    t.engine.handle(k("+"));
    t.engine.handle(k("+"));
    t.engine.handle(k("+"));
    expect(t.engine.snapshot().prefix).toBeNull();
    t.engine.handle(k("d"));
    expect(t.ran.map((r) => [r.id, r.ctx.newPane])).toEqual([
      ["res.describe", "right"],
      ["palette.open", "down"],
      ["res.describe", null],
    ]);
  });

  it("an action that does not open a view cancels the prefix and does not run", () => {
    const t = prefixed();
    t.engine.handle(k("+"));
    expect(t.engine.handle(k("s"))).toBe("consumed");
    expect(t.ids()).toEqual([]);
    expect(t.engine.snapshot().prefix).toBeNull();
    expect(t.events).toContainEqual({ type: "message", text: "+ s: scale does not open a view" });
    t.engine.handle(k("+"));
    t.engine.handle(k("j"));
    expect(t.ids()).toEqual([]);
  });

  it("Esc and auto-repeat are safe", () => {
    const t = prefixed();
    t.engine.handle(k("+"));
    expect(t.engine.handle(k("+"), { repeat: true })).toBe("consumed");
    expect(t.engine.snapshot().prefix).toBe("right");
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    expect(t.engine.snapshot().prefix).toBeNull();
  });
});

describe("enabled, read-only and reporting", () => {
  it("blocks write actions in read-only mode and reports the reason", () => {
    const t = setup();
    t.build(["workload.restart", "res.describe"]);
    t.engine.setBaseScopes(deployments);
    t.engine.setEnv({ readOnly: true });
    expect(t.engine.handle(k("r"))).toBe("consumed");
    expect(t.ids()).toEqual([]);
    expect(t.events).toContainEqual({ type: "blocked", id: "workload.restart", reason: "read-only mode" });
    const a = t.engine.available().find((x) => x.action.id === "workload.restart");
    expect(a).toMatchObject({ enabled: false, reason: "read-only mode" });
    expect(t.engine.hints().some((h) => h.action.id === "workload.restart")).toBe(false);
  });

  it("consumes the key of a disabled action without falling through", () => {
    const t = setup();
    t.build(["copy.name"], { "node.cordon": { enabled: () => "forbidden: nodes is read-only for you", run: () => {} } });
    t.engine.setBaseScopes(tableScopes({ resource: "nodes", namespaced: false }));
    expect(t.engine.handle(k("c"))).toBe("consumed");
    expect(t.ids()).toEqual([]);
    expect(t.events[0]).toMatchObject({ type: "blocked", reason: "forbidden: nodes is read-only for you" });
  });

  it("lists available actions and hints for the active scopes only", () => {
    const t = setup();
    t.build(["res.describe", "res.logs", "help.overlay", "logs.wrap", "home.open", "flux.reconcile"]);
    t.engine.setBaseScopes(pods);
    expect(t.engine.hints().map((h) => h.action.id)).toEqual(["res.describe", "res.logs", "help.overlay"]);
    // command-only actions are available without a binding
    expect(t.engine.available().find((a) => a.action.id === "home.open")?.bindings).toEqual([]);
    expect(t.engine.available().some((a) => a.action.id === "logs.wrap")).toBe(false);
    expect(t.engine.bindingsFor("res.describe")).toEqual([["d"]]);
  });

  it("run() executes by id with args, honours when/enabled, and reports errors", () => {
    const t = setup();
    const seen: ActionContext[] = [];
    t.build([], {
      "ui.zoom": (ctx) => void seen.push(ctx),
      "nav.back": { when: () => false, run: () => {} },
      "home.open": () => {
        throw new Error("boom");
      },
    });
    expect(t.engine.run("ui.zoom", { source: "command", args: ["125"] })).toBe(true);
    expect(seen[0]).toMatchObject({ id: "ui.zoom", source: "command", args: ["125"] });
    expect(t.engine.run("nav.back")).toBe(false);
    expect(t.engine.run("res.yaml")).toBe(false);
    expect(t.engine.run("home.open")).toBe(false);
    expect(t.events.some((e) => e.type === "error" && e.id === "home.open")).toBe(true);
  });

  it("notifies subscribers when scopes, keymap or registrations change", () => {
    const t = setup();
    const fn = vi.fn();
    t.engine.subscribe(fn);
    t.engine.setBaseScopes(pods);
    const off = t.build(["res.describe"]);
    t.keymap.setK9sMode(true);
    off();
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(t.registry.get("res.describe")?.built).toBe(false);
  });
});

describe("registry", () => {
  it("rejects unknown and alias ids, and unregisters only its own handlers", () => {
    const registry = createRegistry();
    expect(() => registry.register({ ["nope" as ActionId]: () => {} })).toThrow(/unknown action id/);
    expect(() => registry.register({ "pane.nextTab": () => {} })).toThrow(/alias/);
    const off1 = registry.register({ "res.yaml": () => {} });
    const off2 = registry.register({ "res.yaml": () => {} }); // HMR / StrictMode re-register
    off1();
    expect(registry.get("res.yaml")?.built).toBe(true);
    off2();
    expect(registry.get("res.yaml")?.built).toBe(false);
    // alias rows mirror their target
    registry.register({ "pane.next": () => {} });
    expect(registry.get("pane.nextTab")?.built).toBe(true);
  });
});
