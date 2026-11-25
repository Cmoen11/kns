// One table's live state, outside React (docs/ux.md §12): cursor, marks, row order, the filter
// draft, the selected column and the changed-cell marks. The Grid component calls derive() in
// render; every step is memoized on the identity of its inputs, so a frame in which nothing
// relevant changed costs a few comparisons. Actions reach the model through ./registry.
import type { Column, PodMetric, Row, WatchState } from "../ipc/types";
import type { ColumnPrefs, Filter, ObjectRef, PaneId, Sort } from "../types";
import { engine, flash, setSelection } from "../foundation";
import { ageSeconds, tickPeriodMs } from "./age";
import { columnSortKey, columnText, searchTexts, textsOf, type CellContext } from "./cells";
import { buildSpecs, fitColumns, idealWidth, orderSpecs, titleWidth, WIDTH_STEP, MIN_USER_WIDTH, type ColSpec, type Fit } from "./columns";
import { compileFilters, nextMode, parseFilterInput, sameFilter, INPUT_MODES, type InputMode, type Matcher } from "./filter";
import { cursorAfterRemoval, EMPTY_ORDER, reconcile, sortAll, type OrderState } from "./order";
import { resetPrefs, updatePrefs } from "./prefs";
import { comparator, defaultComparator, type Sortable } from "./sort";
import { deriveStatus, isFault, type Status } from "./status";

export const HEADER_H = 20;
const DELTA_MS = 1000;
const IDEAL_SAMPLE = 200;
const H_SCROLL_STEP = 96;

/** What the Grid needs from a data source (a resource table or the containers of a pod). */
export interface GridSource {
  pane: PaneId;
  kind: "table" | "containers";
  /** plural resource; "containers" for the containers view */
  resource: string;
  flux: boolean;
  /** identity of the data set: cursor, marks and order reset when it changes */
  dataKey: string;
  /** key of the per-kind column preferences */
  prefsKey: string;
  columns: readonly Column[];
  rows: readonly Row[];
  synced: boolean;
  state: WatchState;
  message?: string;
  stale: boolean;
  namespaceColumn: boolean;
  /** the name column hides a `<namespace>-` prefix (setting) */
  stripNsPrefix?: boolean;
  /** null = no CPU/MEM columns */
  metrics: ReadonlyMap<string, PodMetric> | null;
  filters: readonly Filter[];
  faultsOnly: boolean;
  /** the explicit sort of this view, or null for the per-kind memory / kind default */
  sort: Sort | null;
  /** kind default when nothing else is set (events: LAST SEEN) */
  defaultSort: Sort | null;
  /** with no sort at all, keep the source order (containers: spec order) */
  sourceOrder: boolean;
  wide: boolean;
  scopeTest?: (row: Row) => boolean;
  marks: boolean;
  /** LABEL filters are possible (a server-side selector exists) */
  labels: boolean;
  /** "namespace": the empty state offers all namespaces */
  emptyHint?: "namespace";
  /** uid (tables) or name (containers) to restore the cursor on */
  initialCursor?: string;
  refOf(row: Row): ObjectRef;
  setFilters(filters: Filter[]): void;
  setFaults(on: boolean): void;
  setSort(sort: Sort): void;
  setWide(on: boolean): void;
  refresh(): void;
  /** Enter, d, y, e, l, p, s */
  open(what: OpenWhat, row: Row, newPane: "right" | "down" | null): void | Promise<void>;
}

export type OpenWhat = "drill" | "logs" | "logsPrevious";

export interface FilterDraft {
  open: boolean;
  mode: InputMode;
  text: string;
  error?: string;
  /** index of the chip that has keyboard focus, -1 = the input */
  chip: number;
}

export interface Display {
  specs: readonly ColSpec[];
  fit: Fit;
  order: readonly string[];
  rows: ReadonlyMap<string, Row>;
  /** rows appended out of sort position (UNSORTED n) */
  unsorted: number;
  /** rows in scope before filtering */
  total: number;
  /** the cursor row no longer matches the filter (GONE) */
  held: string | null;
  matcher: Matcher;
  sort: Sort | null;
  cursor: string | null;
  cursorIndex: number;
  ctx: CellContext;
  /** faulty rows in scope (filters ignored): the pane header and tab show a hint */
  faults: { error: number; warn: number };
}

export type SortTarget = "name" | "age" | "status" | "namespace" | "selected" | { column: string };

interface DeltaMark {
  cells: Set<number>;
  until: number;
}

const NO_DELTA: ReadonlySet<number> = new Set();

export class TableModel {
  readonly pane: PaneId;
  src!: GridSource;
  private prefs!: ColumnPrefs;
  private subs = new Set<() => void>();
  version = 0;

  // DOM, set by the Grid
  el: HTMLElement | null = null;
  rowH = 20;
  scrollTop = 0;
  viewH = 0;
  /** the width the columns were last fitted to */
  private paneW = 0;
  /** scroll correction to apply after the next render (anchoring, §12.3) */
  pendingScroll = 0;
  ensureCursor = false;

  // state
  cursorUid: string | null = null;
  cursorIndex = 0;
  marks = new Set<string>();
  marksVersion = 0;
  private markAnchor: string | null = null;
  selectedCol: string | null = null;
  filter: FilterDraft = { open: false, mode: "re", text: "", chip: -1 };
  private draft: Filter | null = null;
  columnsOpen = false;
  private deltas = new Map<string, DeltaMark>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  // memo
  private dataKey = "";
  private initialDone = false;
  private resortEpoch = 0;
  private holdEpoch = 0;
  private m: {
    specKey?: unknown[]; specs?: ColSpec[];
    idealKey?: unknown[]; ideal?: ColSpec[];
    orderedKey?: unknown[]; ordered?: ColSpec[];
    fitKey?: unknown[]; fit?: Fit; fitCount: number;
    colIndexFor?: readonly Column[]; colIndex?: Map<string, number>;
    statusKey?: unknown[]; statusOf?: (row: Row) => Status | null;
    ctxKey?: unknown[]; ctx?: CellContext;
    matcherKey?: unknown[]; matcher?: Matcher;
    rowsFor?: readonly Row[]; rows?: Map<string, Row>;
    visKey?: unknown[]; visible?: string[]; total: number; held: string | null;
    filterToken?: unknown[];
    orderKey?: string; orderVisible?: string[]; order: OrderState;
    youngest: number | null;
    faults: { error: number; warn: number };
  } = { fitCount: -1, total: 0, held: null, order: EMPTY_ORDER, youngest: null, faults: { error: 0, warn: 0 } };
  display: Display | null = null;
  private nowMs = Date.now();
  private publishedMarks = -1;
  private publishedOrder: readonly string[] | null = null;
  private markRefs: readonly ObjectRef[] = [];

  constructor(pane: PaneId) {
    this.pane = pane;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getVersion = (): number => this.version;
  bump(): void {
    this.version++;
    for (const fn of [...this.subs]) fn();
  }

  // ── derivation ───────────────────────────────────────────────────────────

  derive(src: GridSource, prefs: ColumnPrefs, width: number, nowMs: number): Display {
    this.paneW = width;
    this.src = src;
    this.prefs = prefs;
    this.nowMs = nowMs;
    const m = this.m;
    if (src.dataKey !== this.dataKey) {
      this.dataKey = src.dataKey;
      this.cursorUid = null;
      this.cursorIndex = 0;
      this.initialDone = false;
      if (this.marks.size > 0) {
        this.marks = new Set();
        this.marksVersion++;
      }
      this.markAnchor = null;
      this.deltas.clear();
      m.order = EMPTY_ORDER;
      m.orderKey = undefined;
      m.fitCount = -1;
      this.pendingScroll = 0;
      if (this.el) this.el.scrollTop = 0;
      this.scrollTop = 0;
    }

    const metricsOn = src.metrics !== null;
    if (changed(m.specKey, (m.specKey = [src.columns, src.resource, src.flux, src.namespaceColumn, metricsOn]))) {
      m.specs = buildSpecs({ resource: src.resource, flux: src.flux, columns: src.columns, namespaceColumn: src.namespaceColumn, metrics: metricsOn });
      // another column set (the server's columns arrived, metrics came or went): the count of
      // the previous fit says nothing about it, so the next fit has no hysteresis
      m.fitCount = -1;
    }
    const specs = m.specs!;

    if (m.colIndexFor !== src.columns) {
      m.colIndexFor = src.columns;
      m.colIndex = new Map(src.columns.map((c, i) => [c.name.trim().toLowerCase(), i]));
    }
    if (changed(m.statusKey, (m.statusKey = [m.colIndex, src.resource, src.flux]))) m.statusOf = this.makeStatusOf(m.colIndex!, src.resource, src.flux);
    const stripNs = src.stripNsPrefix ?? false;
    if (changed(m.ctxKey, (m.ctxKey = [nowMs, src.metrics, m.statusOf, stripNs]))) m.ctx = { nowMs, metrics: src.metrics, statusOf: m.statusOf!, stripNs };
    const ctx = m.ctx!;

    // ideal widths are sampled on a (re)sort, never per data frame
    if (changed(m.idealKey, (m.idealKey = [specs, src.synced, this.resortEpoch, stripNs]))) {
      const sample = src.rows.length > IDEAL_SAMPLE ? src.rows.slice(0, IDEAL_SAMPLE) : src.rows;
      m.ideal = specs.map((s) => {
        if (sample.length === 0) return s;
        let chars = 0;
        for (const r of sample) chars = Math.max(chars, columnText(r, s, ctx).length);
        // the content, and at least the full header title (UP-TO-DATE, not UPD, once there is room)
        return { ...s, ideal: Math.max(idealWidth(s, chars), Math.min(titleWidth(s.title), 160)) };
      });
    }
    if (changed(m.orderedKey, (m.orderedKey = [m.ideal, prefs.order]))) m.ordered = orderSpecs(m.ideal!, prefs.order);
    const ordered = m.ordered!;

    if (changed(m.fitKey, (m.fitKey = [ordered, width, src.wide, prefs.hidden, prefs.pinned, prefs.widths]))) {
      m.fit = fitColumns({ specs: ordered, width, wide: src.wide, prevCount: m.fitCount, overrides: prefs });
      // the render before the pane is measured (width 0) is not a layout the user saw: hysteresis
      // starts from the first real fit, or a column that fits exactly would need 24px more
      if (width > 0) m.fitCount = m.fit.count;
    }
    const fit = m.fit!;

    if (changed(m.matcherKey, (m.matcherKey = [src.filters, this.draft]))) {
      m.matcher = compileFilters(this.draft ? [...src.filters, this.draft] : src.filters);
    }
    const matcher = m.matcher!;

    if (m.rowsFor !== src.rows) {
      m.rowsFor = src.rows;
      const map = new Map<string, Row>();
      for (const r of src.rows) map.set(r.uid, r);
      m.rows = map;
      this.pruneMarks(map);
    }
    const rows = m.rows!;

    // visible set: scope, chips, faults. The cursor row is held when data (not the user) removes it.
    const token = [matcher, src.faultsOnly];
    const userFiltered = changed(m.filterToken, token);
    if (userFiltered) m.filterToken = token;
    const faultClock = src.faultsOnly ? nowMs : 0;
    if (changed(m.visKey, (m.visKey = [src.rows, matcher, src.faultsOnly, src.scopeTest, this.holdEpoch, faultClock]))) {
      const visible: string[] = [];
      let total = 0;
      let held: string | null = null;
      let youngest: number | null = null;
      let error = 0;
      let warn = 0;
      const statusOf = m.statusOf!;
      for (const r of src.rows) {
        if (src.scopeTest && !src.scopeTest(r)) continue;
        total++;
        // statusOf is cached per row object: a frame re-derives only the rows that changed
        const st = r.deleting ? null : statusOf(r)?.state;
        if (st === "error") error++;
        else if (st === "warn") warn++;
        const pass = (matcher.empty || matcher.test(searchTexts(r), r.name)) && (!src.faultsOnly || isFault(statusOf(r)));
        if (pass) {
          visible.push(r.uid);
          const age = ageSeconds(r.created, nowMs);
          if (age !== null && (youngest === null || age < youngest)) youngest = age;
        } else if (!userFiltered && r.uid === this.cursorUid && (m.held === r.uid || this.inOrder(r.uid))) {
          visible.push(r.uid);
          held = r.uid;
        }
      }
      m.visible = visible;
      m.total = total;
      m.held = held;
      m.youngest = youngest;
      if (m.faults.error !== error || m.faults.warn !== warn) m.faults = { error, warn };
    }
    const visible = m.visible!;

    // order (§12.3): full sort only on a user action; data frames reconcile in place
    const sort = this.effectiveSort(ordered);
    const sortSpec = sort ? ordered.find((s) => s.id === sort.column) : undefined;
    const orderKey = `${this.resortEpoch}|${sort?.column ?? ""}|${sort?.desc ?? ""}|${src.synced}`;
    const prevOrder = m.order;
    const resort = orderKey !== m.orderKey || userFiltered;
    if (resort || m.orderVisible !== visible) {
      const cmp = this.makeCmp(rows, sortSpec, sort?.desc ?? false, ctx);
      const first = Math.floor(this.scrollTop / this.rowH);
      const anchor = this.anchorUid(prevOrder.order, first);
      const before = anchor ? prevOrder.order.indexOf(anchor) : -1;
      if (resort) {
        m.order = sortAll(visible, cmp);
        this.ensureCursor = true;
      } else {
        const last = first + Math.ceil(this.viewH / this.rowH);
        m.order = reconcile({ prev: prevOrder, visible, cmp, cursor: this.cursorUid, window: this.el ? { first, last } : null });
        if (m.order !== prevOrder && before >= 0) {
          const after = m.order.order.indexOf(anchor!);
          if (after >= 0 && after !== before) this.pendingScroll += (after - before) * this.rowH;
        }
      }
      m.orderKey = orderKey;
      m.orderVisible = visible;
    }
    const order = m.order.order;

    // cursor: restore, or take the row that moved into the old position
    let idx = this.cursorUid !== null ? (order[this.cursorIndex] === this.cursorUid ? this.cursorIndex : order.indexOf(this.cursorUid)) : -1;
    if (idx < 0 && order.length > 0) {
      let uid: string | null = null;
      if (!this.initialDone) {
        const want = src.initialCursor;
        if (want !== undefined) uid = rows.has(want) && order.includes(want) ? want : (order.find((u) => rows.get(u)?.name === want) ?? null);
        uid ??= order[0];
        this.ensureCursor = true;
      } else uid = cursorAfterRemoval(order, this.cursorIndex);
      this.initialDone = true;
      this.cursorUid = uid;
      idx = uid === null ? -1 : order.indexOf(uid);
    } else if (idx < 0) this.cursorUid = src.synced && this.initialDone ? null : this.cursorUid;
    if (idx >= 0) this.cursorIndex = idx;
    if (this.selectedCol !== null && !fit.cols.some((c) => c.spec.id === this.selectedCol)) this.selectedCol = null;

    return (this.display = {
      specs: ordered, fit, order, rows, unsorted: m.order.unsorted, total: m.total, held: m.held, matcher, sort,
      cursor: idx >= 0 ? this.cursorUid : null, cursorIndex: idx >= 0 ? idx : -1, ctx, faults: m.faults,
    });
  }

  /** how often the Grid must tick `now` */
  tickMs(): number {
    return tickPeriodMs(this.m.youngest);
  }

  private inOrder(uid: string): boolean {
    return this.m.order.order[this.cursorIndex] === uid || this.m.order.order.includes(uid);
  }

  private anchorUid(order: readonly string[], first: number): string | null {
    const last = first + Math.ceil(this.viewH / this.rowH);
    if (this.cursorUid !== null && this.cursorIndex >= first && this.cursorIndex <= last && order[this.cursorIndex] === this.cursorUid) return this.cursorUid;
    return order[first] ?? this.cursorUid;
  }

  private makeStatusOf(colIndex: Map<string, number>, resource: string, flux: boolean): (row: Row) => Status | null {
    const cache = new WeakMap<Row, { young: boolean; status: Status | null }>();
    return (row) => {
      const ageSec = ageSeconds(row.created, this.nowMs);
      const young = ageSec !== null && ageSec < 60;
      const hit = cache.get(row);
      if (hit && hit.young === young) return hit.status;
      const t = textsOf(row);
      const status = deriveStatus({
        resource, flux, deleting: !!row.deleting, ageSec,
        get: (c) => {
          const i = colIndex.get(c);
          return i === undefined ? undefined : t[i];
        },
      });
      cache.set(row, { young, status });
      return status;
    };
  }

  private effectiveSort(specs: readonly ColSpec[]): Sort | null {
    const has = (s: Sort | null | undefined): s is Sort => !!s && specs.some((c) => c.id === s.column);
    if (has(this.src.sort)) return this.src.sort;
    if (has(this.prefs.sort)) return this.prefs.sort;
    if (has(this.src.defaultSort)) return this.src.defaultSort;
    return null;
  }

  private makeCmp(rows: ReadonlyMap<string, Row>, spec: ColSpec | undefined, desc: boolean, ctx: CellContext): (a: string, b: string) => number {
    if (!spec && this.src.sourceOrder) {
      const index = new Map<string, number>();
      this.src.rows.forEach((r, i) => index.set(r.uid, i));
      return (a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0);
    }
    const keys = new Map<string, Sortable>();
    const key = (uid: string): Sortable => {
      let k = keys.get(uid);
      if (!k) {
        const r = rows.get(uid);
        k = r ? { key: spec ? columnSortKey(r, spec, ctx) : null, namespace: r.namespace ?? "", name: r.name } : { key: null, namespace: "", name: uid };
        keys.set(uid, k);
      }
      return k;
    };
    const cmp = spec ? comparator(desc) : defaultComparator;
    return (a, b) => cmp(key(a), key(b));
  }

  private pruneMarks(rows: ReadonlyMap<string, Row>): void {
    if (this.marks.size === 0) return;
    let next: Set<string> | null = null;
    for (const uid of this.marks) {
      if (rows.has(uid)) continue;
      next ??= new Set(this.marks);
      next.delete(uid);
    }
    if (next) {
      this.marks = next;
      this.marksVersion++;
    }
  }

  // ── selection ────────────────────────────────────────────────────────────

  cursorRow(): Row | undefined {
    const d = this.display;
    return d && this.cursorUid !== null ? d.rows.get(this.cursorUid) : undefined;
  }
  hasRow = (): boolean => this.cursorRow() !== undefined;

  /** Publishes the cursor row and marks to the per-pane selection store. */
  publish(): void {
    const d = this.display;
    if (!d) return;
    const row = this.cursorRow();
    const before = this.markRefs;
    const marked = this.markedRefs();
    if (marked !== before) engine.invalidate();
    setSelection(this.pane, { focused: row ? this.src.refOf(row) : null, marked });
  }

  /**
   * The marked rows an action applies to, in display order. Only rows that are on the table now:
   * a mark on a row the filter hides is kept, but it is not counted, published or acted on.
   */
  markedRefs(): readonly ObjectRef[] {
    const d = this.display;
    if (!d) return this.markRefs;
    if (this.publishedMarks === this.marksVersion && this.publishedOrder === d.order) return this.markRefs;
    this.publishedMarks = this.marksVersion;
    this.publishedOrder = d.order;
    const refs: ObjectRef[] = [];
    if (this.marks.size > 0) {
      for (const uid of d.order) {
        const r = this.marks.has(uid) ? d.rows.get(uid) : undefined;
        if (r) refs.push(this.src.refOf(r));
      }
    }
    // keep the identity while the content is the same, so data frames do not republish
    const same = refs.length === this.markRefs.length && refs.every((r, i) => r.uid === this.markRefs[i].uid && r.name === this.markRefs[i].name);
    if (!same) this.markRefs = refs;
    return this.markRefs;
  }

  /** The rows an action applies to: marked rows in display order, else the cursor row. */
  targets(): Row[] {
    const d = this.display;
    if (!d) return [];
    if (this.marks.size > 0) {
      const out: Row[] = [];
      for (const uid of d.order) {
        const r = this.marks.has(uid) ? d.rows.get(uid) : undefined;
        if (r) out.push(r);
      }
      return out;
    }
    const row = this.cursorRow();
    return row ? [row] : [];
  }

  // ── cursor ───────────────────────────────────────────────────────────────

  setCursorIndex(i: number): void {
    const d = this.display;
    if (!d || d.order.length === 0) return;
    const idx = Math.max(0, Math.min(i, d.order.length - 1));
    const uid = d.order[idx];
    this.ensureVisible(idx);
    if (uid === this.cursorUid) return;
    if (this.m.held !== null && this.m.held !== uid) this.holdEpoch++;
    this.cursorUid = uid;
    this.cursorIndex = idx;
    this.bump();
  }
  move(delta: number): void {
    this.setCursorIndex(this.cursorIndex + delta);
  }

  // ── pointer (docs/frontend.md §17) ───────────────────────────────────────

  /** uid of the row at a display index (the data-index of a delegated pointer event) */
  uidAt(i: number): string | undefined {
    return this.display?.order[i];
  }
  /**
   * A click on a row or on one of its controls: the cursor goes to that row and the selection is
   * published now, so an action run in the same tick acts on the clicked row (the Grid publishes
   * in an effect, one render later). By uid: live data reorders under the pointer. False when the
   * row is gone. Does not scroll: the row is under the pointer.
   */
  point(uid: string): boolean {
    const d = this.display;
    if (!d) return false;
    const i = d.order[this.cursorIndex] === uid ? this.cursorIndex : d.order.indexOf(uid);
    if (i < 0) return false;
    if (uid !== this.cursorUid) {
      if (this.m.held !== null && this.m.held !== uid) this.holdEpoch++;
      this.cursorUid = uid;
      this.cursorIndex = i;
      this.bump();
    }
    this.publish();
    return true;
  }
  /**
   * Shift+click: like point, and the range always starts at the row the cursor was on (the last
   * row clicked or marked), never at an older mark: rows in between would be marked unseen.
   */
  pointRange(uid: string): boolean {
    this.markAnchor = this.cursorUid;
    return this.point(uid);
  }
  /** A column header's menu: that column becomes the selected column (as Shift+←/→ does). */
  pointColumn(id: string): void {
    if (this.selectedCol === id || !this.display?.fit.cols.some((c) => c.spec.id === id)) return;
    this.selectedCol = id;
    this.bump();
  }
  /** "hide column": the selected column, stored per kind like the column menu does. NAME stays. */
  canHideSelected(): true | string {
    const s = this.display?.specs.find((x) => x.id === this.selectedCol);
    return !s ? "select a column first" : s.role === "name" ? "the name column cannot be hidden" : true;
  }
  hideSelected(): void {
    const id = this.selectedCol;
    if (id === null || this.canHideSelected() !== true) return;
    updatePrefs(this.src.prefsKey, (p) => (p.hidden.includes(id) ? p : { ...p, hidden: [...p.hidden, id] }));
  }

  moveTo(where: "top" | "bottom"): void {
    this.setCursorIndex(where === "top" ? 0 : Number.MAX_SAFE_INTEGER);
  }
  page(dir: 1 | -1): void {
    this.move(dir * Math.max(1, Math.floor(this.viewH / this.rowH) - 1));
  }
  scrollH(dir: 1 | -1): void {
    if (this.el) this.el.scrollLeft += dir * H_SCROLL_STEP;
  }

  ensureVisible(i: number): void {
    const el = this.el;
    if (!el || i < 0) return;
    const top = i * this.rowH;
    const viewH = el.clientHeight - HEADER_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + this.rowH > el.scrollTop + viewH) el.scrollTop = top + this.rowH - viewH;
    this.scrollTop = el.scrollTop;
  }

  // ── marks ────────────────────────────────────────────────────────────────

  private setMarks(next: Set<string>): void {
    this.marks = next;
    this.marksVersion++;
    this.bump();
  }
  /** Space marks and moves on; a click on a row's checkbox marks that row and stays (`advance` false). */
  toggleMark(advance = true): void {
    const uid = this.cursorUid;
    if (!uid || !this.display || !this.src.marks) return;
    const next = new Set(this.marks);
    if (!next.delete(uid)) next.add(uid);
    this.markAnchor = uid;
    this.setMarks(next);
    if (advance) this.move(1);
  }
  /** Shift+Space: from the last mark to the cursor. Shift+Up/Down: extend while moving. */
  markRange(step: 1 | -1 | 0): void {
    const d = this.display;
    const cursor = this.cursorUid;
    const at = this.cursorIndex;
    if (!d || cursor === null || d.order[at] !== cursor || !this.src.marks) return;
    const next = new Set(this.marks);
    if (step !== 0) {
      next.add(cursor);
      const j = Math.max(0, Math.min(at + step, d.order.length - 1));
      next.add(d.order[j]);
      this.markAnchor ??= cursor;
      this.setMarks(next);
      this.setCursorIndex(j);
      return;
    }
    const a = this.markAnchor !== null ? d.order.indexOf(this.markAnchor) : -1;
    const from = a < 0 ? at : Math.min(a, at);
    const to = a < 0 ? at : Math.max(a, at);
    for (let i = from; i <= to; i++) next.add(d.order[i]);
    this.markAnchor = cursor;
    this.setMarks(next);
  }
  markAll(): void {
    const d = this.display;
    if (!d || !this.src.marks) return;
    this.setMarks(new Set(d.order));
  }
  /** Puts back marks that opening a row menu dropped, when nothing was marked since. */
  restoreMarks(marks: ReadonlySet<string>): void {
    if (this.marks.size === 0 && marks.size > 0) this.setMarks(new Set(marks));
  }
  clearMarks(): void {
    if (this.marks.size === 0) return;
    this.markAnchor = null;
    this.setMarks(new Set());
  }

  // ── sort, columns ────────────────────────────────────────────────────────

  private specFor(target: SortTarget): ColSpec | undefined {
    const d = this.display;
    if (!d) return undefined;
    if (typeof target === "object") return d.specs.find((s) => s.id === target.column);
    switch (target) {
      case "name":
        return d.specs.find((s) => s.role === "name");
      case "age":
        return d.specs.find((s) => s.role === "age");
      case "status":
        return d.specs.find((s) => s.role === "status");
      case "namespace":
        return d.specs.find((s) => s.id === "@ns");
      case "selected":
        return d.specs.find((s) => s.id === this.selectedCol) ?? d.specs.find((s) => s.role === "name");
    }
  }
  canSort = (target: SortTarget): boolean => this.specFor(target) !== undefined;
  /** A sort key or header click: same column again reverses. Always re-sorts (clears UNSORTED). */
  sortBy(target: SortTarget): void {
    const spec = this.specFor(target);
    if (!spec) return;
    const cur = this.display?.sort;
    this.resortEpoch++;
    this.src.setSort({ column: spec.id, desc: cur?.column === spec.id ? !cur.desc : false });
    this.bump();
  }
  refresh(): void {
    this.resortEpoch++;
    this.src.refresh();
    this.bump();
  }
  selectColumn(dir: 1 | -1): void {
    const cols = this.display?.fit.cols ?? [];
    if (cols.length === 0) return;
    const i = cols.findIndex((c) => c.spec.id === this.selectedCol);
    const j = i < 0 ? (dir > 0 ? 0 : cols.length - 1) : Math.max(0, Math.min(i + dir, cols.length - 1));
    this.selectedCol = cols[j].spec.id;
    this.bump();
  }
  /** `<` `>`: the selected column's width in 8px steps, stored per kind. */
  resizeColumn(dir: 1 | -1, id: string | null = this.selectedCol): void {
    const col = this.display?.fit.cols.find((c) => c.spec.id === id);
    if (!col || id === null) return;
    this.setColumnWidth(id, col.width + dir * WIDTH_STEP);
  }
  setColumnWidth(id: string, width: number): void {
    const w = Math.max(MIN_USER_WIDTH, Math.round(width));
    // A width on the column that takes the spare width (NAME) is a floor. Narrower than what the
    // pane gives it anyway, it would change nothing now and pin the column in a narrower pane
    // later: that is not stored, the column goes back to fitted.
    const d = this.display;
    const spec = d?.specs.find((x) => x.id === id);
    if (d && spec?.grow && !this.src.wide) {
      const overrides = { ...this.prefs, widths: { ...this.prefs.widths, [id]: w } };
      const got = fitColumns({ specs: d.specs, width: this.paneW, wide: false, prevCount: this.m.fitCount, overrides }).cols.find((c) => c.spec.id === id);
      if (got && got.width > w) return this.fitColumn(id);
    }
    updatePrefs(this.src.prefsKey, (p) => (p.widths[id] === w ? p : { ...p, widths: { ...p.widths, [id]: w } }));
  }

  // ── column menu (Ctrl/⌘+Shift+M) ──────────────────────────────────────────

  menuIndex = 0;
  toggleColumns(): void {
    this.columnsOpen = !this.columnsOpen;
    // opened with a column selected (a header's menu): start on that column
    this.menuIndex = this.columnsOpen ? Math.max(0, this.display?.specs.findIndex((s) => s.id === this.selectedCol) ?? 0) : 0;
    this.bump();
    engine.invalidate();
  }
  closeColumns(): void {
    if (this.columnsOpen) this.toggleColumns();
  }
  menuSpec(): ColSpec | undefined {
    return this.display?.specs[this.menuIndex];
  }
  menuMove(delta: number): void {
    const n = this.display?.specs.length ?? 0;
    if (n === 0) return;
    this.menuIndex = Math.max(0, Math.min(this.menuIndex + delta, n - 1));
    this.bump();
  }
  private toggleIn(field: "hidden" | "pinned"): void {
    const s = this.menuSpec();
    if (!s || s.role === "name") return;
    updatePrefs(this.src.prefsKey, (p) => {
      const has = p[field].includes(s.id);
      const next = { ...p, [field]: has ? p[field].filter((x) => x !== s.id) : [...p[field], s.id] };
      // pinning a hidden column shows it
      if (field === "pinned" && !has) next.hidden = p.hidden.filter((x) => x !== s.id);
      return next;
    });
  }
  menuToggle(): void {
    this.toggleIn("hidden");
  }
  menuPin(): void {
    this.toggleIn("pinned");
  }
  menuReorder(delta: 1 | -1): void {
    const specs = this.display?.specs;
    if (!specs) return;
    const i = this.menuIndex;
    const j = i + delta;
    // NAME stays first
    if (i < 1 || j < 1 || j >= specs.length) return;
    const ids = specs.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.menuIndex = j;
    updatePrefs(this.src.prefsKey, (p) => ({ ...p, order: ids }));
    this.bump();
  }
  /** fit: drop the user width, back to the fitted one */
  fitColumn(id: string): void {
    updatePrefs(this.src.prefsKey, (p) => {
      if (!(id in p.widths)) return p;
      const widths = { ...p.widths };
      delete widths[id];
      return { ...p, widths };
    });
  }
  menuFit(): void {
    const s = this.menuSpec();
    if (s) this.fitColumn(s.id);
  }
  menuReset(): void {
    resetPrefs(this.src.prefsKey);
  }
  /** `<` `>` inside the menu: the highlighted column, shown or not */
  menuResize(dir: 1 | -1): void {
    const s = this.menuSpec();
    if (!s) return;
    const shown = this.display?.fit.cols.find((c) => c.spec.id === s.id);
    this.setColumnWidth(s.id, (this.prefs.widths[s.id] ?? shown?.width ?? s.min) + dir * WIDTH_STEP);
  }

  // ── filter ───────────────────────────────────────────────────────────────

  private modes(): readonly InputMode[] {
    return this.src.labels ? INPUT_MODES : INPUT_MODES.filter((x) => x !== "label");
  }
  private redraft(): void {
    const f = this.filter;
    const r = f.open ? parseFilterInput(f.text, f.mode) : { filter: null };
    // live while typing, except LABEL, which restarts the watch on Enter only (§6.3)
    const next = r.filter && r.filter.mode !== "label" ? r.filter : null;
    if (next && this.draft && sameFilter(next, this.draft)) return;
    this.draft = next;
  }
  openFilter(): void {
    this.filter = { open: true, mode: "re", text: "", chip: -1 };
    this.redraft();
    this.bump();
  }
  setFilterText(text: string): void {
    this.filter = { ...this.filter, text, error: undefined, chip: -1 };
    this.redraft();
    this.bump();
  }
  cycleMode(): void {
    this.filter = { ...this.filter, mode: nextMode(this.filter.mode, this.modes()), error: undefined };
    this.redraft();
    this.bump();
  }
  private closeFilter(): void {
    this.filter = { open: false, mode: "re", text: "", chip: -1 };
    this.draft = null;
    this.bump();
    engine.invalidate();
  }
  applyFilter(): void {
    const f = this.filter;
    if (!f.open) return;
    const r = parseFilterInput(f.text, f.mode);
    if (r.error || (r.filter?.mode === "label" && !this.src.labels)) {
      this.filter = { ...f, error: r.error ?? "label filters are not available here" };
      this.bump();
      return;
    }
    const add = r.filter;
    if (add && !this.src.filters.some((x) => sameFilter(x, add))) this.src.setFilters([...this.src.filters, add]);
    this.closeFilter();
  }
  cancelFilter(): void {
    if (this.filter.open) this.closeFilter();
  }
  filterInputEmpty = (): boolean => this.filter.open && this.filter.text === "" && this.src.filters.length > 0;
  chipFocus(dir: 1 | -1): void {
    const n = this.src.filters.length;
    if (n === 0) return;
    const cur = this.filter.chip;
    const next = cur < 0 ? (dir < 0 ? n - 1 : -1) : cur + dir >= n ? -1 : Math.max(0, cur + dir);
    this.filter = { ...this.filter, chip: next };
    this.bump();
  }
  chipRemove(): void {
    const n = this.src.filters.length;
    if (n === 0) return;
    const i = this.filter.chip >= 0 ? Math.min(this.filter.chip, n - 1) : n - 1;
    this.removeChip(i);
    this.filter = { ...this.filter, chip: -1 };
    this.bump();
  }
  removeChip(i: number): void {
    this.src.setFilters(this.src.filters.filter((_, j) => j !== i));
  }
  hasChips = (): boolean => this.src.filters.length > 0 || this.src.faultsOnly;
  /** Esc ladder step 8: remove the last chip (FAULTS is the last one when on). */
  clearLastChip(): void {
    if (this.src.faultsOnly) this.src.setFaults(false);
    else if (this.src.filters.length > 0) this.removeChip(this.src.filters.length - 1);
  }

  // ── copy ─────────────────────────────────────────────────────────────────

  copy(what: "name" | "namespace" | "cell"): void {
    const d = this.display;
    const rows = this.targets();
    if (!d || rows.length === 0) return;
    const spec = what === "cell" ? (d.specs.find((s) => s.id === this.selectedCol) ?? d.specs.find((s) => s.role === "name")) : undefined;
    // a name copies whole, even while the table hides its namespace prefix
    const lines = rows.map((r) => (what === "name" ? r.name : what === "namespace" ? (r.namespace ?? "") : spec && spec.role !== "name" ? columnText(r, spec, d.ctx) : r.name));
    const label = what === "cell" ? (spec?.title.toLowerCase() ?? "cell") : what;
    const done = () => flash(rows.length > 1 ? `copied ${rows.length} ${label} values` : `copied ${label}: ${lines[0]}`);
    const fail = () => flash("copy failed: the clipboard is not available", "warn");
    try {
      navigator.clipboard.writeText(lines.join("\n")).then(done, fail);
    } catch {
      fail();
    }
  }

  // ── open ─────────────────────────────────────────────────────────────────

  open(what: OpenWhat, newPane: "right" | "down" | null): void | Promise<void> {
    const row = this.cursorRow();
    if (row) return this.src.open(what, row, newPane);
  }

  // ── changed cells (§9.4): a static 1s state, no animation ────────────────

  /** `prev` is the row before the frame, `next` the row after it. */
  markChanged(uid: string, prev: Row, next: Row, nowMs: number): void {
    const a = textsOf(prev);
    const b = textsOf(next);
    let cells: Set<number> | null = null;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) (cells ??= new Set()).add(i);
    if (!!prev.deleting !== !!next.deleting) (cells ??= new Set()).add(-2);
    if (!cells) return;
    this.deltas.set(uid, { cells, until: nowMs + DELTA_MS });
  }
  flushDeltas(): void {
    if (this.deltas.size === 0 || this.deltaTimer !== null) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      const now = Date.now();
      for (const [uid, d] of this.deltas) if (d.until <= now) this.deltas.delete(uid);
      this.bump();
      this.flushDeltas();
    }, DELTA_MS);
  }
  clearDeltas(): void {
    this.deltas.clear();
  }
  deltaOf(uid: string): ReadonlySet<number> {
    return this.deltas.get(uid)?.cells ?? NO_DELTA;
  }

  dispose(): void {
    if (this.deltaTimer !== null) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
  }
}

/** Shallow array comparison for memo keys. */
function changed(prev: unknown[] | undefined, next: unknown[]): boolean {
  if (!prev || prev.length !== next.length) return true;
  for (let i = 0; i < next.length; i++) if (!Object.is(prev[i], next[i])) return true;
  return false;
}
