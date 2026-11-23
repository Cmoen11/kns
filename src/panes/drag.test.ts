import { describe, expect, it } from "vitest";
import { dropZoneAt, zoneIn } from "./drag";

const r = { x: 100, y: 0, w: 800, h: 400 };

describe("zoneIn (§3.5)", () => {
  it("swaps in the centre", () => {
    expect(zoneIn(r, 500, 200)).toEqual({ edge: null, rect: r });
  });
  it("inserts on the outer 25% of an edge, capped at 160px", () => {
    // width band: min(200, 160) = 160; height band: min(100, 160) = 100
    expect(zoneIn(r, 250, 200).edge).toBe("left");
    expect(zoneIn(r, 270, 200).edge).toBeNull();
    expect(zoneIn(r, 850, 200)).toEqual({ edge: "right", rect: { x: 500, y: 0, w: 400, h: 400 } });
    expect(zoneIn(r, 500, 50)).toEqual({ edge: "up", rect: { x: 100, y: 0, w: 800, h: 200 } });
    expect(zoneIn(r, 500, 390).edge).toBe("down");
  });
  it("picks the nearer edge in a corner", () => {
    expect(zoneIn(r, 105, 60).edge).toBe("left");
    expect(zoneIn(r, 200, 5).edge).toBe("up");
  });
});

describe("dropZoneAt", () => {
  const rects = new Map([
    ["a", { x: 0, y: 0, w: 500, h: 400 }],
    ["b", { x: 500, y: 0, w: 500, h: 400 }],
  ]);
  it("finds the target under the point", () => {
    expect(dropZoneAt(rects, "a", 750, 200)).toMatchObject({ target: "b", edge: null });
    expect(dropZoneAt(rects, "a", 990, 200)).toMatchObject({ target: "b", edge: "right" });
  });
  it("is null over the source and outside every pane", () => {
    expect(dropZoneAt(rects, "a", 100, 200)).toBeNull();
    expect(dropZoneAt(rects, "a", 1200, 200)).toBeNull();
  });
});
