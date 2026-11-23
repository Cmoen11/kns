// Chord grammar and KeyboardEvent normalisation (docs/ux.md §5.1). Pure, no DOM access.
//
// Canonical chord: [Ctrl+][Alt+][Shift+][Cmd+]<key>
//   <key> is one produced character ('/', ':', 'g', 'G', '+') or a named key (NAMED_KEYS).
//   - Bare letters are case-sensitive and never carry Shift: 'g', 'G'.
//   - Letters with Ctrl/Alt/Cmd are written uppercase, Shift explicit: 'Ctrl+K', 'Ctrl+Shift+P'.
//   - Symbols never carry Shift (the character encodes it): '?', 'Ctrl+.', 'Ctrl++'.
//   - Digits with Ctrl/Alt/Cmd come from event.code (rule 9): 'Ctrl+1', 'Alt+0'.
// The pseudo-chord 'leader' is only valid as the first element of a binding.
import type { Binding, Chord } from "../types";

export type Platform = "win" | "mac";

export const LEADER = "leader";

export const NAMED_KEYS = [
  "Enter", "Esc", "Tab", "Space", "Backspace", "Delete", "Insert",
  "Up", "Down", "Left", "Right", "Home", "End", "PgUp", "PgDn", "Menu",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
] as const;
const NAMED = new Set<string>(NAMED_KEYS);

const EVENT_KEY_NAMES: Record<string, string> = {
  Enter: "Enter", Escape: "Esc", Tab: "Tab", " ": "Space", " ": "Space", Backspace: "Backspace",
  Delete: "Delete", Insert: "Insert", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
  ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn", ContextMenu: "Menu",
};

const MODS = ["Ctrl", "Alt", "Shift", "Cmd"] as const;
type Mod = (typeof MODS)[number];

export interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  cmd: boolean;
  key: string;
}

const isLetter = (ch: string) => ch.toLowerCase() !== ch.toUpperCase();
const isSingleChar = (s: string) => [...s].length === 1;

function build(p: ParsedChord): Chord {
  let out = "";
  if (p.ctrl) out += "Ctrl+";
  if (p.alt) out += "Alt+";
  if (p.shift) out += "Shift+";
  if (p.cmd) out += "Cmd+";
  return out + p.key;
}

/** Splits a chord string into modifiers and key. Returns null when it is not a chord. */
export function parseChord(chord: string): ParsedChord | null {
  if (chord === "" || chord === LEADER) return null;
  let rest = chord;
  let key: string;
  if (rest.endsWith("+")) {
    // '+' itself is the key: '+', 'Ctrl++'
    key = "+";
    rest = rest.slice(0, -1);
    if (rest.endsWith("+")) rest = rest.slice(0, -1);
    else if (rest !== "") return null;
  } else {
    const i = rest.lastIndexOf("+");
    key = rest.slice(i + 1);
    rest = i < 0 ? "" : rest.slice(0, i);
  }
  const p: ParsedChord = { ctrl: false, alt: false, shift: false, cmd: false, key };
  if (rest !== "") {
    for (const m of rest.split("+")) {
      if (m === "Ctrl") p.ctrl = true;
      else if (m === "Alt") p.alt = true;
      else if (m === "Shift") p.shift = true;
      else if (m === "Cmd") p.cmd = true;
      else return null;
    }
  }
  if (!NAMED.has(key) && !(isSingleChar(key) && key.trim() !== "")) return null;
  return p;
}

/**
 * Canonical form of a chord written by a person or stored in an override ('shift+g' is not
 * accepted, 'Shift+g' becomes 'G', 'Ctrl+k' becomes 'Ctrl+K', 'Shift+?' becomes '?').
 * Returns null when the string is not a valid chord. 'leader' passes through.
 */
export function canonicalChord(chord: string): Chord | null {
  if (chord === LEADER) return LEADER;
  const p = parseChord(chord);
  if (!p) return null;
  if (NAMED.has(p.key)) return build(p);
  const hasMod = p.ctrl || p.alt || p.cmd;
  if (/^[0-9]$/.test(p.key)) return hasMod ? build(p) : build({ ...p, shift: false });
  if (isLetter(p.key)) {
    if (hasMod) return build({ ...p, key: p.key.toUpperCase() });
    return p.shift ? p.key.toUpperCase() : p.key;
  }
  return build({ ...p, shift: false });
}

/** Canonical binding (sequence), or null when any chord is invalid or 'leader' is misplaced. */
export function canonicalBinding(binding: readonly string[]): Binding | null {
  if (binding.length === 0) return null;
  const out: Binding = [];
  for (let i = 0; i < binding.length; i++) {
    const c = canonicalChord(binding[i]);
    if (c === null) return null;
    out.push(c);
  }
  return out;
}

/**
 * Parses the compact notation of the keymap table: alternatives separated by ' | ', chords of a
 * sequence by spaces: 'Ctrl+K | Ctrl+Shift+P | leader p'. 'Mod' is Ctrl on Windows, Cmd on macOS.
 * Throws on an invalid chord, since the table is code.
 */
export function parseBindings(spec: string, platform: Platform): Binding[] {
  const s = spec.trim();
  if (s === "") return [];
  return s.split(" | ").map((alt) => {
    const chords = alt.trim().split(/\s+/).map((c) => c.replace(/\bMod\b/, platform === "mac" ? "Cmd" : "Ctrl"));
    const b = canonicalBinding(chords);
    if (!b) throw new Error(`invalid binding "${alt}" in "${spec}"`);
    return b;
  });
}

export const bindingKey = (b: readonly string[]) => b.join(" ");

/** The subset of KeyboardEvent the normaliser reads; tests pass plain objects. */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
}

export interface Stroke {
  /** canonical chord */
  chord: Chord;
  /** the chord with Ctrl and Cmd ignored (rule 11, the key after the leader) */
  bare: Chord;
  /** true when the key inserts text into a focused input: a bare character or (Shift+)Space */
  typing: boolean;
  /** true when the character came from AltGr / Option (rule 4, 7); never matches a modifier chord */
  altGr: boolean;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Fn", "OS", "Hyper", "Super"]);
const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;
const LETTER_CODE = /^Key([A-Z])$/;
// macOS Option + these physical keys is a chord (Alt+H…), not the character it would type (˙ ∆ ˚ ¬):
// pane focus the vim way, as Alt+h/j/k/l on Windows. Matched by event.code, so any layout works.
const MAC_OPTION_CHORD_CODE = /^Key([HJKL])$/;

function chordFrom(e: KeyEventLike, ctrl: boolean, alt: boolean, meta: boolean): Chord | null {
  const shift = e.shiftKey;
  const hasMod = ctrl || alt || meta;
  const mods = { ctrl, alt, cmd: meta };
  // rule 9: modifier + digit matches the physical digit key
  const digit = DIGIT_CODE.exec(e.code);
  if (hasMod && digit) return build({ ...mods, shift, key: digit[1] });
  const named = EVENT_KEY_NAMES[e.key] ?? (/^F([1-9]|1[0-2])$/.test(e.key) ? e.key : undefined);
  if (named) return build({ ...mods, shift, key: named });
  if (!isSingleChar(e.key)) return null;
  let ch = e.key;
  if (isLetter(ch)) {
    if (hasMod) {
      // rule 8: Ctrl/Cmd+letter falls back to the physical key on non-Latin layouts
      const code = LETTER_CODE.exec(e.code);
      if ((ctrl || meta) && !/^[a-z]$/i.test(ch) && code) ch = code[1];
      return build({ ...mods, shift, key: ch.toUpperCase() });
    }
    // rule 3: case from shiftKey, so CapsLock is ignored
    return shift ? ch.toUpperCase() : ch.toLowerCase();
  }
  // rule 10: Ctrl/Cmd with '+' also accepts '=' (digit keys were handled above)
  if ((ctrl || meta) && ch === "=") ch = "+";
  // rule 2: Shift is ignored for symbols
  return build({ ...mods, shift: false, key: ch });
}

/**
 * Turns a keydown into a Stroke, or null when the event must never be matched
 * (modifier keys, dead keys, IME composition, AltGr with a non-printable key).
 */
export function normalizeEvent(e: KeyEventLike, platform: Platform): Stroke | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return null;
  if (MODIFIER_KEYS.has(e.key)) return null;

  const printable = isSingleChar(e.key) && EVENT_KEY_NAMES[e.key] === undefined;
  // rule 4: AltGr first. The Windows fallback is Ctrl+Alt with a printable key.
  const altGraph =
    e.getModifierState?.("AltGraph") === true ||
    (platform === "win" && e.ctrlKey && e.altKey && !e.metaKey && isSingleChar(e.key));
  // rule 7: on macOS Option + a printable key produces a character
  const option = platform === "mac" && e.altKey && !e.ctrlKey && !e.metaKey && printable;
  const optionChord = option && !e.getModifierState?.("AltGraph") ? MAC_OPTION_CHORD_CODE.exec(e.code) : null;
  if (optionChord) {
    const chord = build({ ctrl: false, alt: true, shift: e.shiftKey, cmd: false, key: optionChord[1] });
    return { chord, bare: chord, typing: false, altGr: false };
  }
  if (altGraph || option) {
    if (!printable) return null;
    return { chord: e.key, bare: e.key, typing: true, altGr: true };
  }

  const chord = chordFrom(e, e.ctrlKey, e.altKey, e.metaKey);
  if (chord === null) return null;
  const bare = chordFrom(e, false, e.altKey, false) ?? chord;
  const typing = !e.ctrlKey && !e.altKey && !e.metaKey && (printable || chord === "Space" || chord === "Shift+Space");
  return { chord, bare, typing, altGr: false };
}

/** True for a chord that is a single character key with no Ctrl/Alt/Cmd ("single keys", §5.2). */
export function isSingleKey(chord: Chord): boolean {
  const p = parseChord(chord);
  return !!p && !p.ctrl && !p.alt && !p.cmd && !NAMED.has(p.key);
}

/** True when the chord cannot type text: it has Ctrl/Alt/Cmd or is an F-key. */
export function isCommandChord(chord: Chord): boolean {
  const p = parseChord(chord);
  return !!p && (p.ctrl || p.alt || p.cmd || /^F\d+$/.test(p.key));
}

const MAC_MOD: Record<Mod, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };
const KEY_LABEL: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };
const MAC_KEY_LABEL: Record<string, string> = { ...KEY_LABEL, Backspace: "⌫", Delete: "⌦", Enter: "↩" };

/** Chip labels for one chord, one string per chip: 'Ctrl+K' -> ['Ctrl','K'] or ['⌘','K']. */
export function chordLabels(chord: Chord, platform: Platform): string[] {
  const p = parseChord(chord);
  if (!p) return [chord];
  const out: string[] = [];
  const mod = (m: Mod) => out.push(platform === "mac" ? MAC_MOD[m] : m);
  if (p.ctrl) mod("Ctrl");
  if (p.alt) mod("Alt");
  if (p.shift) mod("Shift");
  if (p.cmd) mod("Cmd");
  out.push((platform === "mac" ? MAC_KEY_LABEL : KEY_LABEL)[p.key] ?? p.key);
  return out;
}

/** Plain text for a binding, for aria labels and the macOS menu: 'Ctrl+. r'. */
export function bindingText(binding: readonly Chord[], platform: Platform): string {
  return binding.map((c) => chordLabels(c, platform).join(platform === "mac" ? "" : "+")).join(" ");
}
