// The state of one logs pane, outside React (docs/ux.md §13.3): the ring buffer, the visible
// rows (all lines, or the filtered ones), search hits, follow / pause, the line cursor and the
// selection. Appends are queued and applied once per animation frame; React reads a version
// counter and indexes into this object, so no line ever lives in React state.
import type { LogLevel } from "../../ipc/types";
import { parseAnsi, type AnsiSpan } from "./ansi";
import { Heights } from "./heights";
import type { LevelHit } from "./level";
import { compileMatcher, sameQuery, type Matcher, type Query } from "./match";
import { Ring, SeqList } from "./ring";
import { EXPAND_MAX_UNITS, unitsFor, WRAP_MAX_UNITS } from "./segments";
import { chipPredicate, displayLine, expandedUnits, isParsed, sameFilter, type FieldFilter } from "./structured";
import { gutterMode, gutterWidth, markerFor, sourceKey, type GutterMode } from "./targets";
import { formatClock } from "./time";

export const LINE = 0;
/** user mark (`m`): a rule with a timestamp */
export const MARK = 1;
/** lines may be missing here (reattach, retarget) */
export const GAP = 2;
/** a stream ended, a pod went away */
export const NOTE = 3;
/** a stream failed */
export const ERROR = 4;
export type EntryKind = typeof LINE | typeof MARK | typeof GAP | typeof NOTE | typeof ERROR;

export interface Entry {
  seq: number;
  kind: EntryKind;
  /** epoch ms: the kubelet timestamp of a line, or when a marker was added */
  ms: number;
  /** index into `sources`; -1 for markers */
  src: number;
  text: string;
  spans: AnsiSpan[] | null;
  /** computed on first render; undefined = not looked at yet */
  level?: LevelHit | null;
  /** from the backend's parser (structured mode, level chips, patterns) */
  plevel?: LogLevel;
  msg?: string;
  fields?: [string, string][];
}

export interface SourceInfo {
  key: string;
  namespace: string;
  pod: string;
  container: string;
  /** stable per pod, in first-seen order */
  marker: string;
  /** the pod's first-seen index (gutter colour) */
  podIndex: number;
}

export interface LineIn {
  ms: number;
  text: string;
  level?: LogLevel;
  msg?: string;
  fields?: [string, string][];
}

export type Phase = "idle" | "resolving" | "streaming" | "empty" | "error";
export interface StreamStatus {
  phase: Phase;
  message?: string;
}

export interface ScrollCommand {
  seq: number;
  align: "auto" | "start" | "center";
}

type Queued = { kind: typeof LINE; src: number; lines: readonly LineIn[] } | { kind: Exclude<EntryKind, typeof LINE>; text: string; ms: number };

export type Schedule = (fn: () => void) => void;

/** Next animation frame; a timer covers a window that is hidden or minimized (no frames). */
const frameSchedule: Schedule = (fn) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, 250);
};

export interface SessionOptions {
  /** ring capacity in lines (settings.logBufferLines) */
  cap: number;
  schedule?: Schedule;
  /** called when state read by action `when` / `enabled` changes (hint row refresh) */
  onState?: () => void;
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

export class LogSession {
  readonly ring: Ring<Entry>;
  readonly heights = new Heights();
  /** line seqs that match the search, when it highlights */
  readonly hits = new SeqList();
  /** visible seqs while filtering; null = every entry is a row */
  private rows: SeqList | null = null;

  matcher: Matcher | null = null;
  filtering = false;
  /** structured mode (`J`): parsed lines show as LEVEL message fields */
  structured = false;
  /** field chips (`level>=warn`, `.traceId=abc`): lines must pass all of them */
  fieldFilters: readonly FieldFilter[] = [];
  private chips: ((e: Entry) => boolean) | null = null;
  /** lines ever appended (the patterns view re-mines when it moved) */
  linesIn = 0;

  follow = true;
  /** rows appended while paused */
  unread = 0;
  cursor: number | null = null;
  /** other end of the line selection */
  anchor: number | null = null;
  currentHit: number | null = null;
  readonly expanded = new Set<number>();

  sources: SourceInfo[] = [];
  private pods = new Map<string, { marker: string; index: number }>();
  private srcIndex = new Map<string, number>();
  /** what the pod/container gutter shows, and its width in characters (0 = no gutter) */
  gutterMode: GutterMode = "none";
  gutter = 0;

  /** lines dropped off the head since the last clear */
  droppedTotal = 0;
  /** head mode keeps the first lines: later ones are counted here once the buffer is full */
  headMode = false;
  skipped = 0;
  status: StreamStatus = { phase: "idle" };

  // search input
  searchOpen = false;
  focusTick = 0;
  draft: Query = { mode: "re", text: "" };
  private applied: Query | null = null;
  private appliedFilter = false;

  // layout, written by the view
  cols = 0;
  wrap = false;
  viewFirst = 0;
  viewLast = 0;
  pageRows = 1;

  private queue: Queued[] = [];
  private scheduled = false;
  private scroll: ScrollCommand | "bottom" | null = null;
  private pendingDropped = 0;
  private version = 0;
  private visible = true;
  private dirty = false;
  private subs = new Set<() => void>();
  private readonly schedule: Schedule;
  private readonly onState: () => void;

  constructor(opts: SessionOptions) {
    this.ring = new Ring<Entry>(opts.cap);
    this.schedule = opts.schedule ?? frameSchedule;
    this.onState = opts.onState ?? (() => {});
  }

  // ── subscription ──────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getVersion = (): number => this.version;

  /** Bumps the version: one React render. Held back while the pane is hidden. */
  touch(): void {
    this.version++;
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    for (const fn of [...this.subs]) fn();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible && this.dirty) {
      this.dirty = false;
      for (const fn of [...this.subs]) fn();
    }
  }

  // ── sources (pod / container gutter) ──────────────────────────────────────

  addSource(namespace: string, pod: string, container: string): number {
    const key = sourceKey({ namespace, pod, container });
    const known = this.srcIndex.get(key);
    if (known !== undefined) return known;
    const podKey = `${namespace}/${pod}`;
    let p = this.pods.get(podKey);
    if (!p) this.pods.set(podKey, (p = { marker: markerFor(this.pods.size), index: this.pods.size }));
    const index = this.sources.push({ key, namespace, pod, container, marker: p.marker, podIndex: p.index }) - 1;
    this.srcIndex.set(key, index);
    this.gutterMode = gutterMode(this.pods.size, this.sources.length);
    this.gutter = gutterWidth(this.gutterMode, this.sources);
    this.touch();
    return index;
  }

  // ── rows ──────────────────────────────────────────────────────────────────

  get rowCount(): number {
    return this.rows ? this.rows.length : this.ring.size;
  }
  seqAtRow(row: number): number {
    return this.rows ? this.rows.at(row) : this.ring.first + row;
  }
  entryAtRow(row: number): Entry | undefined {
    return row < 0 || row >= this.rowCount ? undefined : this.ring.get(this.seqAtRow(row));
  }
  /** The row of `seq`, or of the next visible entry after it; clamped. -1 when there are no rows. */
  rowOfSeq(seq: number): number {
    const n = this.rowCount;
    if (n === 0) return -1;
    return clamp(this.rows ? this.rows.lowerBound(seq) : seq - this.ring.first, 0, n - 1);
  }

  /** the line renders in structured form */
  isStructured(e: Entry): boolean {
    return this.structured && e.kind === LINE && isParsed(e);
  }

  private unitsOf(e: Entry): number {
    if (e.kind !== LINE) return 1;
    const open = this.expanded.has(e.seq);
    if (this.isStructured(e)) {
      if (open) return e.fields?.length ? Math.min(expandedUnits(e), EXPAND_MAX_UNITS) : unitsFor(displayLine(e).text.length, this.cols, EXPAND_MAX_UNITS);
      return this.wrap ? unitsFor(displayLine(e).text.length, this.cols, WRAP_MAX_UNITS) : 1;
    }
    if (!open && !this.wrap) return 1;
    return unitsFor(e.text.length, this.cols, open ? EXPAND_MAX_UNITS : WRAP_MAX_UNITS);
  }
  /** Rows are a subset of the buffer: a filter-lines search or a field chip. */
  get hiding(): boolean {
    return this.filtering || this.chips !== null;
  }

  /** `J`: structured on / off. Heights change, the viewport keeps its line. */
  setStructured(on: boolean): void {
    if (on === this.structured) return;
    const keep = this.keepSeq();
    this.structured = on;
    this.rebuildHeights();
    this.restore(keep);
    this.touch();
    this.onState();
  }

  /** Adds a field chip (a duplicate is ignored). */
  addFieldFilter(f: FieldFilter): void {
    if (this.fieldFilters.some((x) => sameFilter(x, f))) return;
    this.setFieldFilters([...this.fieldFilters, f]);
  }
  /** Removes the chip at `index`, or the last one. */
  removeFieldFilter(index = this.fieldFilters.length - 1): void {
    if (index < 0 || index >= this.fieldFilters.length) return;
    this.setFieldFilters(this.fieldFilters.filter((_, i) => i !== index));
  }
  setFieldFilters(filters: readonly FieldFilter[]): void {
    const keep = this.keepSeq();
    this.fieldFilters = filters;
    this.chips = chipPredicate(filters);
    this.reindex();
    this.restore(keep);
    this.touch();
    this.onState();
  }

  /** Visual lines a row may use (the cap that `unitsOf` applied). */
  maxUnits(seq: number): number {
    return this.expanded.has(seq) ? EXPAND_MAX_UNITS : WRAP_MAX_UNITS;
  }
  isWrapped(seq: number): boolean {
    return this.wrap || this.expanded.has(seq);
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  /** Queues lines of one source; they are applied in the next frame. */
  enqueue(src: number, lines: readonly LineIn[]): void {
    if (lines.length === 0) return;
    this.queue.push({ kind: LINE, src, lines });
    this.request();
  }

  /** Queues a marker row (gap, note, error) in stream order. */
  note(kind: Exclude<EntryKind, typeof LINE>, text: string, ms = Date.now()): void {
    this.queue.push({ kind, text, ms });
    this.request();
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /** Applies everything queued. One call per frame, whatever the number of lines. */
  flush(): void {
    const queue = this.queue;
    if (queue.length === 0) return;
    this.queue = [];
    for (const item of queue) {
      if (item.kind === LINE) {
        for (const l of item.lines) {
          if (this.headMode && this.ring.full) {
            this.skipped++;
            continue;
          }
          const parsed = parseAnsi(l.text);
          const e: Entry = { seq: 0, kind: LINE, ms: l.ms, src: item.src, text: parsed.text, spans: parsed.spans };
          if (l.level) e.plevel = l.level;
          if (l.msg !== undefined) e.msg = l.msg;
          if (l.fields?.length) e.fields = l.fields;
          this.append(e);
        }
      } else {
        this.append({ seq: 0, kind: item.kind, ms: item.ms, src: -1, text: item.text, spans: null });
      }
    }
    const first = this.ring.first;
    if (this.cursor !== null && this.cursor < first) this.cursor = this.rowCount > 0 ? this.seqAtRow(0) : null;
    if (this.anchor !== null && this.anchor < first) this.anchor = this.rowCount > 0 ? this.seqAtRow(0) : null;
    if (this.currentHit !== null && this.currentHit < first) this.currentHit = null;
    this.touch();
  }

  private append(e: Entry): void {
    e.seq = this.ring.nextSeq;
    const dropped = this.ring.push(e);
    if (dropped) this.onDrop(dropped);
    if (e.kind === LINE) this.linesIn++;
    if (e.kind === LINE && this.chips && !this.chips(e)) return;
    const m = this.matcher;
    const pass = e.kind === LINE && m !== null && m.test(e.text);
    if (pass && m?.highlights) this.hits.push(e.seq);
    if (e.kind === LINE && this.filtering && !pass) return;
    this.rows?.push(e.seq);
    this.heights.push(this.unitsOf(e));
    if (!this.follow) this.unread++;
  }

  private onDrop(old: Entry): void {
    this.droppedTotal++;
    this.expanded.delete(old.seq);
    if (this.hits.first() === old.seq) this.hits.shift();
    if (this.rows) {
      if (this.rows.first() !== old.seq) return;
      this.rows.shift();
    }
    this.pendingDropped += this.heights.dropFront(1);
  }

  /** Units that fell off the top since the last call: the view shifts a paused viewport by them. */
  takeDropped(): number {
    const n = this.pendingDropped;
    this.pendingDropped = 0;
    return n;
  }
  peekDropped(): number {
    return this.pendingDropped;
  }
  takeScroll(): ScrollCommand | "bottom" | null {
    const s = this.scroll;
    this.scroll = null;
    return s;
  }

  // ── layout ────────────────────────────────────────────────────────────────

  /**
   * Text columns and wrap mode. Rebuilds the row heights when a change affects them and then
   * returns true: the caller's geometry is stale and a new render is on its way.
   */
  setLayout(cols: number, wrap: boolean): boolean {
    if (cols === this.cols && wrap === this.wrap) return false;
    const relevant = wrap !== this.wrap || wrap || this.expanded.size > 0;
    this.cols = cols;
    this.wrap = wrap;
    if (!relevant) return false;
    const keep = this.keepSeq();
    this.rebuildHeights();
    this.restore(keep);
    this.touch();
    return true;
  }

  private rebuildHeights(): void {
    this.heights.clear();
    this.pendingDropped = 0;
    const n = this.rowCount;
    for (let row = 0; row < n; row++) this.heights.push(this.unitsOf(this.ring.get(this.seqAtRow(row)) as Entry));
  }

  /** The line a paused viewport should still show after the rows were rebuilt. */
  private keepSeq(): number | null {
    if (this.follow || this.rowCount === 0) return null;
    return this.cursor ?? this.seqAtRow(clamp(this.viewFirst, 0, this.rowCount - 1));
  }
  private restore(keep: number | null): void {
    if (this.cursor !== null) {
      const row = this.rowOfSeq(this.cursor);
      this.cursor = row < 0 ? null : this.seqAtRow(row);
    }
    if (this.anchor !== null) {
      const row = this.rowOfSeq(this.anchor);
      this.anchor = row < 0 ? null : this.seqAtRow(row);
    }
    if (keep !== null && this.rowCount > 0) this.scroll = { seq: this.cursor ?? keep, align: this.cursor !== null ? "auto" : "start" };
  }

  // ── search and filter-lines ───────────────────────────────────────────────

  /** The search stored in the view (applied with Enter) and its filter-lines flag. */
  setApplied(query: Query | null, filterLines: boolean): void {
    this.applied = query && query.text !== "" ? query : null;
    this.appliedFilter = filterLines;
    this.applySearch();
  }

  openSearch(): void {
    if (!this.searchOpen) this.draft = this.applied ? { ...this.applied } : { mode: this.draft.mode, text: "" };
    this.searchOpen = true;
    this.focusTick++;
    this.applySearch();
    this.touch();
    this.onState();
  }

  /** Live while typing: the draft is the effective search until the input closes. */
  setDraft(patch: Partial<Query>): void {
    this.draft = { ...this.draft, ...patch };
    this.applySearch();
    this.touch();
  }

  closeSearch(): void {
    if (!this.searchOpen) return;
    this.searchOpen = false;
    this.applySearch();
    this.touch();
    this.onState();
  }

  private applySearch(): void {
    const m = compileMatcher(this.searchOpen ? this.draft : this.applied);
    // NOT has nothing to highlight, so it always filters (§6.3)
    const filtering = m !== null && (this.appliedFilter || m.mode === "not");
    if (sameQuery(m, this.matcher) && filtering === this.filtering) return;
    const keep = this.keepSeq();
    this.matcher = m;
    this.filtering = filtering;
    this.reindex();
    this.restore(keep);
    this.touch();
    this.onState();
  }

  private reindex(): void {
    const m = this.matcher;
    this.hits.clear();
    this.rows = this.hiding ? new SeqList() : null;
    this.heights.clear();
    this.pendingDropped = 0;
    const chips = this.chips;
    this.ring.forEach((e, seq) => {
      if (e.kind === LINE && chips && !chips(e)) return;
      const pass = e.kind === LINE && m !== null && m.test(e.text);
      if (pass && m?.highlights) this.hits.push(seq);
      if (e.kind === LINE && this.filtering && !pass) return;
      this.rows?.push(seq);
      this.heights.push(this.unitsOf(e));
    });
    if (this.currentHit !== null && !this.hits.has(this.currentHit)) this.currentHit = null;
  }

  /** `n` / `N`: moves the cursor to the next or previous hit, wrapping around. */
  step(dir: 1 | -1): "none" | "ok" | "wrapped" {
    const n = this.hits.length;
    if (n === 0) return "none";
    const from =
      this.cursor ?? this.currentHit ?? (this.rowCount > 0 ? this.seqAtRow(clamp(dir > 0 ? this.viewFirst : this.viewLast, 0, this.rowCount - 1)) - dir : 0);
    let i = dir > 0 ? this.hits.lowerBound(from + 1) : this.hits.lowerBound(from) - 1;
    let wrapped = false;
    if (i >= n) {
      i = 0;
      wrapped = true;
    } else if (i < 0) {
      i = n - 1;
      wrapped = true;
    }
    const seq = this.hits.at(i);
    this.currentHit = seq;
    this.cursor = seq;
    this.pause();
    this.scroll = { seq, align: "center" };
    this.touch();
    return wrapped ? "wrapped" : "ok";
  }

  /** 1-based position of the current hit among all hits, 0 when there is none. */
  hitIndex(): number {
    return this.currentHit === null ? 0 : this.hits.lowerBound(this.currentHit) + 1;
  }

  // ── follow, cursor, selection ─────────────────────────────────────────────

  private pause(): void {
    if (!this.follow) return;
    this.follow = false;
    this.unread = 0;
    this.onState();
  }

  /** The user scrolled away from the bottom. */
  pauseAtScroll(): void {
    if (!this.follow) return;
    this.pause();
    this.touch();
  }

  /** End / G, the jump control, or a scroll back to the bottom. */
  resume(): void {
    this.follow = true;
    this.unread = 0;
    this.cursor = null;
    this.anchor = null;
    this.scroll = "bottom";
    this.touch();
    this.onState();
  }

  toggleFollow(): void {
    if (this.follow) this.pauseAtScroll();
    else this.resume();
  }

  private place(row: number, align: ScrollCommand["align"] = "auto"): void {
    const n = this.rowCount;
    if (n === 0) return;
    const had = this.cursor !== null;
    this.cursor = this.seqAtRow(clamp(row, 0, n - 1));
    this.pause();
    this.scroll = { seq: this.cursor, align };
    this.touch();
    if (!had) this.onState();
  }

  /** j / k and the page keys. The first press puts the cursor on the last visible line. */
  moveCursor(delta: number): void {
    if (this.cursor === null) this.place(this.viewLast);
    else this.place(this.rowOfSeq(this.cursor) + delta);
  }
  cursorTop(): void {
    this.place(0, "start");
  }
  /** A click on a line. */
  setCursor(seq: number): void {
    const row = this.rowOfSeq(seq);
    if (row >= 0) this.place(row);
  }

  /** `v`: starts a line selection at the cursor; moving the cursor extends it. */
  startSelection(): void {
    if (this.rowCount === 0) return;
    if (this.cursor === null) this.place(this.viewLast);
    this.anchor = this.cursor;
    this.touch();
    this.onState();
  }
  clearSelection(): void {
    if (this.anchor === null) return;
    this.anchor = null;
    this.touch();
    this.onState();
  }
  /** Inclusive seq range of the selection, or null. */
  selection(): readonly [number, number] | null {
    if (this.anchor === null || this.cursor === null) return null;
    return this.anchor <= this.cursor ? [this.anchor, this.cursor] : [this.cursor, this.anchor];
  }

  /** Enter: expands or collapses the cursor line. False when there is nothing to expand. */
  toggleExpand(): boolean {
    // (structured lines expand into their fields, also with wrap on)
    const e = this.cursor === null ? undefined : this.ring.get(this.cursor);
    if (!e || e.kind !== LINE) return false;
    if (!this.expanded.delete(e.seq)) this.expanded.add(e.seq);
    const row = this.rowOfSeq(e.seq);
    this.heights.set(row, this.unitsOf(e));
    this.scroll = { seq: e.seq, align: "auto" };
    this.touch();
    return true;
  }

  // ── buffer commands ───────────────────────────────────────────────────────

  /** `m`: a rule with the current time. */
  mark(): void {
    this.queue.push({ kind: MARK, text: "", ms: Date.now() });
    this.flush();
  }

  /** `C`: empties the buffer; the streams keep running. */
  clear(): void {
    this.ring.clear();
    this.queue = [];
    this.hits.clear();
    this.rows = this.hiding ? new SeqList() : null;
    this.heights.clear();
    this.expanded.clear();
    this.cursor = this.anchor = this.currentHit = null;
    this.unread = 0;
    this.droppedTotal = 0;
    this.skipped = 0;
    this.pendingDropped = 0;
    this.scroll = null;
    this.touch();
    this.onState();
  }

  /** A new stream set: empty buffer, no sources, following again. */
  reset(): void {
    this.sources = [];
    this.pods.clear();
    this.srcIndex.clear();
    this.gutter = 0;
    this.gutterMode = "none";
    this.follow = true;
    this.clear();
  }

  /** Text of the selected lines, or of every visible line. Markers are left out. */
  copyText(opts: { timestamps: boolean }): { text: string; lines: number } {
    const n = this.rowCount;
    const sel = this.selection();
    const from = sel ? this.rowOfSeq(sel[0]) : 0;
    const to = sel ? this.rowOfSeq(sel[1]) : n - 1;
    const multi = this.sources.length > 1;
    const out: string[] = [];
    for (let row = Math.max(0, from); row <= to && row < n; row++) {
      const e = this.entryAtRow(row);
      if (!e || e.kind !== LINE) continue;
      let line = e.text;
      if (multi) {
        const s = this.sources[e.src];
        if (s) line = `[${this.gutterMode === "pod" ? s.pod : this.gutterMode === "container" ? s.container : `${s.pod}/${s.container}`}] ${line}`;
      }
      if (opts.timestamps) line = `${formatClock(e.ms)} ${line}`;
      out.push(line);
    }
    return { text: out.join("\n"), lines: out.length };
  }

  /** every stream of the target is finished (a one-shot read, a completed pod): nothing more will arrive */
  ended = false;
  setEnded(ended: boolean): void {
    if (ended === this.ended) return;
    this.ended = ended;
    this.touch();
    this.onState();
  }

  setStatus(status: StreamStatus): void {
    if (status.phase === this.status.phase && status.message === this.status.message) return;
    this.status = status;
    this.touch();
    this.onState();
  }
}
