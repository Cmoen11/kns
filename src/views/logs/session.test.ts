import { describe, expect, it } from "vitest";
import { GAP, LINE, LogSession, MARK } from "./session";

/** A session whose frames are run by hand. */
function make(cap = 100) {
  const frames: (() => void)[] = [];
  const s = new LogSession({ cap, schedule: (fn) => frames.push(fn) });
  const frame = () => frames.splice(0).forEach((fn) => fn());
  const src = s.addSource("ns", "pod-a", "main");
  const feed = (...texts: string[]) => s.enqueue(src, texts.map((text, i) => ({ ms: 1000 + i, text })));
  const rows = () => Array.from({ length: s.rowCount }, (_, r) => s.entryAtRow(r)!.text);
  return { s, frame, feed, rows, frames, src };
}

describe("LogSession ingest", () => {
  it("batches appends: nothing is visible until the frame, then one version bump", () => {
    const { s, frame, feed, frames } = make();
    let renders = 0;
    s.subscribe(() => renders++);
    feed("a", "b");
    feed("c");
    feed("d");
    expect(s.rowCount).toBe(0);
    expect(frames).toHaveLength(1);
    frame();
    expect(s.rowCount).toBe(4);
    expect(renders).toBe(1);
  });

  it("strips ANSI on ingest and keeps the spans", () => {
    const { s, frame, feed } = make();
    feed("\u001b[31mred\u001b[0m text");
    frame();
    const e = s.entryAtRow(0)!;
    expect(e.text).toBe("red text");
    expect(e.spans).toEqual([{ start: 0, end: 3, tone: "error", underline: false }]);
  });

  it("drops the oldest lines at capacity and counts them", () => {
    const { s, frame, feed, rows } = make(3);
    feed("1", "2", "3", "4", "5");
    frame();
    expect(rows()).toEqual(["3", "4", "5"]);
    expect(s.droppedTotal).toBe(2);
  });

  it("holds renders back while the pane is hidden", () => {
    const { s, frame, feed } = make();
    let renders = 0;
    s.subscribe(() => renders++);
    s.setVisible(false);
    feed("a");
    frame();
    expect(renders).toBe(0);
    expect(s.rowCount).toBe(1);
    s.setVisible(true);
    expect(renders).toBe(1);
  });

  it("head mode keeps the first lines and counts the rest", () => {
    const { s, frame, feed, rows } = make(2);
    s.headMode = true;
    feed("1", "2", "3", "4");
    frame();
    expect(rows()).toEqual(["1", "2"]);
    expect(s.skipped).toBe(2);
    expect(s.droppedTotal).toBe(0);
  });
});

describe("LogSession follow and pause", () => {
  it("counts unread rows only while paused and resets on resume", () => {
    const { s, frame, feed } = make();
    feed("a", "b");
    frame();
    expect(s.follow).toBe(true);
    expect(s.unread).toBe(0);
    s.pauseAtScroll();
    feed("c", "d", "e");
    frame();
    expect(s.unread).toBe(3);
    s.resume();
    expect(s.follow).toBe(true);
    expect(s.unread).toBe(0);
    expect(s.takeScroll()).toBe("bottom");
  });

  it("reports the units dropped above a paused viewport", () => {
    const { s, frame, feed } = make(3);
    feed("1", "2", "3");
    frame();
    s.pauseAtScroll();
    feed("4", "5");
    frame();
    expect(s.takeDropped()).toBe(2);
    expect(s.takeDropped()).toBe(0);
  });

  it("moving the cursor pauses; the first press lands on the last visible row", () => {
    const { s, frame, feed } = make();
    feed("a", "b", "c", "d");
    frame();
    s.viewFirst = 0;
    s.viewLast = 3;
    s.moveCursor(-1);
    expect(s.follow).toBe(false);
    expect(s.ring.get(s.cursor!)!.text).toBe("d");
    s.moveCursor(-1);
    expect(s.ring.get(s.cursor!)!.text).toBe("c");
    s.moveCursor(-10);
    expect(s.ring.get(s.cursor!)!.text).toBe("a");
    s.moveCursor(100);
    expect(s.ring.get(s.cursor!)!.text).toBe("d");
    expect(s.takeScroll()).toEqual({ seq: s.cursor, align: "auto" });
  });

  it("keeps the cursor on a real line when its line is dropped", () => {
    const { s, frame, feed } = make(3);
    feed("1", "2", "3");
    frame();
    s.cursorTop();
    expect(s.ring.get(s.cursor!)!.text).toBe("1");
    feed("4", "5");
    frame();
    expect(s.ring.get(s.cursor!)!.text).toBe("3");
  });
});

describe("LogSession search and filter-lines", () => {
  const seed = () => {
    const t = make();
    t.feed("GET /api 200", "GET /healthz 200", "error: boom", "GET /api 500", "error: again");
    t.frame();
    return t;
  };

  it("search highlights without hiding lines", () => {
    const { s, rows } = seed();
    s.setApplied({ mode: "re", text: "error" }, false);
    expect(s.filtering).toBe(false);
    expect(rows()).toHaveLength(5);
    expect(s.hits.length).toBe(2);
  });

  it("filter-lines keeps only matching lines, and new lines are filtered as they arrive", () => {
    const { s, rows, feed, frame } = seed();
    s.setApplied({ mode: "re", text: "error" }, true);
    expect(s.filtering).toBe(true);
    expect(rows()).toEqual(["error: boom", "error: again"]);
    feed("fine", "error: third");
    frame();
    expect(rows()).toEqual(["error: boom", "error: again", "error: third"]);
    expect(s.ring.size).toBe(7);
    s.setApplied({ mode: "re", text: "error" }, false);
    expect(rows()).toHaveLength(7);
  });

  it("NOT always filters and has no hits to step through", () => {
    const { s, rows } = seed();
    s.setApplied({ mode: "not", text: "healthz" }, false);
    expect(s.filtering).toBe(true);
    expect(rows()).toEqual(["GET /api 200", "error: boom", "GET /api 500", "error: again"]);
    expect(s.hits.length).toBe(0);
    expect(s.step(1)).toBe("none");
  });

  it("fuzzy matches subsequences", () => {
    const { s, rows } = seed();
    s.setApplied({ mode: "fuzzy", text: "gap5" }, true);
    expect(rows()).toEqual(["GET /api 500"]);
  });

  it("markers stay visible while filtering", () => {
    const { s, rows } = seed();
    s.mark();
    s.setApplied({ mode: "re", text: "boom" }, true);
    expect(rows()).toEqual(["error: boom", ""]);
    expect(s.entryAtRow(1)!.kind).toBe(MARK);
  });

  it("n / N step through hits and wrap around", () => {
    const { s } = seed();
    s.setApplied({ mode: "re", text: "error" }, false);
    s.viewFirst = 0;
    s.viewLast = 4;
    expect(s.step(1)).toBe("ok");
    expect(s.ring.get(s.currentHit!)!.text).toBe("error: boom");
    expect(s.hitIndex()).toBe(1);
    expect(s.follow).toBe(false);
    expect(s.step(1)).toBe("ok");
    expect(s.ring.get(s.currentHit!)!.text).toBe("error: again");
    expect(s.step(1)).toBe("wrapped");
    expect(s.hitIndex()).toBe(1);
    expect(s.step(-1)).toBe("wrapped");
    expect(s.hitIndex()).toBe(2);
    expect(s.takeScroll()).toEqual({ seq: s.currentHit, align: "center" });
  });

  it("the draft is live while the input is open and reverts on cancel", () => {
    const { s, rows } = seed();
    s.setApplied({ mode: "re", text: "error" }, true);
    s.openSearch();
    expect(s.draft).toEqual({ mode: "re", text: "error" });
    s.setDraft({ text: "api" });
    expect(rows()).toEqual(["GET /api 200", "GET /api 500"]);
    s.setDraft({ mode: "not" });
    expect(rows()).toEqual(["GET /healthz 200", "error: boom", "error: again"]);
    s.closeSearch();
    expect(rows()).toEqual(["error: boom", "error: again"]);
  });

  it("hits fall off with the lines they belong to", () => {
    const { s, feed, frame } = make(3);
    s.setApplied({ mode: "re", text: "x" }, false);
    feed("x1", "y", "x2");
    frame();
    expect(s.hits.length).toBe(2);
    feed("y2", "y3");
    frame();
    expect(s.hits.length).toBe(1);
    expect(s.ring.get(s.hits.at(0))!.text).toBe("x2");
  });

  it("a paused, filtered viewport is compensated only for visible rows that dropped", () => {
    const { s, feed, frame } = make(4);
    s.setApplied({ mode: "re", text: "keep" }, true);
    feed("keep 1", "drop", "keep 2", "drop");
    frame();
    s.pauseAtScroll();
    feed("drop");
    frame();
    expect(s.takeDropped()).toBe(1);
    feed("drop");
    frame();
    expect(s.takeDropped()).toBe(0);
  });
});

describe("LogSession selection, marks, copy, expand", () => {
  it("selects a line range from the cursor and copies it", () => {
    const { s, frame, feed } = make();
    feed("a", "b", "c", "d");
    frame();
    s.viewLast = 3;
    s.startSelection();
    s.moveCursor(-2);
    const sel = s.selection()!;
    expect(sel[1] - sel[0]).toBe(2);
    expect(s.copyText({ timestamps: false })).toEqual({ text: "b\nc\nd", lines: 3 });
    s.clearSelection();
    expect(s.selection()).toBeNull();
    expect(s.copyText({ timestamps: false }).lines).toBe(4);
  });

  it("prefixes the pod when several sources are merged", () => {
    const { s, frame, feed } = make();
    const other = s.addSource("ns", "pod-b", "main");
    feed("from a");
    s.enqueue(other, [{ ms: 2000, text: "from b" }]);
    frame();
    expect(s.gutter).toBeGreaterThan(0);
    expect(s.gutterMode).toBe("pod");
    expect(s.sources.map((x) => x.marker)).toEqual(["a", "b"]);
    expect(s.copyText({ timestamps: false }).text).toBe("[pod-a] from a\n[pod-b] from b");
  });

  it("keeps one marker per pod and shows the container when a pod has several", () => {
    const { s } = make();
    s.addSource("ns", "pod-a", "sidecar");
    expect(s.sources.map((x) => x.marker)).toEqual(["a", "a"]);
    expect(s.gutterMode).toBe("container");
    expect(s.addSource("ns", "pod-a", "main")).toBe(0);
  });

  it("adds marks and gap markers in order, and leaves them out of copies", () => {
    const { s, frame, feed, rows } = make();
    feed("a");
    frame();
    s.mark();
    s.note(GAP, "reattached");
    feed("b");
    frame();
    expect(Array.from({ length: s.rowCount }, (_, r) => s.entryAtRow(r)!.kind)).toEqual([LINE, MARK, GAP, LINE]);
    expect(rows()[2]).toBe("reattached");
    expect(s.copyText({ timestamps: false }).text).toBe("a\nb");
  });

  it("clear empties the buffer but not the sources", () => {
    const { s, frame, feed } = make();
    feed("a", "b");
    frame();
    s.clear();
    expect(s.rowCount).toBe(0);
    expect(s.sources).toHaveLength(1);
    feed("c");
    frame();
    expect(s.entryAtRow(0)!.text).toBe("c");
    expect(s.entryAtRow(0)!.seq).toBe(2);
  });

  it("expands a long line to its wrapped height and back", () => {
    const { s, frame, feed } = make();
    feed("short", "x".repeat(250));
    frame();
    s.setLayout(100, false);
    expect(s.heights.total).toBe(2);
    expect(s.toggleExpand()).toBe(false);
    s.viewLast = 1;
    s.moveCursor(-1);
    expect(s.toggleExpand()).toBe(true);
    expect(s.heights.units(1)).toBe(3);
    expect(s.isWrapped(s.cursor!)).toBe(true);
    s.toggleExpand();
    expect(s.heights.total).toBe(2);
  });

  it("wrap mode gives every long line its height and follows the column count", () => {
    const { s, frame, feed } = make();
    feed("x".repeat(250), "y".repeat(90));
    frame();
    s.setLayout(100, true);
    expect([s.heights.units(0), s.heights.units(1)]).toEqual([3, 1]);
    s.setLayout(50, true);
    expect([s.heights.units(0), s.heights.units(1)]).toEqual([5, 2]);
    feed("z".repeat(120));
    frame();
    expect(s.heights.units(2)).toBe(3);
    s.setLayout(50, false);
    expect(s.heights.total).toBe(3);
  });
});
