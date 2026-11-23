import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "../ipc/types";
import { resolveMode } from "./appearance";
import { persistedStore, type PersistBackend } from "./persist";

interface S {
  count: number;
  name: string;
}
const defaults = (): S => ({ count: 0, name: "x" });
function sanitize(data: unknown, d: S): S {
  const r = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (r.count === "poison") throw new Error("bad");
  return {
    count: typeof r.count === "number" ? Math.max(0, r.count) : d.count,
    name: typeof r.name === "string" ? r.name : d.name,
  };
}

function fakeBackend(initial: Record<string, Json> = {}, loadDelay = 0) {
  const files = new Map<string, Json>(Object.entries(initial));
  const saves: [string, Json][] = [];
  const backend: PersistBackend = {
    loadState: (key) =>
      new Promise((resolve) => setTimeout(() => resolve(files.has(key) ? (files.get(key) as Json) : null), loadDelay)),
    saveState: (key, value) => {
      saves.push([key, JSON.parse(JSON.stringify(value)) as Json]);
      files.set(key, value);
      return Promise.resolve();
    },
  };
  return { backend, files, saves };
}
const make = (b: PersistBackend, extra: Partial<Parameters<typeof persistedStore<S>>[0]> = {}) =>
  persistedStore<S>({ key: "t", version: 2, defaults, sanitize, backend: b, ...extra });

describe("persistedStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with defaults and loads the stored value", async () => {
    const f = fakeBackend({ t: { schema: 2, data: { count: 5, name: "saved" } } });
    const s = make(f.backend);
    expect(s.getState()).toEqual(defaults());
    expect(s.isHydrated()).toBe(false);
    await vi.runAllTimersAsync();
    await s.hydrated;
    expect(s.getState()).toEqual({ count: 5, name: "saved" });
    expect(f.saves).toEqual([]);
  });

  it("debounces and coalesces writes into one envelope", async () => {
    const f = fakeBackend();
    const s = make(f.backend);
    await vi.runAllTimersAsync();
    s.setState({ count: 1 });
    s.setState({ count: 2 });
    await vi.advanceTimersByTimeAsync(499);
    expect(f.saves).toEqual([]);
    s.setState({ count: 3 });
    await vi.advanceTimersByTimeAsync(499);
    expect(f.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.saves).toEqual([["t", { schema: 2, data: { count: 3, name: "x" } }]]);
  });

  it("does not save before hydration, and replays early sets on top of the loaded state", async () => {
    const f = fakeBackend({ t: { schema: 2, data: { count: 5, name: "saved" } } }, 100);
    const s = make(f.backend);
    s.setState({ count: 9 });
    s.setState((p) => ({ name: p.name + "!" }));
    await vi.advanceTimersByTimeAsync(99);
    expect(f.saves).toEqual([]);
    expect(s.getState()).toEqual({ count: 9, name: "x!" });
    await vi.advanceTimersByTimeAsync(1);
    await s.hydrated;
    // the functional update is re-run against the loaded name
    expect(s.getState()).toEqual({ count: 9, name: "saved!" });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.saves).toEqual([["t", { schema: 2, data: { count: 9, name: "saved!" } }]]);
  });

  it("an early full replace written as an update keeps the other stored fields", async () => {
    const f = fakeBackend({ t: { schema: 2, data: { count: 5, name: "saved" } } }, 100);
    const s = make(f.backend);
    // the shape setSettings uses: functional + replace
    s.setState((p) => ({ ...p, count: 9 }), true);
    await vi.advanceTimersByTimeAsync(100);
    await s.hydrated;
    expect(s.getState()).toEqual({ count: 9, name: "saved" });
  });

  it("validates field by field", async () => {
    const f = fakeBackend({ t: { schema: 2, data: { count: -4, name: 12, extra: true } } });
    const s = make(f.backend);
    await vi.runAllTimersAsync();
    expect(s.getState()).toEqual({ count: 0, name: "x" });
  });

  it.each([
    ["not an envelope", { count: 1 }],
    ["a newer schema", { schema: 3, data: { count: 1 } }],
    ["an older schema without a migration", { schema: 1, data: { count: 1 } }],
    ["data the sanitizer rejects", { schema: 2, data: { count: "poison" } }],
    ["a string", "garbage"],
  ])("falls back to defaults and keeps a .bak on %s", async (_name, stored) => {
    const f = fakeBackend({ t: stored as Json });
    const s = make(f.backend);
    await vi.runAllTimersAsync();
    expect(s.getState()).toEqual(defaults());
    expect(f.files.get("t.bak")).toEqual(stored);
  });

  it("migrates older data", async () => {
    const f = fakeBackend({ t: { schema: 1, data: { n: 7 } } });
    const s = make(f.backend, { migrate: (data, from) => (from === 1 ? { count: (data as { n: number }).n, name: "m" } : data) });
    await vi.runAllTimersAsync();
    expect(s.getState()).toEqual({ count: 7, name: "m" });
  });

  it("survives a backend that fails to load or save", async () => {
    const backend: PersistBackend = {
      loadState: () => Promise.reject(new Error("io")),
      saveState: () => Promise.reject(new Error("io")),
    };
    const s = make(backend);
    await vi.runAllTimersAsync();
    expect(s.isHydrated()).toBe(true);
    s.setState({ count: 1 });
    await vi.runAllTimersAsync();
    await s.flush();
    expect(s.getState().count).toBe(1);
  });

  it("flush writes pending changes immediately", async () => {
    const f = fakeBackend();
    const s = make(f.backend);
    await vi.runAllTimersAsync();
    s.setState({ count: 4 });
    await s.flush();
    expect(f.saves.length).toBe(1);
    await vi.runAllTimersAsync();
    expect(f.saves.length).toBe(1);
  });
});

describe("resolveMode", () => {
  it("follows the system in 'system' mode and falls back to Mørk", () => {
    expect(resolveMode("system", true)).toBe("mork");
    expect(resolveMode("system", false)).toBe("lys");
    expect(resolveMode("system", null)).toBe("mork");
    expect(resolveMode("lys", true)).toBe("lys");
    expect(resolveMode("mork", false)).toBe("mork");
  });
});
