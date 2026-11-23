// The one window-level key listener (docs/ux.md §5.1). Nothing else in the app listens for
// shortcut keys: components register actions instead.
import { normalizeEvent, type Platform } from "./chord";
import type { Engine } from "./engine";
import { engine as defaultEngine } from "./instance";

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

/** True when typing into the target inserts text (§5.2). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return target.isContentEditable;
}

// §5.1 rule 13: webview accelerators we never want, even when no action is bound to them.
// Only suppressed outside inputs, editors and terminals. Never the OS chords.
const ACCELERATORS: Record<Platform, ReadonlySet<string>> = {
  win: new Set([
    "F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+P", "Ctrl+Shift+P", "Ctrl+F", "Ctrl+G", "Ctrl+Shift+G", "F3", "Shift+F3",
    "F7", "Ctrl+U", "Ctrl++", "Ctrl+-", "Ctrl+0", "Alt+Left", "Alt+Right", "Ctrl+S", "Ctrl+O", "Ctrl+N", "Ctrl+T",
    "Ctrl+H", "Ctrl+J", "Ctrl+D", "Ctrl+L", "Ctrl+E", "Ctrl+K", "F1", "F6", "Shift+F6", "F11", "Shift+F10",
  ]),
  mac: new Set([
    "Cmd+R", "Shift+Cmd+R", "Cmd+P", "Cmd+F", "Cmd+G", "Shift+Cmd+G", "Cmd++", "Cmd+-", "Cmd+0", "Cmd+S", "Cmd+O",
    "Cmd+N", "Cmd+T", "Cmd+L", "Cmd+[", "Cmd+]", "Cmd+D", "Cmd+E", "Cmd+K", "F5",
  ]),
};

// Reload, print, browser zoom and save are never wanted, also not while typing in an input or editor.
const ACCELERATORS_IN_INPUTS: Record<Platform, ReadonlySet<string>> = {
  win: new Set([
    "F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+P", "Ctrl+Shift+P", "Ctrl++", "Ctrl+-", "Ctrl+0", "Ctrl+S", "Ctrl+O", "Ctrl+G",
    "F3", "F7",
  ]),
  mac: new Set(["Cmd+R", "Shift+Cmd+R", "Cmd+P", "Cmd++", "Cmd+-", "Cmd+0", "Cmd+S", "Cmd+O"]),
};

/**
 * Installs the capture-phase keydown listener. Call once at startup; returns the uninstaller.
 * - consumed: preventDefault + stopPropagation (no component sees the key)
 * - pass: the event is left untouched for the input, editor, terminal or browser
 */
export function installKeys(target: Window = window, engine: Engine = defaultEngine): () => void {
  const platform = engine.platform;
  const onKeyDown = (e: KeyboardEvent) => {
    // a bare Alt press would focus the (absent) window menu on Windows
    if (platform === "win" && e.key === "Alt") {
      e.preventDefault();
      return;
    }
    const stroke = normalizeEvent(e, platform);
    if (!stroke) return;
    const editable = isEditableTarget(e.target);
    const result = engine.handle(stroke, { editable, repeat: e.repeat, event: e });
    if (result === "consumed") {
      e.preventDefault();
      e.stopPropagation();
    } else if (engine.snapshot().mode !== "TERM") {
      // TERM is left alone: xterm decides what the shell gets
      const list = editable ? ACCELERATORS_IN_INPUTS : ACCELERATORS;
      if (list[platform].has(stroke.chord)) e.preventDefault();
    }
  };
  // the leader has no timeout, so a lost focus must not leave it armed
  const onBlur = () => engine.reset();
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("blur", onBlur);
  };
}
