import { describe, expect, it } from "vitest";
import { TEMPLATES, NEW_TEMPLATE } from "../../ipc/mock/logs";
import { parseAnsi } from "./ansi";
import { compileMatcher } from "./match";
import { isErrorLevel, mine, templateOf, templateRegex, templateSet, visiblePatterns, type MineLine } from "./patterns";

/** a deterministic random source */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** mock lines as the logs pane holds them (ANSI parsed away) */
function lines(n: number, seed = 1, without?: number): MineLine[] {
  const r = rng(seed);
  const tpls = TEMPLATES.filter((_, i) => i !== without);
  return Array.from({ length: n }, (_, i) => {
    const p = tpls[Math.floor(r() * tpls.length)](r);
    return { text: parseAnsi(p.text).text, ms: 1_000 + i, level: p.level };
  });
}

describe("templateOf", () => {
  it.each([
    ["GET /healthz 200 3ms", "GET /healthz <*> <*>ms"],
    ["INFO  request completed path=/api/items/42 status=200 dur=12ms", "INFO request completed path=/api/items/<*> status=<*> dur=<*>ms"],
    ['{"level":"info","msg":"consumer lag","topic":"orders.created","lag":3}', '{"level":"info","msg":"consumer lag","topic":"<*>","lag":<*>}'],
    ['level=debug msg="cache hit" key=user:42 err="dial tcp 10.0.0.1:9092"', 'level=debug msg="cache hit" key=user:<*> err="<*>"'],
    ["req 3f2a9c1e-1b2c-4d5e-8f90-a1b2c3d4e5f6 from 10.42.0.7:5432 at 2026-11-22T10:00:00.123Z", "req <*> from <*> at <*>"],
    ["took 15:04:05.123 sha 9f86d081884c7d65 k8s v2", "took <*> sha <*> k8s v2"],
  ])("%s", (line, want) => {
    expect(templateOf(line)).toBe(want);
  });

  it("is the same for lines that differ only in their variable parts", () => {
    expect(templateOf("WARN  slow query took 812ms table=x")).toBe(templateOf("WARN  slow query took 1999ms table=x"));
    expect(templateOf("ERROR a")).not.toBe(templateOf("ERROR b"));
  });
});

describe("templateRegex", () => {
  it("matches every line it was made from (the logs filter sees the miner's text)", () => {
    for (const l of lines(2000, 3)) {
      const m = compileMatcher({ mode: "re", text: templateRegex(templateOf(l.text)) });
      expect(m?.error).toBeUndefined();
      expect(m?.test(l.text), l.text).toBe(true);
    }
  });

  it("does not match lines of another template", () => {
    const re = compileMatcher({ mode: "re", text: templateRegex(templateOf("GET /healthz 200 3ms")) })!;
    expect(re.test("GET /healthz 200 9ms")).toBe(true);
    expect(re.test("GET /ready 200 9ms")).toBe(false);
  });
});

describe("mine", () => {
  it("counts templates, keeps first/last and the highest level, sorted by count", () => {
    const r = mine([
      { text: "a 1", ms: 5 },
      { text: "a 2", ms: 3, level: "warn" },
      { text: "a 3", ms: 9, level: "info" },
      { text: "ERROR b", ms: 4 },
    ]);
    expect(r.lines).toBe(4);
    expect(r.patterns[0]).toMatchObject({ template: "a <*>", count: 3, first: 3, last: 9, level: "warn" });
    // no parsed level: the tint detection decides
    expect(r.patterns[1]).toMatchObject({ template: "ERROR b", count: 1, level: "error" });
    expect(r.patterns.every((p) => p.isNew === undefined)).toBe(true);
  });

  it("is deterministic and finds the mock's templates", () => {
    const a = mine(lines(5000, 7));
    const b = mine(lines(5000, 7));
    expect(a).toEqual(b);
    expect(a.patterns.length).toBe(TEMPLATES.length);
  });

  it("marks NEW against the previous run, and nothing without one", () => {
    const prev = templateSet(lines(2000, 9, NEW_TEMPLATE).map((l) => l.text));
    const cur = mine(lines(3000, 11), prev);
    const fresh = cur.patterns.filter((p) => p.isNew);
    expect(fresh.map((p) => p.template)).toEqual([templateOf(parseAnsi(TEMPLATES[NEW_TEMPLATE](() => 0).text).text)]);
    expect(mine(lines(100, 1), new Set()).patterns.some((p) => p.isNew)).toBe(false);
    expect(mine(lines(100, 1), null).patterns.some((p) => p.isNew)).toBe(false);
  });

  it("keeps only error patterns with errors only", () => {
    const r = mine(lines(2000, 5));
    const errs = visiblePatterns(r.patterns, true);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((p) => isErrorLevel(p.level))).toBe(true);
  });

  it("caps at the newest 20k lines", () => {
    const many = lines(21_000, 2);
    expect(mine(many).lines).toBe(20_000);
  });

  // 50 ms on a developer machine; shared CI runners (Windows above all) are 2-3x slower and noisy,
  // so CI gets a wider budget that still catches an accidental quadratic.
  const budget = import.meta.env.CI ? 150 : 50;
  it(`mines 10k lines in under ${budget} ms`, () => {
    const input = lines(10_000, 13);
    mine(input);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      mine(input);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(budget);
  });
});
