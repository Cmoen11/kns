// `:` command mode (docs/ux.md §6.2): a 20px bar input inside the focused pane's header, scoped
// to that pane. Tab accepts the ghost completion, Up/Down step through completions (or the
// command history when there is nothing to complete), Enter runs.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYERS } from "../../actions";
import { flash, useFocusedPane } from "../../foundation";
import type { PaneId } from "../../types";
import { Glyph } from "../../ui";
import { paneHeader } from "../header";
import { dismiss, useOverlaySession, type ListController, type NewPane } from "../session";
import { parseCommand, suggest } from "./parse";
import { commandEnv, runCommand } from "./run";

const history: string[] = [];
const HISTORY_CAP = 50;

function remember(line: string): void {
  const l = line.trim();
  if (l === "") return;
  const i = history.indexOf(l);
  if (i >= 0) history.splice(i, 1);
  history.unshift(l);
  history.length = Math.min(history.length, HISTORY_CAP);
}

export function CommandBar({ pane, newPane }: { pane: PaneId; newPane: NewPane }) {
  const [text, setTextRaw] = useState("");
  /** index into the completions (or the history); null = nothing chosen */
  const [sel, setSel] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const header = useMemo(() => paneHeader(), []);
  const env = useMemo(() => commandEnv(), []);
  const focused = useFocusedPane();

  /** what the user typed; stepping through completions shows them without losing it */
  const typed = useRef("");
  const options = useMemo(() => (typed.current.trim() === "" ? history : suggest(typed.current, env)), [text, env]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = sel !== null && options[sel] !== undefined ? options[sel] : text;
  const first = sel === null ? suggest(text, env, 1)[0] : undefined;
  const bare = text.replace(/^\s*:?\s*/, "");
  const ghost = first && first.length > bare.length ? first.slice(bare.length) : "";

  const setText = (t: string) => {
    typed.current = t;
    setTextRaw(t);
    setSel(null);
    setError(null);
  };

  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  // the bar belongs to one pane: it goes away when focus moves on
  useEffect(() => {
    if (focused !== pane || !header?.isConnected) dismiss();
  }, [focused, pane, header]);

  async function run(line: string, beside: NewPane) {
    remember(line);
    dismiss();
    const err = await runCommand(line, { pane, newPane: beside });
    if (err) flash(err, "warn");
  }

  const controller: ListController = {
    down: () => setSel(sel === null ? (options.length > 0 ? 0 : null) : Math.min(options.length - 1, sel + 1)),
    up: () => setSel(sel === null ? (options.length > 0 ? 0 : null) : sel > 0 ? sel - 1 : null),
    accept: (beside) => {
      const line = shown;
      const parsed = parseCommand(line, env);
      if (parsed.type === "empty") return dismiss();
      if (parsed.type !== "error") return void run(line, beside ?? newPane);
      // not a command as typed: Enter takes the completion, as Tab then Enter would
      if (first && parseCommand(first, env).type !== "error") return void run(first, beside ?? newPane);
      setError(parsed.message);
    },
    close: dismiss,
    complete: () => {
      if (sel !== null) setText(shown);
      else if (first) setText(first);
    },
  };
  useOverlaySession(LAYERS.command, controller);

  if (!header) return null;
  return createPortal(
    <div className="k-bar pal-bar">
      <label className="k-bar-label t-label" htmlFor="pal-command-input">
        Command
      </label>
      <div className="k-bar-field pal-bar-field">
        {ghost && (
          <span className="pal-ghost t-input" aria-hidden="true">
            <span className="pal-ghost-typed">{text}</span>
            {ghost}
          </span>
        )}
        <input
          ref={input}
          id="pal-command-input"
          className="t-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-invalid={error ? true : undefined}
          value={shown}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {error && (
        <span className="k-bar-error t-ui" role="alert">
          <Glyph state="error" />
          {error}
        </span>
      )}
    </div>,
    header,
  );
}
