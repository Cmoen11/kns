import { describe, expect, it } from "vitest";
import { parseAnsi, rgbTone } from "./ansi";
import { detectLevel } from "./level";
import { buildSegments, unitsFor, wrapSegments } from "./segments";

const E = "\u001b";

describe("parseAnsi", () => {
  it("returns plain text untouched, with no spans", () => {
    const line = "2024-01-01 plain text æøå";
    const p = parseAnsi(line);
    expect(p.text).toBe(line);
    expect(p.spans).toBeNull();
  });

  it("maps red and yellow to the status hues", () => {
    const p = parseAnsi(`${E}[31mERROR${E}[0m boom ${E}[33mWARN${E}[39m ok`);
    expect(p.text).toBe("ERROR boom WARN ok");
    expect(p.spans).toEqual([
      { start: 0, end: 5, tone: "error", underline: false },
      { start: 11, end: 15, tone: "warn", underline: false },
    ]);
  });

  it("maps other colours and bold to a text level, never to a colour", () => {
    const p = parseAnsi(`${E}[32mgreen${E}[0m ${E}[1mbold${E}[22m ${E}[90mgray${E}[0m ${E}[2mdim${E}[0m ${E}[37mwhite${E}[0m`);
    expect(p.text).toBe("green bold gray dim white");
    expect(p.spans?.map((s) => [p.text.slice(s.start, s.end), s.tone])).toEqual([
      ["green", "hi"],
      ["bold", "hi"],
      ["gray", "muted"],
      ["dim", "muted"],
    ]);
  });

  it("keeps a status hue when combined with bold or dim", () => {
    expect(parseAnsi(`${E}[1;31mfatal${E}[0m`).spans?.[0].tone).toBe("error");
    expect(parseAnsi(`${E}[2;33mwarn${E}[0m`).spans?.[0].tone).toBe("warn");
  });

  it("understands 256-colour and truecolor foregrounds and ignores backgrounds", () => {
    expect(parseAnsi(`${E}[38;5;196mred${E}[0m`).spans?.[0].tone).toBe("error");
    expect(parseAnsi(`${E}[38;5;11myellow${E}[0m`).spans?.[0].tone).toBe("warn");
    expect(parseAnsi(`${E}[38;2;255;170;0morange${E}[0m`).spans?.[0].tone).toBe("warn");
    expect(parseAnsi(`${E}[38;5;240mgray${E}[0m`).spans?.[0].tone).toBe("muted");
    const bg = parseAnsi(`${E}[41mon red${E}[0m ${E}[48;5;196mtoo${E}[0m ${E}[48;2;1;2;3mrgb${E}[0m`);
    expect(bg.text).toBe("on red too rgb");
    expect(bg.spans).toBeNull();
  });

  it("carries underline as a flag", () => {
    const p = parseAnsi(`a ${E}[4mlink${E}[24m b`);
    expect(p.spans).toEqual([{ start: 2, end: 6, tone: null, underline: true }]);
  });

  it("treats an empty SGR as reset and keeps the style across text", () => {
    const p = parseAnsi(`${E}[31mone two${E}[m three`);
    expect(p.text).toBe("one two three");
    expect(p.spans).toEqual([{ start: 0, end: 7, tone: "error", underline: false }]);
  });

  it("strips cursor movement, OSC titles and control characters", () => {
    expect(parseAnsi(`${E}[2K${E}[1Gprogress ${E}[?25l50%`).text).toBe("progress 50%");
    expect(parseAnsi(`${E}]0;window title\u0007text`).text).toBe("text");
    expect(parseAnsi(`${E}]8;;http://x${E}\\link${E}]8;;${E}\\`).text).toBe("link");
    expect(parseAnsi("a\rb\u0008c\u0000d").text).toBe("abcd");
  });

  it("survives a truncated escape sequence at the end", () => {
    expect(parseAnsi(`text${E}[31`).text).toBe("text");
    expect(parseAnsi(`text${E}`).text).toBe("text");
  });

  it("expands tabs to 8-column stops", () => {
    expect(parseAnsi("a\tb").text).toBe("a       b");
    expect(parseAnsi("12345678\tx").text).toBe("12345678        x");
  });

  it("never emits markup: angle brackets stay text", () => {
    expect(parseAnsi(`${E}[31m<script>alert(1)</script>${E}[0m`).text).toBe("<script>alert(1)</script>");
  });
});

describe("rgbTone", () => {
  it("classifies by hue and lightness", () => {
    expect(rgbTone(255, 0, 0)).toBe("error");
    expect(rgbTone(255, 220, 0)).toBe("warn");
    expect(rgbTone(0, 200, 255)).toBe("hi");
    expect(rgbTone(80, 80, 80)).toBe("muted");
    expect(rgbTone(160, 160, 160)).toBeNull();
    expect(rgbTone(250, 250, 250)).toBe("hi");
  });
});

describe("detectLevel", () => {
  it("finds an uppercase level token", () => {
    expect(detectLevel("2024-01-01T00:00:00Z ERROR something failed")).toEqual({ start: 21, end: 26, level: "error" });
    expect(detectLevel("WARN low disk")).toEqual({ start: 0, end: 4, level: "warn" });
    expect(detectLevel("[WARNING] x")?.level).toBe("warn");
    expect(detectLevel("12:00 FATAL died")?.level).toBe("error");
  });

  it("finds structured and bracketed lowercase levels", () => {
    const logfmt = 'ts=1 level=error msg="x"';
    const hit = detectLevel(logfmt);
    expect(hit && logfmt.slice(hit.start, hit.end)).toBe("error");
    const json = '{"level":"warn","msg":"x"}';
    const j = detectLevel(json);
    expect(j && json.slice(j.start, j.end)).toBe("warn");
    expect(j?.level).toBe("warn");
    expect(detectLevel("[error] boom")?.level).toBe("error");
  });

  it("recognises klog prefixes", () => {
    expect(detectLevel("E0102 15:04:05.000000       1 reflector.go:1] failed")).toEqual({ start: 0, end: 1, level: "error" });
    expect(detectLevel("W0102 15:04:05.000000 x")?.level).toBe("warn");
    expect(detectLevel("I0102 15:04:05.000000 x")).toBeNull();
  });

  it("leaves prose and info lines alone", () => {
    expect(detectLevel("there was no error in the request")).toBeNull();
    expect(detectLevel("INFO started")).toBeNull();
    expect(detectLevel("ERRORS_TOTAL 3")).toBeNull();
    expect(detectLevel("warning: lowercase prose")).toBeNull();
  });
});

describe("segments", () => {
  const texts = (segs: { text: string }[]) => segs.map((s) => s.text);

  it("returns one plain segment when nothing is styled", () => {
    expect(buildSegments("hello", null, null, null)).toEqual([{ text: "hello", tone: null, underline: false, level: null, hit: false }]);
  });

  it("merges tones, the level token and hits into flat runs", () => {
    const text = "ERROR red tail";
    const segs = buildSegments(text, [{ start: 6, end: 9, tone: "error", underline: false }], { start: 0, end: 5, level: "error" }, [[8, 12]]);
    expect(texts(segs).join("")).toBe(text);
    expect(segs.map((s) => [s.text, s.level, s.tone, s.hit])).toEqual([
      ["ERROR", "error", null, false],
      [" ", null, null, false],
      ["re", null, "error", false],
      ["d", null, "error", true],
      [" ta", null, null, true],
      ["il", null, null, false],
    ]);
  });

  it("clips to the limit", () => {
    const segs = buildSegments("abcdefghij", null, null, [[2, 8]], 5);
    expect(texts(segs)).toEqual(["ab", "cde"]);
    expect(segs[1].hit).toBe(true);
  });

  it("hard-wraps at the column count, splitting segments", () => {
    const segs = buildSegments("abcdefghij", null, null, [[3, 7]]);
    const lines = wrapSegments(segs, 4);
    expect(lines.map((l) => texts(l).join(""))).toEqual(["abcd", "efgh", "ij"]);
    expect(lines[0].map((s) => s.hit)).toEqual([false, true]);
    expect(lines[1].map((s) => s.hit)).toEqual([true, false]);
  });

  it("computes the visual lines of a row", () => {
    expect(unitsFor(0, 80, 40)).toBe(1);
    expect(unitsFor(80, 80, 40)).toBe(1);
    expect(unitsFor(81, 80, 40)).toBe(2);
    expect(unitsFor(100000, 80, 40)).toBe(40);
    expect(unitsFor(500, 0, 40)).toBe(1);
  });
});
