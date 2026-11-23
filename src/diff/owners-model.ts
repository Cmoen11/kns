// Field owners on YAML lines: which line a JSON pointer is on, the letter per line, and the lines
// drift-only keeps. Pure (no CodeMirror, no backend), unit-tested. Lazy: used by the gutter in
// src/views/doc/ownership.ts (it pulls the YAML library, which the doc chunk has anyway).
import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument, type Node } from "yaml";
import type { FieldOwner, ManagerClass } from "../ipc/types";

/** 1-based first and last line of a node in the text. */
export interface LineRange {
  start: number;
  end: number;
}

const esc = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Every node of a YAML document by JSON pointer: the line its key (or list dash) is on and the last
 * line of its value. The root is `""`. Text that does not parse gives an empty map.
 */
export function pointerLines(text: string): Map<string, LineRange> {
  const out = new Map<string, LineRange>();
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false });
  if (doc.errors.length > 0 || !doc.contents) return out;
  const line = (offset: number) => lc.linePos(Math.max(0, offset)).line;
  const endLine = (n: Node | null | undefined, fallback: number) => {
    const r = n?.range;
    if (!r) return fallback;
    // the value's end offset points past its last character (often the newline)
    return Math.max(fallback, line(Math.max(r[0], r[1] - 1)));
  };
  const walk = (node: Node | null | undefined, ptr: string) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const key = isScalar(pair.key) ? String(pair.key.value) : null;
        if (key === null) continue;
        const keyNode = pair.key as Node;
        const start = keyNode.range ? line(keyNode.range[0]) : 1;
        const value = pair.value as Node | null;
        const p = `${ptr}/${esc(key)}`;
        out.set(p, { start, end: endLine(value, start) });
        walk(value, p);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const n = item as Node;
        const start = n?.range ? line(n.range[0]) : 1;
        const p = `${ptr}/${i}`;
        out.set(p, { start, end: endLine(n, start) });
        walk(n, p);
      });
    }
  };
  const root = doc.contents as Node;
  out.set("", { start: 1, end: endLine(root, 1) });
  walk(root, "");
  return out;
}

export const LETTER: Record<ManagerClass, string> = { flux: "F", kns: "K", kubectl: "k", controller: "C", other: "o" };
export const CLASS_WORD: Record<ManagerClass, string> = { flux: "Flux", kns: "kns", kubectl: "kubectl", controller: "controller", other: "other" };

/** Which manager's letter a line with several owners shows: a human's change first. */
const RANK: Record<ManagerClass, number> = { kubectl: 0, kns: 1, other: 2, controller: 3, flux: 4 };

/** A human's change, as opposed to Flux or a controller. */
export const isHuman = (o: FieldOwner): boolean => o.managerClass === "kubectl" || o.managerClass === "kns" || o.managerClass === "other";

export interface LineOwners {
  /** 1-based line */
  line: number;
  letter: string;
  managerClass: ManagerClass;
  owners: FieldOwner[];
}

/** One entry per line that has an owner, sorted by line. Pointers the text does not show (status hidden, a stale path) are dropped. */
export function ownersByLine(owners: readonly FieldOwner[], lines: Map<string, LineRange>): LineOwners[] {
  const by = new Map<number, FieldOwner[]>();
  for (const o of owners) {
    const r = lines.get(o.path);
    if (!r) continue;
    const list = by.get(r.start) ?? [];
    if (!list.some((x) => x.manager === o.manager && x.path === o.path)) list.push(o);
    by.set(r.start, list);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, list]) => {
      const top = [...list].sort((a, b) => RANK[a.managerClass] - RANK[b.managerClass])[0];
      return { line, letter: LETTER[top.managerClass], managerClass: top.managerClass, owners: list };
    });
}

export const isFluxManaged = (owners: readonly FieldOwner[]): boolean => owners.some((o) => o.managerClass === "flux");

const underStatus = (p: string) => p === "/status" || p.startsWith("/status/");

/**
 * Drift: fields of a Flux-managed object that a human manager (kubectl, kns, other) set and Flux
 * does not own. Status and controller-owned fields are not drift.
 */
export function driftPaths(owners: readonly FieldOwner[]): string[] {
  const flux = new Set(owners.filter((o) => o.managerClass === "flux").map((o) => o.path));
  const out = new Set<string>();
  for (const o of owners) {
    if (!isHuman(o) || o.subresource === "status" || underStatus(o.path) || flux.has(o.path)) continue;
    out.add(o.path);
  }
  return [...out].sort();
}

/** Always kept in drift-only, so the reader knows which object this is. */
const HEAD = ["/apiVersion", "/kind", "/metadata", "/metadata/name", "/metadata/namespace"];

const ancestors = (p: string): string[] => {
  const out: string[] = [];
  let i = p.lastIndexOf("/");
  while (i > 0) {
    out.push(p.slice(0, i));
    i = p.lastIndexOf("/", i - 1);
  }
  return out;
};

/**
 * The line ranges drift-only hides (1-based, inclusive): everything except the drift fields (whole
 * value), the keys above them, and the object's name lines.
 */
export function driftHidden(drift: readonly string[], lines: Map<string, LineRange>, totalLines: number): LineRange[] {
  const keep = new Set<number>();
  const keepRange = (r: LineRange | undefined, whole: boolean) => {
    if (!r) return;
    if (!whole) return void keep.add(r.start);
    for (let l = r.start; l <= r.end; l++) keep.add(l);
  };
  for (const p of HEAD) keepRange(lines.get(p), false);
  for (const p of drift) {
    keepRange(lines.get(p), true);
    for (const a of ancestors(p)) keepRange(lines.get(a), false);
  }
  const hidden: LineRange[] = [];
  let from = 0;
  for (let l = 1; l <= totalLines; l++) {
    if (!keep.has(l)) {
      if (from === 0) from = l;
    } else if (from) {
      hidden.push({ start: from, end: l - 1 });
      from = 0;
    }
  }
  if (from) hidden.push({ start: from, end: totalLines });
  return hidden;
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Hover text for a line: every manager, its kind, operation and age ("kubectl-scale · kubectl · Update scale · 1h ago"). */
export function ownersTip(entry: LineOwners, now: number): string {
  // one entry per manager: a list item and its first key (or a flow map's keys) share a line
  const seen = new Set<string>();
  return entry.owners
    .filter((o) => {
      const k = `${o.manager}|${o.operation}|${o.subresource ?? ""}`;
      return !seen.has(k) && !!seen.add(k);
    })
    .map((o) => [o.manager, CLASS_WORD[o.managerClass], [o.operation, o.subresource].filter(Boolean).join(" "), ago(o.time, now)].filter(Boolean).join(" · "))
    .join("; ");
}
