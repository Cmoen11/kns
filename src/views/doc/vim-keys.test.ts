// The vim key-routing rule (vim-state.ts), on the real keymap and key engine: which keys the
// app keeps while a vim editor has focus, and when Esc is vim's.
import { describe, expect, it } from "vitest";
import { createRegistry, type ActionId, type HandlerMap } from "../../actions/registry";
import { viewScopes } from "../../actions/scopes";
import type { Stroke } from "../../keys/chord";
import { createEngine } from "../../keys/engine";
import { createKeymap } from "../../keys/keymap";
import { PROMPT_LAYER, exBang, vimBadge, vimBusy, vimLayer, vimOwnsEscape, vimTakesChord } from "./vim-state";

function k(chord: string): Stroke {
  const typing = !chord.includes("+") && [...chord].length === 1;
  return { chord, bare: chord.replace(/^Ctrl\+/, ""), typing, altGr: false };
}

function setup() {
  const registry = createRegistry();
  const engine = createEngine({ registry, keymap: createKeymap(registry), platform: "win" });
  const ran: ActionId[] = [];
  // what the real handlers read from the controller, decided by the same pure rules
  const vim = { busy: false, edit: false, dirty: false, mode: "normal" };
  const build = (ids: ActionId[], extra: HandlerMap = {}) => {
    const map: HandlerMap = {};
    for (const id of ids) map[id] = () => void ran.push(id);
    registry.register({ ...map, ...extra });
  };
  build(
    [
      "res.edit", "doc.wrap", "doc.copy", "doc.foldToggle", "filter.open", "command.open", "nav.down", "nav.top", "nav.pageDown",
      "pane.next", "nav.crumbUp", "secret.revealKey", "help.overlay", "pane.focusLeft", "pane.focusDown", "pane.focusUp",
      "pane.focusRight", "pane.splitRight", "palette.open", "editor.review", "editor.find", "nav.back", "pane.close",
      "sidebar.toggle", "editor.selectNextOccurrence",
    ],
    {
      "vim.escape": { when: () => vimOwnsEscape(vim), run: () => void ran.push("vim.escape") },
      "editor.leave": { when: () => !vimOwnsEscape(vim), run: () => void ran.push("editor.leave") },
      "vim.keys": { when: (ctx) => vimTakesChord(ctx.chord, vim.mode), run: () => void ran.push("vim.keys") },
    },
  );
  return { engine, ran, vim, setBusy: (b: boolean) => (vim.busy = b) };
}

const view = viewScopes({ kind: "doc", format: "yaml", mode: "view" });
const secret = viewScopes({ kind: "doc", format: "secret", mode: "view" });
const edit = viewScopes({ kind: "doc", format: "yaml", mode: "edit" });

describe("vim layer: who gets a key", () => {
  it("without the layer the doc view's single keys are the app's", () => {
    const t = setup();
    t.engine.setBaseScopes(view);
    for (const key of ["e", "w", "c", "z", "/", ":", "j", "g"]) expect(t.engine.handle(k(key))).toBe("consumed");
    expect(t.ran).toEqual(["res.edit", "doc.wrap", "doc.copy", "doc.foldToggle", "filter.open", "command.open", "nav.down", "nav.top"]);
  });

  it("with the layer every plain and named key passes to vim, in a read-only view", () => {
    const t = setup();
    t.engine.setBaseScopes(secret);
    t.engine.pushScope(vimLayer("normal", "NORMAL"));
    for (const key of ["e", "y", "w", "c", "z", "/", ":", "j", "k", "h", "l", "g", "G", "?", "x", "0", "+", "'"]) {
      expect(t.engine.handle(k(key)), key).toBe("pass");
    }
    for (const key of ["Enter", "Tab", "Backspace", "Down", "Up", "Home", "End", "PgDn", "Space"]) {
      expect(t.engine.handle(k(key)), key).toBe("pass");
    }
    expect(t.ran).toEqual([]);
  });

  it("keeps Alt+h/j/k/l, the leader and Ctrl chords with the app", () => {
    const t = setup();
    t.engine.setBaseScopes(view);
    t.engine.pushScope(vimLayer("normal", "NORMAL"));
    for (const key of ["Alt+H", "Alt+J", "Alt+K", "Alt+L", "Ctrl+K", "Ctrl+Shift+B", "F1"]) expect(t.engine.handle(k(key)), key).toBe("consumed");
    expect(t.engine.handle(k("Ctrl+."))).toBe("consumed");
    expect(t.engine.handle(k("r"))).toBe("consumed");
    expect(t.ran).toEqual([
      "pane.focusLeft", "pane.focusDown", "pane.focusUp", "pane.focusRight", "palette.open", "sidebar.toggle", "help.overlay", "pane.splitRight",
    ]);
  });

  it("keeps the edit chords in EDIT, and insert mode types", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(vimLayer("insert", "EDIT"));
    expect(t.engine.handle(k("a"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Enter"), { editable: true })).toBe("pass");
    expect(t.engine.handle(k("Ctrl+S"), { editable: true })).toBe("consumed");
    expect(t.engine.handle(k("Alt+L"), { editable: true })).toBe("consumed");
    expect(t.ran).toEqual(["editor.review", "pane.focusRight"]);
  });

  it("hands vim the chords the webview would swallow", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(vimLayer("normal", "EDIT"));
    for (const key of ["Ctrl+R", "Ctrl+D", "Ctrl+U", "Ctrl+O"]) expect(t.engine.handle(k(key)), key).toBe("consumed");
    expect(t.ran).toEqual(["vim.keys", "vim.keys", "vim.keys", "vim.keys"]);
  });

  it("leaves the app its own pane chords in normal mode: Ctrl+B sidebar, Ctrl+F find, Ctrl+W close pane", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(vimLayer("normal", "EDIT"));
    for (const key of ["Ctrl+B", "Ctrl+F", "Ctrl+W"]) expect(t.engine.handle(k(key), { editable: true }), key).toBe("consumed");
    expect(t.ran).toEqual(["sidebar.toggle", "editor.find", "pane.close"]);
  });

  it("Ctrl+F is the doc search in a read-only vim view", () => {
    const t = setup();
    t.engine.setBaseScopes(view);
    t.engine.pushScope(vimLayer("normal", "NORMAL"));
    expect(t.engine.handle(k("Ctrl+F"))).toBe("consumed");
    expect(t.ran).toEqual(["filter.open"]);
    // and the hint shows the key that works there, not the "/" vim owns
    expect(t.engine.available().find((x) => x.action.id === "filter.open")?.bindings).toEqual([["Ctrl+F"]]);
  });

  it("while typing, Ctrl+W deletes a word (vim's) and never closes the pane; Ctrl+B and Ctrl+F stay the app's", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    for (const mode of ["insert", "replace"]) {
      t.vim.mode = mode;
      const pop = t.engine.pushScope(vimLayer(mode, "EDIT"));
      for (const key of ["Ctrl+W", "Ctrl+B", "Ctrl+F"]) expect(t.engine.handle(k(key), { editable: true }), key).toBe("consumed");
      pop();
    }
    expect(t.ran).toEqual(["vim.keys", "sidebar.toggle", "editor.find", "vim.keys", "sidebar.toggle", "editor.find"]);
  });

  it("hides single-key hints while the layer is up, but leaves the actions runnable", () => {
    const t = setup();
    t.engine.setBaseScopes(view);
    const wrap = () => t.engine.available().find((a) => a.action.id === "doc.wrap");
    expect(wrap()?.bindings).toEqual([["w"]]);
    t.engine.pushScope(vimLayer("normal", "NORMAL"));
    expect(wrap()?.bindings).toEqual([]);
    expect(t.engine.run("doc.wrap")).toBe(true);
  });
});

describe("vim layer: Esc", () => {
  it("is vim's while vim is busy, else it walks the pane's ladder", () => {
    const t = setup();
    t.engine.setBaseScopes(view);
    t.engine.pushScope(vimLayer("visual", "NORMAL"));
    t.setBusy(true);
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    t.setBusy(false);
    expect(t.engine.handle(k("Esc"))).toBe("consumed");
    expect(t.ran).toEqual(["vim.escape", "nav.back"]);
  });

  it("leaves a clean edit from an idle normal mode, as without vim", () => {
    const t = setup();
    t.vim.edit = true;
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(vimLayer("insert", "EDIT"));
    t.setBusy(true);
    t.engine.handle(k("Esc"), { editable: true });
    t.setBusy(false);
    // the hint row offers "Esc leave edit" again
    expect(t.engine.available().find((x) => x.action.id === "editor.leave")?.bindings).toEqual([["Esc"]]);
    t.engine.handle(k("Esc"), { editable: true });
    expect(t.ran).toEqual(["vim.escape", "editor.leave"]);
  });

  it("never leaves a dirty edit: every Esc is vim's, so Esc Esc :w Enter cannot reach the discard dialog", () => {
    const t = setup();
    t.vim.edit = true;
    t.vim.dirty = true;
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(vimLayer("insert", "EDIT"));
    t.setBusy(true);
    t.engine.handle(k("Esc"), { editable: true });
    t.setBusy(false);
    t.engine.handle(k("Esc"), { editable: true });
    t.engine.handle(k("Esc"), { editable: true });
    expect(t.ran).toEqual(["vim.escape", "vim.escape", "vim.escape"]);
    // and the hint row does not offer "Esc leave edit"
    expect(t.engine.available().some((x) => x.action.id === "editor.leave")).toBe(false);
  });

  it("stays in vim's command line: its layer passes Esc, Enter and text, keeps chords", () => {
    const t = setup();
    t.engine.setBaseScopes(secret);
    t.engine.pushScope(PROMPT_LAYER);
    t.setBusy(true);
    for (const key of ["Esc", "Enter", "w", "Up", "Backspace"]) expect(t.engine.handle(k(key), { editable: true }), key).toBe("pass");
    expect(t.engine.handle(k("Alt+H"), { editable: true })).toBe("consumed");
    expect(t.ran).toEqual(["pane.focusLeft"]);
    expect(t.engine.snapshot().mode).toBe("COMMAND");
  });

  it("keeps the pane's own chords off the buffer behind the command line", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    t.engine.pushScope(PROMPT_LAYER);
    // review, next occurrence, find, and vim.keys (which would act on the buffer, not the prompt)
    for (const key of ["Ctrl+S", "Ctrl+D", "Ctrl+F", "Ctrl+R"]) expect(t.engine.handle(k(key), { editable: true }), key).toBe("pass");
    expect(t.engine.handle(k("Ctrl+K"), { editable: true })).toBe("consumed");
    expect(t.ran).toEqual(["palette.open"]);
  });
});

describe("vim layer: badge", () => {
  it("shows vim's mode, or the pane's own in normal mode", () => {
    const t = setup();
    t.engine.setBaseScopes(edit, { mode: "EDIT" });
    const badge = (mode: string | undefined) => {
      const pop = t.engine.pushScope(vimLayer(mode, "EDIT"));
      const m = t.engine.snapshot().mode;
      pop();
      return m;
    };
    expect([undefined, "normal", "insert", "replace", "visual", "visual line", "visual block"].map(badge)).toEqual([
      "EDIT", "EDIT", "INSERT", "REPLACE", "VISUAL", "V-LINE", "V-BLOCK",
    ]);
    expect(vimBadge("normal", "NORMAL")).toBe("NORMAL");
    expect(t.engine.snapshot().mode).toBe("EDIT");
  });
});

describe("vimBusy", () => {
  const idle = { keyBuffer: [], operator: null, prefixRepeat: [], motionRepeat: [], registerName: undefined };
  it("is false for an idle normal mode and without vim", () => {
    expect(vimBusy(null)).toBe(false);
    expect(vimBusy({})).toBe(false);
    expect(vimBusy({ insertMode: false, visualMode: false, inputState: idle })).toBe(false);
  });
  it("is true in insert and visual mode", () => {
    expect(vimBusy({ insertMode: true, inputState: idle })).toBe(true);
    expect(vimBusy({ visualMode: true, inputState: idle })).toBe(true);
  });
  it("is true for a half-typed command", () => {
    expect(vimBusy({ inputState: { ...idle, keyBuffer: ["g"] } })).toBe(true);
    expect(vimBusy({ inputState: { ...idle, operator: "delete" } })).toBe(true);
    expect(vimBusy({ inputState: { ...idle, prefixRepeat: ["2"] } })).toBe(true);
    expect(vimBusy({ inputState: { ...idle, motionRepeat: ["3"] } })).toBe(true);
    expect(vimBusy({ inputState: { ...idle, registerName: "a" } })).toBe(true);
  });
  it("is true while a search highlight shows", () => {
    expect(vimBusy({ inputState: idle }, true)).toBe(true);
  });
});

describe("exBang", () => {
  it("reads the ! of :q!", () => {
    expect([exBang("!"), exBang(" ! "), exBang(""), exBang(undefined), exBang("x")]).toEqual([true, true, false, false, false]);
  });
});

describe("vimOwnsEscape", () => {
  it("is vim's while busy, in any view", () => {
    expect(vimOwnsEscape({ busy: true, edit: false, dirty: false })).toBe(true);
    expect(vimOwnsEscape({ busy: true, edit: true, dirty: false })).toBe(true);
  });
  it("is the pane's from an idle normal mode: back in a view, leave in a clean edit", () => {
    expect(vimOwnsEscape({ busy: false, edit: false, dirty: false })).toBe(false);
    expect(vimOwnsEscape({ busy: false, edit: true, dirty: false })).toBe(false);
  });
  it("stays with vim in a dirty edit", () => {
    expect(vimOwnsEscape({ busy: false, edit: true, dirty: true })).toBe(true);
  });
});

describe("vimTakesChord", () => {
  it("gives vim its scroll, redo and jump chords in every mode", () => {
    for (const mode of ["normal", "insert", "visual", undefined]) {
      for (const chord of ["Ctrl+R", "Ctrl+D", "Ctrl+U", "Ctrl+O"]) expect(vimTakesChord(chord, mode), chord).toBe(true);
    }
  });
  it("keeps Ctrl+B and Ctrl+F with the app in every mode", () => {
    for (const mode of ["normal", "insert", "replace", "visual", undefined]) {
      expect(vimTakesChord("Ctrl+B", mode)).toBe(false);
      expect(vimTakesChord("Ctrl+F", mode)).toBe(false);
    }
  });
  it("gives vim Ctrl+W only while typing", () => {
    expect(["insert", "replace"].map((m) => vimTakesChord("Ctrl+W", m))).toEqual([true, true]);
    expect(["normal", "visual", "visual line", undefined].map((m) => vimTakesChord("Ctrl+W", m))).toEqual([false, false, false, false]);
  });
  it("is there without a chord (hints, palette)", () => {
    expect(vimTakesChord(undefined, "normal")).toBe(true);
  });
});
