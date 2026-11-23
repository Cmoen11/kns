import { describe, expect, it } from "vitest";
import {
  canonicalBinding,
  canonicalChord,
  chordLabels,
  isCommandChord,
  isSingleKey,
  normalizeEvent,
  parseBindings,
  parseChord,
  type KeyEventLike,
} from "./chord";

interface Ev {
  key: string;
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  altGraph?: boolean;
  composing?: boolean;
}
function ev(e: Ev): KeyEventLike {
  return {
    key: e.key,
    code: e.code ?? "",
    ctrlKey: !!e.ctrl,
    altKey: !!e.alt,
    shiftKey: !!e.shift,
    metaKey: !!e.meta,
    isComposing: !!e.composing,
    getModifierState: (k) => k === "AltGraph" && !!e.altGraph,
  };
}
const win = (e: Ev) => normalizeEvent(ev(e), "win");
const mac = (e: Ev) => normalizeEvent(ev(e), "mac");

describe("normalizeEvent: Norwegian layout", () => {
  it("matches shifted symbols by the produced character", () => {
    expect(win({ key: "/", code: "Digit7", shift: true })?.chord).toBe("/");
    expect(win({ key: ":", code: "Period", shift: true })?.chord).toBe(":");
    expect(win({ key: "?", code: "Minus", shift: true })?.chord).toBe("?");
    expect(win({ key: "!", code: "Digit1", shift: true })?.chord).toBe("!");
    expect(win({ key: "*", code: "Backslash", shift: true })?.chord).toBe("*");
    expect(win({ key: ">", code: "IntlBackslash", shift: true })?.chord).toBe(">");
  });

  it("matches unshifted symbols", () => {
    for (const key of ["+", ",", ".", "-", "'", "<"]) expect(win({ key })?.chord).toBe(key);
  });

  it("treats AltGr as text: it matches a single key, never a modifier chord", () => {
    const s = win({ key: "[", code: "Digit8", ctrl: true, alt: true, altGraph: true });
    expect(s).toEqual({ chord: "[", bare: "[", typing: true, altGr: true });
  });

  it("treats Ctrl+Alt+printable as AltGr on Windows when AltGraph is not reported", () => {
    expect(win({ key: "]", code: "Digit9", ctrl: true, alt: true })?.chord).toBe("]");
    expect(win({ key: "@", code: "Digit2", ctrl: true, alt: true })?.altGr).toBe(true);
    // AltGr+8 never looks like Alt+8 or Ctrl+8 (rule 5)
    expect(win({ key: "[", code: "Digit8", ctrl: true, alt: true })?.chord).not.toMatch(/Alt|Ctrl/);
  });

  it("ignores AltGr with a non-printable key", () => {
    expect(win({ key: "ArrowLeft", code: "ArrowLeft", ctrl: true, alt: true, altGraph: true })).toBeNull();
  });

  it("matches modifier+digit on the physical key (rule 9)", () => {
    expect(win({ key: "1", code: "Digit1", ctrl: true })?.chord).toBe("Ctrl+1");
    expect(win({ key: "0", code: "Digit0", alt: true })?.chord).toBe("Alt+0");
    // Ctrl+Shift+0 produces '=' on a Norwegian layout; it must not become zoom in (rule 10)
    expect(win({ key: "=", code: "Digit0", ctrl: true, shift: true })?.chord).toBe("Ctrl+Shift+0");
  });

  it("accepts '=' for Ctrl/Cmd '+' on non-digit keys (rule 10)", () => {
    expect(win({ key: "+", code: "Minus", ctrl: true })?.chord).toBe("Ctrl++");
    expect(win({ key: "=", code: "Equal", ctrl: true })?.chord).toBe("Ctrl++");
    expect(mac({ key: "+", code: "Equal", meta: true, shift: true })?.chord).toBe("Cmd++");
    expect(win({ key: "-", code: "Slash", ctrl: true })?.chord).toBe("Ctrl+-");
    expect(win({ key: ".", code: "Period", ctrl: true })?.chord).toBe("Ctrl+.");
    expect(win({ key: ",", code: "Comma", ctrl: true })?.chord).toBe("Ctrl+,");
  });
});

describe("normalizeEvent: letters and modifiers", () => {
  it("takes letter case from shiftKey, ignoring CapsLock", () => {
    expect(win({ key: "g", code: "KeyG" })?.chord).toBe("g");
    expect(win({ key: "G", code: "KeyG", shift: true })?.chord).toBe("G");
    expect(win({ key: "G", code: "KeyG" })?.chord).toBe("g");
    expect(win({ key: "g", code: "KeyG", shift: true })?.chord).toBe("G");
  });

  it("writes modified letters uppercase with explicit Shift", () => {
    expect(win({ key: "k", code: "KeyK", ctrl: true })?.chord).toBe("Ctrl+K");
    expect(win({ key: "P", code: "KeyP", ctrl: true, shift: true })?.chord).toBe("Ctrl+Shift+P");
    expect(mac({ key: "k", code: "KeyK", meta: true })?.chord).toBe("Cmd+K");
    expect(mac({ key: "p", code: "KeyP", meta: true, shift: true })?.chord).toBe("Shift+Cmd+P");
    expect(mac({ key: "f", code: "KeyF", ctrl: true, meta: true })?.chord).toBe("Ctrl+Cmd+F");
  });

  it("falls back to the physical key for Ctrl/Cmd+letter on non-Latin layouts (rule 8)", () => {
    expect(win({ key: "л", code: "KeyK", ctrl: true })?.chord).toBe("Ctrl+K");
    expect(win({ key: "ø", code: "Semicolon" })?.chord).toBe("ø");
  });

  it("names special keys and keeps Shift on them", () => {
    expect(win({ key: "Escape" })?.chord).toBe("Esc");
    expect(win({ key: " ", code: "Space", shift: true })?.chord).toBe("Shift+Space");
    expect(win({ key: "ArrowLeft", alt: true })?.chord).toBe("Alt+Left");
    expect(win({ key: "ArrowUp", alt: true, shift: true })?.chord).toBe("Alt+Shift+Up");
    expect(win({ key: "Backspace", ctrl: true, shift: true })?.chord).toBe("Ctrl+Shift+Backspace");
    expect(win({ key: "PageUp", shift: true })?.chord).toBe("Shift+PgUp");
    expect(win({ key: "F10", shift: true })?.chord).toBe("Shift+F10");
    expect(win({ key: "ContextMenu" })?.chord).toBe("Menu");
    expect(win({ key: "Enter", ctrl: true })?.chord).toBe("Ctrl+Enter");
  });

  it("gives the chord with Ctrl/Cmd ignored for the key after the leader (rule 11)", () => {
    expect(win({ key: "r", code: "KeyR", ctrl: true })?.bare).toBe("r");
    expect(win({ key: "H", code: "KeyH", ctrl: true, shift: true })?.bare).toBe("H");
    expect(win({ key: "1", code: "Digit1", ctrl: true })?.bare).toBe("1");
    expect(win({ key: "=", code: "Digit0", ctrl: true, shift: true })?.bare).toBe("=");
    expect(mac({ key: ".", code: "Period", meta: true })?.bare).toBe(".");
  });

  it("marks keys that type text", () => {
    expect(win({ key: "d" })?.typing).toBe(true);
    expect(win({ key: " ", code: "Space" })?.typing).toBe(true);
    expect(win({ key: "Enter" })?.typing).toBe(false);
    expect(win({ key: "k", ctrl: true })?.typing).toBe(false);
  });

  it("never matches modifier keys, dead keys or IME composition (rule 12)", () => {
    expect(win({ key: "Shift" })).toBeNull();
    expect(win({ key: "Control", ctrl: true })).toBeNull();
    expect(win({ key: "AltGraph" })).toBeNull();
    expect(win({ key: "Dead", code: "BracketRight" })).toBeNull();
    expect(win({ key: "a", composing: true })).toBeNull();
    expect(win({ key: "Process" })).toBeNull();
  });
});

describe("normalizeEvent: macOS", () => {
  it("treats Option+printable as the produced character (rule 7)", () => {
    expect(mac({ key: "[", code: "Digit8", alt: true })).toEqual({ chord: "[", bare: "[", typing: true, altGr: true });
    expect(mac({ key: "|", code: "Digit7", alt: true })?.chord).toBe("|");
  });

  it("keeps Option on arrows, Enter and Cmd+digits", () => {
    expect(mac({ key: "ArrowUp", alt: true })?.chord).toBe("Alt+Up");
    expect(mac({ key: "Enter", alt: true })?.chord).toBe("Alt+Enter");
    expect(mac({ key: "¡", code: "Digit1", alt: true, meta: true })?.chord).toBe("Alt+Cmd+1");
    expect(mac({ key: "ArrowLeft", alt: true, meta: true })?.chord).toBe("Alt+Cmd+Left");
  });

  it("reads Option+h/j/k/l by physical key as Alt chords (pane focus)", () => {
    expect(mac({ key: "˙", code: "KeyH", alt: true })).toEqual({ chord: "Alt+H", bare: "Alt+H", typing: false, altGr: false });
    expect(mac({ key: "∆", code: "KeyJ", alt: true })?.chord).toBe("Alt+J");
    expect(mac({ key: "˚", code: "KeyK", alt: true })?.chord).toBe("Alt+K");
    expect(mac({ key: "¬", code: "KeyL", alt: true })?.chord).toBe("Alt+L");
    expect(mac({ key: "Ó", code: "KeyH", alt: true, shift: true })?.chord).toBe("Alt+Shift+H");
    // other Option letters still type their character
    expect(mac({ key: "∫", code: "KeyB", alt: true })?.altGr).toBe(true);
  });

  it("does not treat Ctrl+Alt as AltGr", () => {
    expect(mac({ key: "ArrowUp", ctrl: true, alt: true })?.chord).toBe("Ctrl+Alt+Up");
  });
});

describe("chord grammar", () => {
  it("parses '+' as a key", () => {
    expect(parseChord("+")).toMatchObject({ key: "+", ctrl: false });
    expect(parseChord("Ctrl++")).toMatchObject({ key: "+", ctrl: true });
    expect(parseChord("Ctrl+")).toBeNull();
    expect(parseChord("Hyper+K")).toBeNull();
    expect(parseChord("Ctrl+Foo")).toBeNull();
  });

  it("canonicalises", () => {
    expect(canonicalChord("Shift+g")).toBe("G");
    expect(canonicalChord("Ctrl+k")).toBe("Ctrl+K");
    expect(canonicalChord("Shift+?")).toBe("?");
    expect(canonicalChord("Cmd+Shift+P")).toBe("Shift+Cmd+P");
    expect(canonicalChord("Shift+Space")).toBe("Shift+Space");
    expect(canonicalChord("leader")).toBe("leader");
    expect(canonicalChord("nope")).toBeNull();
    expect(canonicalBinding(["leader", "r"])).toEqual(["leader", "r"]);
    expect(canonicalBinding([])).toBeNull();
  });

  it("parses the table notation per platform", () => {
    expect(parseBindings("Mod+K | Mod+Shift+P | leader p", "win")).toEqual([["Ctrl+K"], ["Ctrl+Shift+P"], ["leader", "p"]]);
    expect(parseBindings("Mod+K | leader p", "mac")).toEqual([["Cmd+K"], ["leader", "p"]]);
    expect(parseBindings("", "win")).toEqual([]);
    expect(parseBindings("Mod++", "win")).toEqual([["Ctrl++"]]);
    expect(() => parseBindings("Ctrl+Nope", "win")).toThrow();
  });

  it("classifies chords", () => {
    expect(isSingleKey("d")).toBe(true);
    expect(isSingleKey("?")).toBe(true);
    expect(isSingleKey("Enter")).toBe(false);
    expect(isSingleKey("Ctrl+D")).toBe(false);
    expect(isCommandChord("Ctrl+K")).toBe(true);
    expect(isCommandChord("F6")).toBe(true);
    expect(isCommandChord("Shift+Up")).toBe(false);
  });

  it("labels chips per platform", () => {
    expect(chordLabels("Ctrl+Shift+P", "win")).toEqual(["Ctrl", "Shift", "P"]);
    expect(chordLabels("Shift+Cmd+P", "mac")).toEqual(["⇧", "⌘", "P"]);
    expect(chordLabels("Alt+Left", "win")).toEqual(["Alt", "←"]);
    expect(chordLabels("g", "win")).toEqual(["g"]);
  });
});
