// Effective keymap: defaults < k9s-mode preset < user overrides (docs/ux.md §5.4, §5.7),
// with 'leader' expanded and a first-chord index for the dispatcher.
import { INTENTIONAL_SHARED, K9S_PRESET, OS_CHORDS, RESERVED_CHORDS } from "../actions/keymap-data";
import type { ActionDef, ActionId, Registry } from "../actions/registry";
import { knownSegments, type ScopeId } from "../actions/scopes";
import type { Binding, Chord, KeymapOverride } from "../types";
import { bindingKey, canonicalBinding, LEADER, parseBindings, type Platform } from "./chord";

export const LEADER_ACTION: ActionId = "pane.leader";

/** One reachable key sequence of one action row. */
export interface KeyEntry {
  /** the row that declares the binding (its scopes apply) */
  row: ActionDef;
  /** the action that runs (row.alias resolved) */
  action: ActionDef;
  /** leader expanded, canonical chords */
  seq: Binding;
  /** true when the binding was written with 'leader' */
  leader: boolean;
}

export interface Keymap {
  /** Effective bindings of one row as declared ('leader' not expanded). */
  bindings(id: string, platform: Platform): Binding[];
  /**
   * Effective bindings for display: the action's own plus those of its alias rows, 'leader'
   * expanded. This is what key chips show.
   */
  display(id: string, platform: Platform): Binding[];
  /** The leader chords (bindings of pane.leader). */
  leaders(platform: Platform): Chord[];
  /** Entries whose sequence starts with `chord`. */
  lookup(chord: Chord, platform: Platform): readonly KeyEntry[];
  entries(platform: Platform): readonly KeyEntry[];
  /** Replaces the user overrides. Invalid chords and unknown ids are dropped. */
  setOverrides(overrides: Record<string, KeymapOverride>): void;
  overrides(): Record<string, KeymapOverride>;
  setK9sMode(on: boolean): void;
  version(): number;
  subscribe(fn: () => void): () => void;
}

/** Drops unknown action ids and unparsable bindings from persisted overrides. */
export function sanitizeOverrides(raw: unknown, registry: Registry): Record<string, KeymapOverride> {
  const out: Record<string, KeymapOverride> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!registry.get(id) || !value || typeof value !== "object") continue;
    const o: KeymapOverride = {};
    for (const p of ["win", "mac"] as const) {
      const list = (value as Record<string, unknown>)[p];
      if (!Array.isArray(list)) continue;
      const clean: Binding[] = [];
      for (const b of list) {
        if (!Array.isArray(b) || !b.every((c) => typeof c === "string")) continue;
        const c = canonicalBinding(b as string[]);
        // 'leader' is a prefix: valid first, and after itself ('leader leader')
        if (c && (c[0] === LEADER || !c.includes(LEADER))) clean.push(c);
      }
      o[p] = clean;
    }
    if (o.win || o.mac) out[id] = o;
  }
  return out;
}

export function createKeymap(registry: Registry): Keymap {
  let overrides: Record<string, KeymapOverride> = {};
  let k9s = false;
  let version = 0;
  const subs = new Set<() => void>();
  const cache: Partial<Record<Platform, { entries: KeyEntry[]; index: Map<Chord, KeyEntry[]> }>> = {};

  const k9sPreset = (id: string, platform: Platform): Binding[] | undefined => {
    const spec = (K9S_PRESET as Record<string, { win?: string; mac?: string } | undefined>)[id]?.[platform];
    return spec === undefined ? undefined : parseBindings(spec, platform);
  };

  function bindings(id: string, platform: Platform): Binding[] {
    const def = registry.get(id);
    if (!def) return [];
    return overrides[id]?.[platform] ?? (k9s ? k9sPreset(id, platform) : undefined) ?? def[platform];
  }

  function leaders(platform: Platform): Chord[] {
    return bindings(LEADER_ACTION, platform).filter((b) => b.length === 1).map((b) => b[0]);
  }

  function expand(b: Binding, platform: Platform): Binding[] {
    if (b[0] !== LEADER) return [b];
    const ls = leaders(platform);
    const rest = b.slice(1);
    const out: Binding[] = [];
    for (const l of ls) {
      // 'leader leader' means the leader chord twice
      out.push([l, ...rest.map((c) => (c === LEADER ? l : c))]);
    }
    return out;
  }

  function build(platform: Platform) {
    const entries: KeyEntry[] = [];
    const index = new Map<Chord, KeyEntry[]>();
    for (const row of registry.list()) {
      // the leader chord is a prefix, not a binding that runs
      if (row.id === LEADER_ACTION) continue;
      const action = registry.target(row.id) ?? row;
      for (const b of bindings(row.id, platform)) {
        for (const seq of expand(b, platform)) {
          const e: KeyEntry = { row, action, seq, leader: b[0] === LEADER };
          entries.push(e);
          const list = index.get(seq[0]);
          if (list) list.push(e);
          else index.set(seq[0], [e]);
        }
      }
    }
    return { entries, index };
  }
  const get = (platform: Platform) => (cache[platform] ??= build(platform));

  function invalidate() {
    version++;
    cache.win = undefined;
    cache.mac = undefined;
    for (const fn of subs) fn();
  }

  return {
    bindings,
    display(id, platform) {
      const out: Binding[] = [];
      const seen = new Set<string>();
      for (const row of registry.list()) {
        if (row.id !== id && row.alias !== id) continue;
        for (const b of bindings(row.id, platform)) {
          for (const seq of expand(b, platform)) {
            const k = bindingKey(seq);
            if (!seen.has(k)) {
              seen.add(k);
              out.push(seq);
            }
          }
        }
      }
      return out;
    },
    leaders,
    lookup: (chord, platform) => get(platform).index.get(chord) ?? [],
    entries: (platform) => get(platform).entries,
    setOverrides(next) {
      overrides = sanitizeOverrides(next, registry);
      invalidate();
    },
    overrides: () => overrides,
    setK9sMode(on) {
      if (k9s === on) return;
      k9s = on;
      invalidate();
    },
    version: () => version,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export interface Conflict {
  a: ActionId;
  b: ActionId;
  /** the shorter (or equal) sequence */
  seq: Binding;
  /** 'equal' or 'prefix' (seq is a strict prefix of the other binding) */
  kind: "equal" | "prefix";
  /** the scopes of the segment in which both are live */
  segment: readonly ScopeId[];
}

const sharedGroup = new Map<string, number>();
INTENTIONAL_SHARED.forEach((group, i) => group.forEach((id) => sharedGroup.set(id, i)));
const intentional = (a: string, b: string) => sharedGroup.has(a) && sharedGroup.get(a) === sharedGroup.get(b);

function isPrefix(a: Binding, b: Binding): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Finds bindings that are equal to, or a prefix of, another action's binding while both are live
 * in the same scope segment (§5.4 "Conflicts"). A layer shadowing the layers below it is by
 * design and not reported; neither are the groups in INTENTIONAL_SHARED.
 * `entries` defaults to the whole effective keymap; pass a candidate list to check an edit.
 */
export function findConflicts(
  keymap: Keymap,
  platform: Platform,
  segments: readonly (readonly ScopeId[])[] = knownSegments(),
  entries: readonly KeyEntry[] = keymap.entries(platform),
): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const scopes = new Set<ScopeId>(segment);
    const live = entries.filter((e) => e.row.scopes.some((s) => scopes.has(s)));
    const byFirst = new Map<Chord, KeyEntry[]>();
    for (const e of live) {
      const l = byFirst.get(e.seq[0]);
      if (l) l.push(e);
      else byFirst.set(e.seq[0], [e]);
    }
    for (const group of byFirst.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const x = group[i];
          const y = group[j];
          if (x.action.id === y.action.id || intentional(x.action.id, y.action.id)) continue;
          const [short, long] = x.seq.length <= y.seq.length ? [x, y] : [y, x];
          if (!isPrefix(short.seq, long.seq)) continue;
          const key = `${short.action.id}|${long.action.id}|${bindingKey(short.seq)}|${bindingKey(long.seq)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            a: short.action.id,
            b: long.action.id,
            seq: short.seq,
            kind: short.seq.length === long.seq.length ? "equal" : "prefix",
            segment,
          });
        }
      }
    }
  }
  return out;
}

/**
 * For the keymap editor: the actions a new binding for `id` would collide with on `platform`.
 * The binding is canonical and may start with 'leader'.
 */
export function conflictsFor(keymap: Keymap, registry: Registry, id: string, binding: Binding, platform: Platform): Conflict[] {
  const row = registry.get(id);
  if (!row) return [];
  const action = registry.target(id) ?? row;
  const leaders = keymap.leaders(platform);
  const seqs = binding[0] === LEADER ? leaders.map((l) => [l, ...binding.slice(1)]) : [binding];
  const others = keymap.entries(platform).filter((e) => e.action.id !== action.id);
  const mine: KeyEntry[] = seqs.map((seq) => ({ row, action, seq, leader: binding[0] === LEADER }));
  return findConflicts(keymap, platform, knownSegments(), [...others, ...mine]).filter(
    (c) => c.a === action.id || c.b === action.id,
  );
}

/** True when the chord may be assigned to an action (§5.4 "Reserved"). */
export function isAssignable(chord: Chord, platform: Platform): boolean {
  return !(RESERVED_CHORDS as readonly string[]).includes(chord) && !(OS_CHORDS[platform] as readonly string[]).includes(chord);
}

/** Actions whose bindings are fixed: Esc-bound actions, dialog Enter and the OS chords. */
export function isRebindable(def: ActionDef): boolean {
  if (def.id === "dialog.confirm" || def.id === "app.quit") return false;
  return !def.win.some((b) => b.length === 1 && b[0] === "Esc" && def.win.length === 1);
}
