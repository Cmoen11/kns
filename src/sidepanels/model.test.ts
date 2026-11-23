import { describe, expect, it } from "vitest";
import { beginOperation, clearFinishedOperations, describeOperation, endOperation, operationsStore, stepOperation } from "../store/operations";
import { ageText, clampWidth, cursorIndex, defaultPrefs, headerKey, jumpSection, matches, moveBy, sanitizePrefs, type PanelRow } from "./model";

const row = (key: string, section: string, header = false): PanelRow => ({ key, section, header, label: key });
const ROWS: PanelRow[] = [
  row(headerKey("a"), "a", true), row("a1", "a"), row("a2", "a"),
  row(headerKey("b"), "b", true),
  row(headerKey("c"), "c", true), row("c1", "c"),
];

describe("side panel cursor", () => {
  it("follows the key, falls back to the old index, then to the first row", () => {
    expect(cursorIndex([], null)).toBe(-1);
    expect(cursorIndex(ROWS, null)).toBe(0);
    expect(cursorIndex(ROWS, { key: "a2", index: 0 })).toBe(2);
    // the row is gone (a stopped forward): stay where it was
    expect(cursorIndex(ROWS, { key: "gone", index: 4 })).toBe(4);
    expect(cursorIndex(ROWS, { key: "gone", index: 99 })).toBe(ROWS.length - 1);
  });

  it("moves and stops at the ends", () => {
    expect(moveBy(ROWS, { key: "a1", index: 1 }, 1)).toBe(2);
    expect(moveBy(ROWS, { key: "c1", index: 5 }, 1)).toBe(5);
    expect(moveBy(ROWS, null, -1)).toBe(0);
    expect(moveBy([], null, 1)).toBe(-1);
  });

  it("jumps between section headers", () => {
    expect(jumpSection(ROWS, { key: "a1", index: 1 }, 1)).toBe(3);
    expect(jumpSection(ROWS, { key: headerKey("b"), index: 3 }, 1)).toBe(4);
    // back: first the own section's header, then the one before
    expect(jumpSection(ROWS, { key: "a2", index: 2 }, -1)).toBe(0);
    expect(jumpSection(ROWS, { key: headerKey("c"), index: 4 }, -1)).toBe(3);
    // no header further on: stays
    expect(jumpSection(ROWS, { key: "c1", index: 5 }, 1)).toBe(5);
  });
});

describe("side panel prefs", () => {
  it("clamps the width and keeps defaults for anything unusable", () => {
    expect(clampWidth(10, "left")).toBe(180);
    expect(clampWidth(9999, "right")).toBe(480);
    expect(clampWidth(Number.NaN, "left")).toBe(240);
    expect(sanitizePrefs(null)).toEqual(defaultPrefs());
    const p = sanitizePrefs({ left: { open: true, width: 5000, collapsed: { namespaces: true, bad: "x" } }, right: "nope" });
    expect(p.left).toEqual({ open: true, width: 480, collapsed: { namespaces: true } });
    expect(p.right).toEqual(defaultPrefs().right);
  });

  it("starts closed, with Recent unfolded", () => {
    const d = defaultPrefs();
    expect(d.left.open || d.right.open).toBe(false);
    expect(d.right.collapsed.recent ?? false).toBe(false);
  });
});

describe("helpers", () => {
  it("matches case-insensitively on any text; an empty query matches all", () => {
    expect(matches("", "x")).toBe(true);
    expect(matches("PROD", "eu-prod", undefined)).toBe(true);
    expect(matches("stag", "prod", "admin")).toBe(false);
  });
  it("formats ages", () => {
    expect([ageText(5000), ageText(125_000), ageText(3 * 3600_000), ageText(72 * 3600_000)]).toEqual(["5s", "2m", "3h", "3d"]);
  });
});

describe("operations log", () => {
  it("tracks progress, takes the result line and keeps running ones on clear", () => {
    operationsStore.setState({ list: [] });
    const a = beginOperation("delete 3 pods", 3, "default", 1000);
    stepOperation(a, true);
    stepOperation(a, false);
    expect(operationsStore.getState().list[0]).toMatchObject({ state: "running", done: 2, failed: 1 });
    stepOperation(a, true);
    endOperation(a, 2000);
    expect(operationsStore.getState().list[0]).toMatchObject({ state: "error", endedAt: 2000 });
    describeOperation(a, { state: "error", text: "Deleted 2 of 3 pods; 1 failed: web: Forbidden" });
    expect(operationsStore.getState().list[0].text).toContain("1 failed");
    const b = beginOperation("restart deployment web", 1, "default", 3000);
    clearFinishedOperations();
    expect(operationsStore.getState().list.map((o) => o.id)).toEqual([b]);
  });
});
