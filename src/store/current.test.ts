import { describe, expect, it } from "vitest";
import type { ObjectRef, PaneId, ViewKind } from "../types";
import { resolveCurrent, type CachedCursor, type CurrentInput } from "./current";
import { NO_SELECTION, type PaneSelection } from "./selection";

const pod = (name: string): ObjectRef => ({ gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name });

type Entry = { kind: ViewKind; index: number; previousKind: ViewKind | null; pod?: ObjectRef };

function input(o: {
  focused: PaneId | null;
  live?: Record<PaneId, PaneSelection>;
  entries: Record<PaneId, Entry>;
  cache?: Record<PaneId, CachedCursor>;
  lastTable?: PaneId | null;
}): CurrentInput {
  return {
    focused: o.focused,
    selection: (p) => o.live?.[p] ?? NO_SELECTION,
    entry: (p) => o.entries[p] ?? null,
    cache: new Map(Object.entries(o.cache ?? {})),
    lastTable: o.lastTable ?? null,
  };
}

describe("currentObject resolution (plan-features §2.10)", () => {
  it("1. the focused pane's cursor row", () => {
    const got = resolveCurrent(
      input({
        focused: "a",
        live: { a: { focused: pod("web"), marked: [pod("web"), pod("db")] } },
        entries: { a: { kind: "table", index: 0, previousKind: null } },
      }),
    );
    expect(got).toEqual({ paneId: "a", ref: pod("web"), marked: [pod("web"), pod("db")], kind: "table" });
  });

  it("2. the table the hub was opened over in place (previous history entry)", () => {
    const cache = { a: { ref: pod("crashy"), marked: [], kind: "table" as const, index: 2 } };
    const hubOverTable = input({ focused: "a", entries: { a: { kind: "hub", index: 3, previousKind: "table" } }, cache });
    expect(resolveCurrent(hubOverTable)?.ref).toEqual(pod("crashy"));
    // a cursor from another entry of the same pane does not count
    const elsewhere = input({ focused: "a", entries: { a: { kind: "hub", index: 5, previousKind: "table" } }, cache });
    expect(resolveCurrent(elsewhere)).toBeNull();
    // nor when the entry before is not a table (truncated history)
    const notTable = input({ focused: "a", entries: { a: { kind: "hub", index: 3, previousKind: "logs" } }, cache });
    expect(resolveCurrent(notTable)).toBeNull();
  });

  it("3. the last table pane's cursor", () => {
    const live = input({
      focused: "b",
      live: { a: { focused: pod("web"), marked: [] } },
      entries: { a: { kind: "table", index: 0, previousKind: null }, b: { kind: "logs", index: 0, previousKind: null } },
      lastTable: "a",
    });
    expect(resolveCurrent(live)).toMatchObject({ paneId: "a", ref: pod("web") });
    // the last table pane now shows something else: its cache is not its current entry
    const moved = input({
      focused: "b",
      entries: { a: { kind: "doc", index: 1, previousKind: "table" }, b: { kind: "hub", index: 0, previousKind: null } },
      cache: { a: { ref: pod("web"), marked: [], kind: "table", index: 0 } },
      lastTable: "a",
    });
    expect(resolveCurrent(moved)).toBeNull();
  });

  it("is null with nothing selected or the last table pane closed", () => {
    expect(resolveCurrent(input({ focused: null, entries: {} }))).toBeNull();
    expect(resolveCurrent(input({ focused: "b", entries: { b: { kind: "hub", index: 0, previousKind: null } }, lastTable: "gone" }))).toBeNull();
  });
});

describe("currentObject in a containers view", () => {
  it("is the pod, with the container under the cursor", () => {
    const container: ObjectRef = { ...pod("web-1"), name: "sidecar" };
    const got = resolveCurrent(
      input({
        focused: "c",
        live: { c: { focused: container, marked: [] } },
        entries: { c: { kind: "containers", index: 1, previousKind: "table", pod: pod("web-1") } as Entry },
      }),
    );
    expect(got).toEqual({ paneId: "c", ref: pod("web-1"), marked: [], kind: "containers", container: "sidecar" });
  });
});
