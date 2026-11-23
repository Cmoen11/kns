import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToasts } from "./toast";

describe("toasts (§11.9)", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const texts = (t: ReturnType<typeof createToasts>) => t.store.getState().visible.map((x) => x.text);

  it("info lasts 4s, undo 10s, errors stay", () => {
    const t = createToasts();
    t.show("info");
    t.show({ text: "undoable", undo: () => undefined });
    t.error("broken");
    vi.advanceTimersByTime(4000);
    expect(texts(t)).toEqual(["undoable", "broken"]);
    vi.advanceTimersByTime(6000);
    expect(texts(t)).toEqual(["broken"]);
    vi.advanceTimersByTime(600_000);
    expect(texts(t)).toEqual(["broken"]);
    t.dismissAll();
    expect(texts(t)).toEqual([]);
  });

  it("shows at most three; the oldest error leaves first and is counted, nothing is dropped from the log", () => {
    const t = createToasts();
    t.show("a");
    t.error("e1");
    t.error("e2");
    t.show("b");
    expect(texts(t)).toEqual(["a", "e2", "b"]);
    expect(t.store.getState().overflowErrors).toBe(1);
    t.show("c");
    expect(texts(t)).toEqual(["a", "b", "c"]);
    expect(t.store.getState().overflowErrors).toBe(2);
    t.show("d");
    expect(texts(t)).toEqual(["b", "c", "d"]);
    expect(t.store.getState().overflowErrors).toBe(2);
    expect(t.store.getState().log.map((l) => l.text)).toEqual(["a", "e1", "e2", "b", "c", "d"]);
    t.markErrorsSeen();
    expect(t.store.getState().overflowErrors).toBe(0);
  });

  it("only the newest undo toast owns the undo key, then the next newest", () => {
    const t = createToasts();
    const calls: string[] = [];
    t.show({ text: "scaled", undo: () => void calls.push("scale") });
    t.show({ text: "suspended", undo: () => void calls.push("suspend") });
    expect(t.newestUndo()?.text).toBe("suspended");
    expect(t.undoLast()).toBe(true);
    expect(t.newestUndo()?.text).toBe("scaled");
    expect(t.undoLast()).toBe(true);
    expect(t.undoLast()).toBe(false);
    expect(calls).toEqual(["suspend", "scale"]);
    expect(texts(t)).toEqual([]);
  });

  it("an expired undo is gone, and a failing undo is reported", () => {
    const t = createToasts();
    t.show({ text: "x", undo: () => undefined });
    vi.advanceTimersByTime(10_000);
    expect(t.newestUndo()).toBeUndefined();
    t.show({
      text: "y",
      undo: () => {
        throw new Error("nope");
      },
    });
    t.undoLast();
    expect(t.store.getState().visible[0]).toMatchObject({ kind: "error" });
  });
});
