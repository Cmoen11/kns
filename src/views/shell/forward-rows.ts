// The Port-forwards rows of the activity panel (docs/plan-features.md §2.9): one row per forward,
// grouped under a header row per dev set (name, forward count, `x` = stop the set). Pure; the
// panel passes what the keys do.
import type { Forward } from "../../ipc/types";
import type { PanelRow } from "../../sidepanels/model";
import type { GlyphState } from "../../ui";
import { forwardHost, ownerText, remoteText, targetText } from "./ports";

export interface ForwardRowOptions {
  /** the window's context: forwards of other contexts name theirs */
  here: string;
  /** dev set id -> name */
  devSetNames: Readonly<Record<string, string>>;
  /** when the window first saw a forward */
  since: (f: Forward) => number | undefined;
  activate: (f: Forward) => unknown;
  stop: (f: Forward) => unknown;
  copy: (f: Forward) => unknown;
  open: (f: Forward) => unknown;
  /** the dev-set header: Enter / x */
  openSet: (id: string) => unknown;
  stopSet: (id: string, name: string) => unknown;
}

const glyphOf = (f: Forward): GlyphState => (f.status === "error" ? "error" : f.status === "waiting" ? "progress" : "ok");

/** One forward. */
export function forwardRow(f: Forward, o: ForwardRowOptions): PanelRow {
  const facts = [`${forwardHost(f)} -> ${remoteText(f)}`, `${f.connections} conn`, f.namespace];
  if (f.owner.by === "agent" || f.requestedBy) facts.push(ownerText(f));
  if (f.context !== o.here) facts.push(f.context);
  const detail =
    f.status === "error" ? `error${f.message ? `: ${f.message}` : ""}`
    : f.status === "waiting" ? `waiting${f.message ? `: ${f.message}` : ""} · ${facts.join(" · ")}`
    : facts.join(" · ");
  return {
    key: `pf:${f.id}`,
    section: "forwards",
    label: `${f.label ? `${f.label} · ` : ""}${targetText(f)}:${remoteText(f)}`,
    detail,
    since: o.since(f),
    glyph: glyphOf(f),
    activate: () => o.activate(f),
    stop: () => o.stop(f),
    copy: () => o.copy(f),
    open: () => o.open(f),
  };
}

/** Forwards without a set first, then one header per dev set followed by its forwards. */
export function forwardPanelRows(list: readonly Forward[], o: ForwardRowOptions): PanelRow[] {
  const loose = list.filter((f) => f.devSet === undefined);
  const sets = new Map<string, Forward[]>();
  for (const f of list) if (f.devSet !== undefined) sets.set(f.devSet, [...(sets.get(f.devSet) ?? []), f]);
  const rows = loose.map((f) => forwardRow(f, o));
  for (const [id, fs] of sets) {
    const name = o.devSetNames[id] ?? id;
    const bad = fs.some((f) => f.status === "error");
    const waiting = fs.some((f) => f.status === "waiting");
    rows.push({
      key: `pfset:${id}`,
      section: "forwards",
      label: `dev set ${name}`,
      detail: `${fs.length} forward${fs.length === 1 ? "" : "s"}${waiting ? " · waiting" : ""} · x stops the set`,
      glyph: bad ? "error" : waiting ? "progress" : "ok",
      activate: () => o.openSet(id),
      stop: () => o.stopSet(id, name),
    });
    rows.push(...fs.map((f) => forwardRow(f, o)));
  }
  return rows;
}
