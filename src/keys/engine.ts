// The key engine: scope stack, sequences, leader, the `+` prefix and action dispatch
// (docs/ux.md §4.1, §4.2 step 1, §5.1-5.3). No DOM access: the dispatcher feeds it Strokes.
import { OS_CHORDS } from "../actions/keymap-data";
import type { ActionContext, ActionDef, ActionHandler, ActionId, ActionSource, Registry } from "../actions/registry";
import type { ModeBadge, ScopeId, ScopeLayer } from "../actions/scopes";
import type { Binding, Chord } from "../types";
import { chordLabels, isCommandChord, isSingleKey, parseChord, type KeyEventLike, type Platform, type Stroke } from "./chord";
import type { KeyEntry, Keymap } from "./keymap";

export type HandleResult =
  /** the app used the key: preventDefault + stopPropagation */
  | "consumed"
  /** not ours: leave the event alone (input, editor, terminal, browser) */
  | "pass";

export interface StrokeInfo {
  /** the event target is a text input, textarea or contenteditable */
  editable?: boolean;
  repeat?: boolean;
  event?: KeyEventLike;
}

export interface EngineEnv {
  /** read-only mode: write actions are disabled */
  readOnly: boolean;
  /** false = single character keys are inactive everywhere (WCAG 2.1.4) */
  singleKeys: boolean;
}

export type EngineEvent =
  | { type: "run"; id: ActionId; source: ActionSource }
  | { type: "blocked"; id: ActionId; reason: string }
  | { type: "message"; text: string }
  | { type: "error"; id: ActionId; error: unknown };

export interface AvailableAction {
  action: ActionDef;
  /** bindings live right now, leader expanded (may be empty for command-only actions) */
  bindings: Binding[];
  enabled: boolean;
  /** why it is disabled */
  reason?: string;
}

export interface EngineSnapshot {
  mode: ModeBadge;
  /** chords typed so far of an unfinished sequence */
  pending: readonly Chord[];
  /** true while pending starts with the leader (PANE mode) */
  leader: boolean;
  /** when the pending sequence started (for the 250ms which-key delay) */
  pendingSince: number;
  prefix: "right" | "down" | null;
  /** active scopes, most specific first */
  scopes: readonly ScopeId[];
}

export interface EngineOptions {
  registry: Registry;
  keymap: Keymap;
  platform: Platform;
  /** ms before an unfinished non-leader sequence is dropped */
  sequenceTimeout?: number;
  now?: () => number;
}

interface Segment {
  scopes: readonly ScopeId[];
  chordsOnly: boolean;
  /** chordsOnly, but Esc is let through as well (below: "chords+esc") */
  esc: boolean;
  /** under a "global-chords" layer: only the `global` scope of this segment is live */
  globalOnly: boolean;
}

const PREFIX_RIGHT: ActionId = "pane.newPrefixRight";
const PREFIX_DOWN: ActionId = "pane.newPrefixDown";
const PREFIX_LAYER: ScopeLayer = { scopes: ["newpane"], below: "all" };

// §5.2: text-editing chords always belong to a focused input.
const INPUT_OWNED: Record<Platform, ReadonlySet<Chord>> = {
  win: new Set([
    "Ctrl+A", "Ctrl+C", "Ctrl+X", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+Backspace", "Ctrl+Delete",
    "Ctrl+Left", "Ctrl+Right", "Ctrl+Shift+Left", "Ctrl+Shift+Right", "Ctrl+Home", "Ctrl+End",
    "Ctrl+Shift+Home", "Ctrl+Shift+End", "Shift+Insert", "Ctrl+Insert", "Shift+Delete",
  ]),
  mac: new Set([
    "Cmd+A", "Cmd+C", "Cmd+X", "Cmd+V", "Cmd+Z", "Shift+Cmd+Z", "Alt+Backspace", "Cmd+Backspace", "Alt+Delete",
    "Alt+Left", "Alt+Right", "Alt+Shift+Left", "Alt+Shift+Right", "Cmd+Left", "Cmd+Right", "Shift+Cmd+Left",
    "Shift+Cmd+Right", "Cmd+Up", "Cmd+Down", "Shift+Cmd+Up", "Shift+Cmd+Down",
  ]),
};
// Caret keys: in an input they can only be claimed by the layer that owns the input.
const INPUT_SOFT: ReadonlySet<Chord> = new Set([
  "Left", "Right", "Up", "Down", "Home", "End", "Backspace", "Delete",
  "Shift+Left", "Shift+Right", "Shift+Up", "Shift+Down", "Shift+Home", "Shift+End",
]);

// §5.3 TERM on Windows: "the app owns exactly this list". Alt+H/J/K/L is pane focus (the chord
// of Alt+h): without it a shell pane could not be left the vim way. Unbinding it gives it back to the shell.
// macOS keeps the same Option+h/j/k/l (chord.ts reads them by physical key).
const TERM_KEEPS_WIN = /^(?:Ctrl\+Shift\+(?:[A-Z]|Enter|Space)|Ctrl\+[1-9]|Ctrl\+,|Alt\+(?:Shift\+)?(?:Left|Right|Up|Down)|Alt\+[HJKL]|Alt\+[0-9]|Alt\+Enter|F1|F5|F6|Shift\+F6|Shift\+PgUp|Shift\+PgDn|Shift\+F10|Ctrl\+Insert|Shift\+Insert)$/;
const TERM_KEEPS_MAC = /^(?:Alt\+[HJKL]|F1|F5|F6|Shift\+F6|Shift\+F10)$/;

export interface Engine {
  /** Feeds one keydown. */
  handle(stroke: Stroke, info?: StrokeInfo): HandleResult;
  /** Runs an action from the palette, a menu, a click or code. Returns false when it did not run. */
  run(id: ActionId, opts?: { source?: ActionSource; newPane?: "right" | "down" | null; args?: readonly string[] }): boolean;
  /** The focused pane's scope chain (viewScopes) and badge. 'global' is implicit. */
  setBaseScopes(scopes: readonly ScopeId[], opts?: { mode?: ModeBadge; terminal?: boolean }): void;
  /** Pushes a layer (overlay, input, sticky mode). Returns the function that removes it. */
  pushScope(layer: ScopeLayer): () => void;
  /** `+` prefix (§4.1). */
  setPrefix(prefix: "right" | "down" | null): void;
  /** Drops a pending sequence and prefix (window blur, Esc). */
  reset(): void;
  setEnv(env: Partial<EngineEnv>): void;
  env(): EngineEnv;
  /** Built, applicable actions in the active scopes, in declaration order. */
  available(): AvailableAction[];
  /** available() filtered to hint-row entries, by hint priority. */
  hints(): AvailableAction[];
  /** After the leader: the actions the next key can run (which-key panel). */
  continuations(): { chord: Chord; action: ActionDef }[];
  /** Bindings of an action for chips, on the engine's platform (leader expanded, alias rows included). */
  bindingsFor(id: ActionId): Binding[];
  /** Call when state read by `when`/`enabled` predicates changed, so hints refresh. */
  invalidate(): void;
  snapshot(): EngineSnapshot;
  /** Fires on any change of snapshot(), available() or bindings. */
  subscribe(fn: () => void): () => void;
  on(fn: (e: EngineEvent) => void): () => void;
  readonly platform: Platform;
}

export function createEngine(opts: EngineOptions): Engine {
  const { registry, keymap, platform } = opts;
  const timeout = opts.sequenceTimeout ?? 1000;
  const now = opts.now ?? (() => Date.now());
  const osChords = new Set<string>(OS_CHORDS[platform]);

  let baseScopes: readonly ScopeId[] = [];
  let baseMode: ModeBadge = "NORMAL";
  let baseTerminal = false;
  const layers: ScopeLayer[] = [];
  let prefix: "right" | "down" | null = null;
  let pending: Chord[] = [];
  let pendingLeader = false;
  let pendingSince = 0;
  let pendingExact: KeyEntry | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let env: EngineEnv = { readOnly: false, singleKeys: true };

  const subs = new Set<() => void>();
  const listeners = new Set<(e: EngineEvent) => void>();
  let snap: EngineSnapshot | null = null;
  let chainCache: { segments: Segment[]; rank: Map<ScopeId, number>; chordsOnly: Set<ScopeId>; esc: Set<ScopeId> } | null = null;

  const notify = () => {
    snap = null;
    for (const fn of subs) fn();
  };
  const emit = (e: EngineEvent) => {
    for (const fn of listeners) fn(e);
  };
  const scopesChanged = () => {
    chainCache = null;
    notify();
  };
  registry.subscribe(notify);
  keymap.subscribe(notify);

  function chain() {
    if (chainCache) return chainCache;
    const segments: Segment[] = [];
    let chordsOnly = false;
    let esc = false;
    let globalOnly = false;
    let open = true;
    const all = prefix ? [...layers, PREFIX_LAYER] : layers;
    for (let i = all.length - 1; i >= 0 && open; i--) {
      segments.push({ scopes: all[i].scopes, chordsOnly, esc, globalOnly });
      const below = all[i].below;
      if (below === "none") open = false;
      else if (below === "chords" || below === "global-chords") {
        chordsOnly = true;
        esc = false;
        if (below === "global-chords") globalOnly = true;
      } else if (below === "chords+esc") {
        // a stricter layer above keeps its rule
        esc = chordsOnly ? esc : true;
        chordsOnly = true;
      }
    }
    if (open) segments.push({ scopes: [...baseScopes, "global"], chordsOnly, esc, globalOnly });
    const rank = new Map<ScopeId, number>();
    const co = new Set<ScopeId>();
    const eo = new Set<ScopeId>();
    let r = 0;
    for (const seg of segments) {
      for (const s of seg.scopes) {
        if (seg.globalOnly && s !== "global") continue;
        if (!rank.has(s)) {
          rank.set(s, r++);
          if (seg.chordsOnly) co.add(s);
          if (seg.esc) eo.add(s);
        }
      }
    }
    return (chainCache = { segments, rank, chordsOnly: co, esc: eo });
  }

  /** Rank of an entry in the active chain, or -1 when it is not live. */
  function rankOf(e: { row: ActionDef; seq?: Binding }): number {
    const c = chain();
    let best = -1;
    for (const s of e.row.scopes) {
      const r = c.rank.get(s);
      if (r === undefined) continue;
      if (c.chordsOnly.has(s) && e.seq && !isCommandChord(e.seq[0]) && !(e.seq[0] === "Esc" && c.esc.has(s))) continue;
      if (best < 0 || r < best) best = r;
    }
    return best;
  }

  const terminalActive = () => {
    const top = layers[layers.length - 1];
    if (prefix) return false;
    return top ? top.terminal === true : baseTerminal;
  };

  function termKeeps(chord: Chord): boolean {
    if (keymap.leaders(platform).includes(chord)) return true;
    if (platform === "mac" ? parseChord(chord)?.cmd || TERM_KEEPS_MAC.test(chord) : TERM_KEEPS_WIN.test(chord)) return true;
    // the terminal scope's own command chords (terminal.copy, paste ...) stay with the app, also when rebound
    const top = chain().segments[0];
    return keymap.lookup(chord, platform).some(
      (e) => isCommandChord(chord) && e.row.scopes.some((s) => s !== "global" && top.scopes.includes(s)),
    );
  }

  function makeCtx(action: ActionDef, source: ActionSource, stroke?: Stroke, info?: StrokeInfo): ActionContext {
    const chord = stroke?.chord;
    const digit = chord ? /(?:^|\+)([0-9])$/.exec(chord)?.[1] : undefined;
    return {
      id: action.id,
      source,
      newPane: null,
      chord,
      digit: digit === undefined ? undefined : Number(digit),
      args: [],
      repeat: info?.repeat ?? false,
      event: info?.event,
    };
  }

  function disabledReason(action: ActionDef, h: ActionHandler, ctx: ActionContext): string | null {
    if (action.write && env.readOnly) return "read-only mode";
    const r = h.enabled ? h.enabled(ctx) : true;
    if (r === true) return null;
    return typeof r === "string" ? r : "not available";
  }

  function clearPending() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.length === 0 && !pendingExact) return;
    pending = [];
    pendingLeader = false;
    pendingExact = null;
    notify();
  }

  function setPrefix(next: "right" | "down" | null) {
    if (prefix === next) return;
    prefix = next;
    scopesChanged();
  }

  /** Runs an action that was resolved from a key or requested by code. */
  function execute(action: ActionDef, h: ActionHandler, ctx: ActionContext): boolean {
    if (prefix && action.id !== PREFIX_RIGHT && action.id !== PREFIX_DOWN) {
      if (action.opens !== "view") {
        // §4.1: a key that does not open a view cancels the prefix and is not executed
        const key = ctx.chord ? chordLabels(ctx.chord, platform).join("+") : action.id;
        setPrefix(null);
        emit({ type: "message", text: `+ ${key}: ${action.label} does not open a view` });
        return false;
      }
      ctx.newPane = prefix;
      setPrefix(null);
    }
    const reason = disabledReason(action, h, ctx);
    if (reason) {
      emit({ type: "blocked", id: action.id, reason });
      return false;
    }
    try {
      const r = h.run(ctx);
      if (r && typeof r.then === "function") r.then(undefined, (error: unknown) => emit({ type: "error", id: action.id, error }));
    } catch (error) {
      emit({ type: "error", id: action.id, error });
      return false;
    }
    emit({ type: "run", id: action.id, source: ctx.source });
    return true;
  }

  /** Live, built entries for a sequence prefix, best rank first. */
  function candidates(seq: readonly Chord[], fresh: boolean): { e: KeyEntry; rank: number }[] {
    const out: { e: KeyEntry; rank: number }[] = [];
    for (const e of keymap.lookup(seq[0], platform)) {
      if (e.seq.length < seq.length || !e.action.built) continue;
      let ok = true;
      for (let i = 1; i < seq.length; i++) if (e.seq[i] !== seq[i]) ok = false;
      if (!ok) continue;
      if (fresh && !env.singleKeys && isSingleKey(e.seq[0])) continue;
      const rank = rankOf(e);
      if (rank >= 0) out.push({ e, rank });
    }
    out.sort((x, y) => x.rank - y.rank || x.e.action.order - y.e.action.order);
    return out;
  }

  /** First exact candidate whose `when` holds. */
  function pickExact(list: { e: KeyEntry }[], len: number, stroke: Stroke, info: StrokeInfo): { e: KeyEntry; h: ActionHandler; ctx: ActionContext } | null {
    for (const { e } of list) {
      if (e.seq.length !== len) continue;
      const h = registry.handler(e.action.id);
      if (!h) continue;
      const ctx = makeCtx(e.action, "key", stroke, info);
      if (h.when && !h.when(ctx)) continue;
      return { e, h, ctx };
    }
    return null;
  }

  function fire(hit: { e: KeyEntry; h: ActionHandler; ctx: ActionContext }, info: StrokeInfo): HandleResult {
    // auto-repeat only reaches actions that asked for it; the key is still ours
    if (info.repeat && !hit.e.action.repeat) return "consumed";
    execute(hit.e.action, hit.h, hit.ctx);
    return "consumed";
  }

  function startPending(seq: Chord[], leader: boolean, exact: KeyEntry | null) {
    if (pending.length === 0) pendingSince = now();
    pending = seq;
    pendingLeader = leader;
    pendingExact = exact;
    if (timer) clearTimeout(timer);
    timer = null;
    // the leader has no timeout (§4.1)
    if (!leader) {
      timer = setTimeout(() => {
        timer = null;
        const e = pendingExact;
        clearPending();
        if (e) {
          const h = registry.handler(e.action.id);
          if (h) execute(e.action, h, makeCtx(e.action, "key"));
        }
      }, timeout);
    }
    notify();
  }

  function handle(stroke: Stroke, info: StrokeInfo = {}): HandleResult {
    if (osChords.has(stroke.chord)) return "pass";

    // 1. a sequence is in progress
    if (pending.length > 0) {
      if (info.repeat) return "consumed";
      if (stroke.chord === "Esc") {
        clearPending();
        return "consumed";
      }
      const wasLeader = pendingLeader;
      // rule 11: after the leader, Ctrl and Cmd are ignored on the next key
      const tries = wasLeader && stroke.bare !== stroke.chord ? [stroke.chord, stroke.bare] : [stroke.chord];
      for (const chord of tries) {
        const seq = [...pending, chord];
        const list = candidates(seq, false);
        if (list.length === 0) continue;
        const exact = pickExact(list, seq.length, stroke, info);
        const longer = list.some((c) => c.e.seq.length > seq.length);
        if (longer) {
          startPending(seq, wasLeader, exact?.e ?? null);
          return "consumed";
        }
        clearPending();
        if (exact) return fire(exact, info);
        return "consumed";
      }
      clearPending();
      // the key after the leader is consumed in every scope, including TERM
      if (wasLeader) return "consumed";
      // otherwise the stroke starts over as a fresh key
    }

    // 2. the `+` prefix: Esc cancels (§4.2 step 1)
    if (prefix && stroke.chord === "Esc") {
      setPrefix(null);
      return "consumed";
    }

    // 3. who owns a fresh key
    // a sticky mode (MOVE, RESIZE, COPY) takes every key, wherever the focus is
    const capture = !prefix && layers[layers.length - 1]?.capture === true;
    if (capture) {
      /* no passthrough */
    } else if (terminalActive()) {
      if (stroke.typing || !termKeeps(stroke.chord)) return "pass";
    } else if (info.editable) {
      if (stroke.typing || INPUT_OWNED[platform].has(stroke.chord)) return "pass";
    }

    const seq = [stroke.chord];
    let list = candidates(seq, true);
    if (capture) {
      const hit = pickExact(list, 1, stroke, info);
      return hit ? fire(hit, info) : "consumed";
    }
    if (info.editable && INPUT_SOFT.has(stroke.chord)) {
      // only a pushed layer (the one that owns the input) may claim them, never the pane under it
      const top = layers[layers.length - 1];
      list = top ? list.filter((c) => c.e.row.scopes.some((s) => top.scopes.includes(s))) : [];
    }
    if (list.length === 0) {
      if (prefix && !stroke.altGr && isSingleKey(stroke.chord)) {
        // a plain key with no action still cancels the prefix
        setPrefix(null);
        return "consumed";
      }
      return "pass";
    }
    const exact = pickExact(list, 1, stroke, info);
    const longer = list.some((c) => c.e.seq.length > 1);
    if (longer) {
      if (info.repeat) return "consumed";
      startPending(seq, keymap.leaders(platform).includes(stroke.chord), exact?.e ?? null);
      return "consumed";
    }
    if (exact) return fire(exact, info);
    // every candidate declined (`when` was false): the key is not ours
    return "pass";
  }

  function run(id: ActionId, o: { source?: ActionSource; newPane?: "right" | "down" | null; args?: readonly string[] } = {}): boolean {
    const action = registry.target(id);
    const h = action && registry.handler(action.id);
    if (!action || !h) return false;
    const ctx: ActionContext = { ...makeCtx(action, o.source ?? "api"), newPane: o.newPane ?? null, args: o.args ?? [] };
    if (h.when && !h.when(ctx)) return false;
    return execute(action, h, ctx);
  }

  function available(): AvailableAction[] {
    const live = new Map<ActionDef, Binding[]>();
    for (const e of keymap.entries(platform)) {
      if (!e.action.built || rankOf(e) < 0) continue;
      if (!env.singleKeys && isSingleKey(e.seq[0])) continue;
      const l = live.get(e.action);
      if (l) l.push(e.seq);
      else live.set(e.action, [e.seq]);
    }
    const out: AvailableAction[] = [];
    for (const action of registry.list()) {
      if (action.alias || !action.built) continue;
      const bindings = live.get(action);
      // command-only actions are live through their scope alone
      if (!bindings && rankOf({ row: action }) < 0) continue;
      const h = registry.handler(action.id);
      if (!h) continue;
      const ctx = makeCtx(action, "api");
      if (h.when && !h.when(ctx)) continue;
      const reason = disabledReason(action, h, ctx);
      out.push({ action, bindings: bindings ?? [], enabled: reason === null, reason: reason ?? undefined });
    }
    return out;
  }

  return {
    platform,
    handle,
    run,
    setBaseScopes(scopes, o = {}) {
      baseScopes = scopes;
      baseMode = o.mode ?? "NORMAL";
      baseTerminal = o.terminal ?? o.mode === "TERM";
      scopesChanged();
    },
    pushScope(layer) {
      layers.push(layer);
      scopesChanged();
      return () => {
        const i = layers.lastIndexOf(layer);
        if (i >= 0) {
          layers.splice(i, 1);
          scopesChanged();
        }
      };
    },
    setPrefix,
    reset() {
      clearPending();
      setPrefix(null);
    },
    setEnv(next) {
      env = { ...env, ...next };
      notify();
    },
    env: () => env,
    available,
    hints() {
      return available()
        .filter((a) => a.action.hint !== null && a.enabled && a.bindings.length > 0)
        .sort((x, y) => (x.action.hint ?? 0) - (y.action.hint ?? 0) || x.action.order - y.action.order);
    },
    continuations() {
      if (pending.length === 0) return [];
      const out: { chord: Chord; action: ActionDef }[] = [];
      const seen = new Set<string>();
      for (const { e } of candidates(pending, false)) {
        const chord = e.seq[pending.length];
        if (chord === undefined) continue;
        const k = `${chord}|${e.action.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ chord, action: e.action });
      }
      return out;
    },
    bindingsFor: (id) => keymap.display(id, platform),
    invalidate: notify,
    snapshot() {
      if (snap) return snap;
      const layerMode = () => {
        for (let i = layers.length - 1; i >= 0; i--) if (layers[i].mode) return layers[i].mode;
        return undefined;
      };
      const mode: ModeBadge =
        pending.length > 0 && pendingLeader ? "PANE"
        : prefix === "right" ? "NEW →"
        : prefix === "down" ? "NEW ↓"
        : (layerMode() ?? (layers.length > 0 ? "NORMAL" : baseMode));
      return (snap = {
        mode,
        pending,
        leader: pendingLeader,
        pendingSince,
        prefix,
        scopes: [...chain().rank.keys()],
      });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
