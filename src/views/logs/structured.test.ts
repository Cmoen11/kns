import { describe, expect, it } from "vitest";
import { LINE, LogSession } from "./session";
import { chipPredicate, displayLine, effectiveLevel, expandedLines, filterLabel, parseFieldFilter, passes, type ParsedLine } from "./structured";

const json: ParsedLine = { text: '{"level":"warn","msg":"slow","table":"x","ms":"812"}', plevel: "warn", msg: "slow", fields: [["table", "x"], ["ms", "812"]] };

describe("parseFieldFilter", () => {
  it.each([
    ["level>=warn", { kind: "level", op: ">=", level: "warn" }],
    ["level = ERR", { kind: "level", op: "=", level: "error" }],
    ["lvl>=warning", { kind: "level", op: ">=", level: "warn" }],
    [".traceId=abc", { kind: "field", key: "traceId", value: "abc" }],
    ['.msg="slow query"', { kind: "field", key: "msg", value: "slow query" }],
    [".k=", { kind: "field", key: "k", value: "" }],
  ])("%s", (text, want) => {
    expect(parseFieldFilter(text)).toEqual(want);
  });

  it("leaves ordinary searches alone", () => {
    for (const t of ["error", "level>=loud", "traceId=abc", "a.b=c", "level"]) expect(parseFieldFilter(t)).toBeNull();
  });

  it("labels round-trip", () => {
    for (const t of ["level>=warn", ".traceId=abc"]) expect(filterLabel(parseFieldFilter(t)!)).toBe(t);
  });
});

describe("passes", () => {
  it("compares levels, falling back to the tint detection", () => {
    const ge = parseFieldFilter("level>=warn")!;
    expect(passes(ge, json)).toBe(true);
    expect(passes(ge, { text: "x", plevel: "info" })).toBe(false);
    expect(passes(ge, { text: "ERROR plain line" })).toBe(true);
    expect(passes(ge, { text: "plain line" })).toBe(false);
    expect(effectiveLevel({ text: "[warn] x" })).toBe("warn");
    expect(passes(parseFieldFilter("level=error")!, { text: "x", plevel: "fatal" })).toBe(false);
  });

  it("matches fields exactly, and msg", () => {
    expect(passes(parseFieldFilter(".table=x")!, json)).toBe(true);
    expect(passes(parseFieldFilter(".table=y")!, json)).toBe(false);
    expect(passes(parseFieldFilter(".msg=slow")!, json)).toBe(true);
    const both = chipPredicate([parseFieldFilter("level>=warn")!, parseFieldFilter(".ms=812")!])!;
    expect(both(json)).toBe(true);
    expect(chipPredicate([])).toBeNull();
  });
});

describe("display", () => {
  it("shows LEVEL message fields, the level tinted from warn up", () => {
    const d = displayLine(json);
    expect(d.text).toBe("WARN  slow  table=x  ms=812");
    expect(d.level).toEqual({ start: 0, end: 4, level: "warn" });
    expect(d.spans.map((s) => d.text.slice(s.start, s.end))).toEqual(["table=", "ms="]);
    const info = displayLine({ text: "t", plevel: "info", msg: "hi" });
    expect(info.level).toBeNull();
    expect(info.spans[0]).toMatchObject({ start: 0, end: 4, tone: "muted" });
  });

  it("cleans cluster text", () => {
    expect(displayLine({ text: "", msg: "a‮b\u0007c", fields: [["k​", "v\u001b[31m"]] }).text).toBe("abc  k=v");
  });

  it("expands into aligned key/value rows", () => {
    const x = expandedLines(json);
    expect(x.head.text).toBe("WARN  slow");
    expect(x.rows).toEqual([{ key: "table", value: "x" }, { key: "ms", value: "812" }]);
    expect(x.pad).toBe(5);
  });
});

describe("session with structured lines", () => {
  const mk = () => {
    const s = new LogSession({ cap: 100, schedule: () => {} });
    const src = s.addSource("ns", "p", "c");
    s.enqueue(src, [
      { ms: 1, text: "GET / 200" },
      { ms: 2, text: json.text, level: "warn", msg: "slow", fields: [["table", "x"], ["ms", "812"]] },
      { ms: 3, text: '{"level":"info","msg":"ok"}', level: "info", msg: "ok" },
    ]);
    s.flush();
    return s;
  };

  it("keeps the parse on the entry and expands a structured line into its fields", () => {
    const s = mk();
    s.setLayout(80, false);
    expect(s.ring.get(1)).toMatchObject({ kind: LINE, plevel: "warn", msg: "slow" });
    expect(s.heights.total).toBe(3);
    s.setStructured(true);
    s.setCursor(1);
    s.toggleExpand();
    expect(s.heights.total).toBe(5);
    s.setStructured(false);
    // a plain expanded line that fits takes one row
    expect(s.heights.total).toBe(3);
  });

  it("field chips hide lines and come off one by one", () => {
    const s = mk();
    s.addFieldFilter(parseFieldFilter("level>=info")!);
    expect(s.rowCount).toBe(2);
    expect(s.hiding).toBe(true);
    s.addFieldFilter(parseFieldFilter("level>=info")!);
    expect(s.fieldFilters.length).toBe(1);
    s.addFieldFilter(parseFieldFilter(".table=x")!);
    expect(s.rowCount).toBe(1);
    // new lines are filtered as they arrive
    s.enqueue(0, [{ ms: 4, text: "x", level: "error", fields: [["table", "x"]] }, { ms: 5, text: "y", level: "error" }]);
    s.flush();
    expect(s.rowCount).toBe(2);
    s.removeFieldFilter();
    s.removeFieldFilter();
    expect(s.hiding).toBe(false);
    expect(s.rowCount).toBe(5);
  });
});
