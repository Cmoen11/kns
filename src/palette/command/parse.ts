// The `:` command grammar of docs/ux.md §6.2. Pure: the lookups are injected, so the parser and
// the completion are tested without a registry or a cluster.
import type { Filter } from "../../types";

/** A command phrase and the action it runs: ["layout", "save"] -> fav.saveLayout. */
export interface CommandSpec {
  words: readonly string[];
  id: string;
}

export interface ParseEnv {
  /** every runnable command phrase (registry rows with `command`, plus the palette's own) */
  commands: readonly CommandSpec[];
  /** true when the word is a plural, singular, short name, kind or name.group from discovery */
  isResource: (alias: string) => boolean;
}

export type Command =
  | { type: "empty" }
  /** `:po`, `:po ns`, `:pod app=x`, `:pod /re`, `:pod -f fz`, `:pod @ctx` */
  | { type: "resource"; alias: string; namespace?: string; filters: Filter[]; context?: string }
  /** a registry action; `args` are the words after the command phrase */
  | { type: "action"; id: string; args: string[] }
  /** `:fav <name>`; an empty name opens the picker */
  | { type: "fav"; name: string }
  /** `:layout <name>`; an empty name opens the picker */
  | { type: "layout"; name: string }
  | { type: "error"; message: string };

export const tokenize = (input: string): string[] => input.replace(/^\s*:/, "").trim().split(/\s+/).filter(Boolean);

/** The longest command phrase that the words start with (`layout save` beats `layout`). */
function matchCommand(words: readonly string[], commands: readonly CommandSpec[]): CommandSpec | null {
  let best: CommandSpec | null = null;
  for (const c of commands) {
    if (c.words.length > words.length || (best && c.words.length <= best.words.length)) continue;
    if (c.words.every((w, i) => w === words[i].toLowerCase())) best = c;
  }
  return best;
}

const isSelector = (t: string): boolean => /[=]/.test(t) || /^!?[A-Za-z0-9][\w./-]*,/.test(t);

function parseResource(alias: string, rest: readonly string[]): Command {
  const out: { type: "resource"; alias: string; namespace?: string; filters: Filter[]; context?: string } = {
    type: "resource", alias: alias.toLowerCase(), filters: [],
  };
  const setNamespace = (ns: string): Command | null => {
    if (out.namespace !== undefined) return { type: "error", message: `unexpected argument "${ns}"` };
    out.namespace = ns;
    return null;
  };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("@")) {
      if (t.length === 1) return { type: "error", message: "context name missing after @" };
      if (out.context !== undefined) return { type: "error", message: "only one @context is allowed" };
      out.context = t.slice(1);
    } else if (t.startsWith("/")) {
      const text = t.slice(1);
      if (text === "" || text === "!") return { type: "error", message: "filter text missing after /" };
      out.filters.push(text.startsWith("!") ? { mode: "not", text: text.slice(1) } : { mode: "re", text });
    } else if (t === "-f" || t === "-l" || t === "-n") {
      const value = rest[++i];
      if (value === undefined) return { type: "error", message: `${t} needs a value` };
      if (t === "-f") out.filters.push({ mode: "fuzzy", text: value });
      else if (t === "-l") out.filters.push({ mode: "label", selector: value });
      else {
        const err = setNamespace(value);
        if (err) return err;
      }
    } else if (t === "-A" || t === "*" || t.toLowerCase() === "all") {
      const err = setNamespace("*");
      if (err) return err;
    } else if (isSelector(t)) {
      out.filters.push({ mode: "label", selector: t });
    } else {
      const err = setNamespace(t);
      if (err) return err;
    }
  }
  return out;
}

/**
 * Parses one command line (with or without the leading colon).
 * Order: the longest command phrase, then `fav` / `layout` with a name, then a resource alias.
 * A command wins over a resource with the same name.
 */
export function parseCommand(input: string, env: ParseEnv): Command {
  const words = tokenize(input);
  if (words.length === 0) return { type: "empty" };
  const cmd = matchCommand(words, env.commands);
  const head = words[0].toLowerCase();
  // `fav` and `layout` take a free-text name; only their longer phrases (`fav save`) are commands
  if ((head === "fav" || head === "layout") && (!cmd || cmd.words.length === 1)) {
    return { type: head, name: words.slice(1).join(" ") };
  }
  if (cmd) return { type: "action", id: cmd.id, args: words.slice(cmd.words.length) };
  if (env.isResource(head)) return parseResource(head, words.slice(1));
  return { type: "error", message: `unknown command "${words[0]}"` };
}

/** First words of the `:` commands of built actions (registry rows; the EXTRA words of run.ts are built-in too). */
export function builtCommandWords(defs: readonly { command?: string; built: boolean; alias?: string }[], extra: readonly string[] = EXTRA_WORDS): Set<string> {
  const out = new Set<string>(["fav", "layout", ...extra]);
  for (const d of defs) if (d.command && d.built && !d.alias) out.add(d.command.split(" ")[0].toLowerCase());
  return out;
}

/** The palette's and completion's name for a resource: `name.group` when a command word shadows `name`. */
export function shadowedName(resource: string, group: string, commandWords: ReadonlySet<string>): string {
  return group !== "" && commandWords.has(resource.toLowerCase()) ? `${resource}.${group}` : resource;
}

/** Command words of run.ts EXTRA (no keymap row of their own). */
export const EXTRA_WORDS: readonly string[] = ["split", "zoom", "equal", "reconcile", "keys"];

// ── completion ───────────────────────────────────────────────────────────────

export interface CompleteEnv extends ParseEnv {
  /** resource names for completion, preferred first (plurals before short names) */
  resources: readonly string[];
  namespaces: readonly string[];
  contexts: readonly string[];
  favourites: readonly string[];
  layouts: readonly string[];
}

/** Fixed argument values of the appearance and safety commands. */
export const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  theme: ["claude"],
  mode: ["system", "lys", "mork"],
  ui: ["100", "110", "125", "150"],
  rows: ["20", "28"],
  ro: ["on", "off"],
  protect: ["on", "off"],
  kill: ["on", "off"],
};

const uniq = (list: readonly string[]): string[] => [...new Set(list)];

/** What may follow the words typed so far (the word being typed excluded). */
function candidates(head: readonly string[], last: string, env: CompleteEnv): string[] {
  if (head.length === 0) {
    return uniq([...env.commands.map((c) => c.words[0]), "fav", "layout", ...env.resources]);
  }
  const lower = head.map((w) => w.toLowerCase());
  const out: string[] = [];
  // the next word of a longer command phrase: `layout ` -> save, `split ` -> r, d
  for (const c of env.commands) {
    if (c.words.length > lower.length && lower.every((w, i) => w === c.words[i])) out.push(c.words[lower.length]);
  }
  if (lower.length === 1) {
    const first = lower[0];
    if (OPTIONS[first]) out.push(...OPTIONS[first]);
    if (first === "ns") out.push(...env.namespaces);
    else if (first === "ctx") out.push(...env.contexts);
    else if (first === "fav") out.push(...env.favourites);
    else if (first === "layout") out.push(...env.layouts);
  }
  const isCommand = env.commands.some((c) => c.words[0] === lower[0]) || lower[0] === "fav" || lower[0] === "layout";
  if (!isCommand && env.isResource(lower[0])) {
    if (last.startsWith("@")) out.push(...env.contexts.map((c) => `@${c}`));
    else if (!lower.slice(1).some((w) => !/^[@/-]/.test(w) && !w.includes("="))) out.push(...env.namespaces);
  }
  return uniq(out);
}

/**
 * Full-line completions for the input, best first: every candidate that starts with the word
 * being typed (case-insensitive) and is longer than it. Empty when the input ends in a space.
 */
export function suggest(input: string, env: CompleteEnv, limit = 50): string[] {
  const body = input.replace(/^\s*:/, "").replace(/^\s+/, "");
  if (body === "" || /\s$/.test(body)) return [];
  const words = body.split(/\s+/);
  const last = words[words.length - 1];
  const stem = body.slice(0, body.length - last.length);
  const l = last.toLowerCase();
  const out: string[] = [];
  for (const c of candidates(words.slice(0, -1), last, env)) {
    if (c.length > l.length && c.toLowerCase().startsWith(l)) {
      out.push(stem + c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The ghost completion (Tab): the first suggestion, or null. */
export function complete(input: string, env: CompleteEnv): string | null {
  return suggest(input, env, 1)[0] ?? null;
}
