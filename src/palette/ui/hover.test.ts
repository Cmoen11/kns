import { beforeEach, describe, expect, it } from "vitest";
import { pointerMoved, resetPointer, trackPointer } from "./hover";

const at = (screenX: number, screenY: number) => ({ screenX, screenY });

describe("pointer movement (hover moves the selection only on a real move)", () => {
  beforeEach(resetPointer);

  it("treats the first event as a resting pointer", () => {
    expect(trackPointer(at(10, 10))).toBe(false);
    expect(pointerMoved()).toBe(false);
  });

  it("sees a move when the screen position changes", () => {
    trackPointer(at(10, 10));
    expect(trackPointer(at(10, 11))).toBe(true);
    expect(pointerMoved()).toBe(true);
  });

  it("ignores events at the same position: content scrolled or opened under the pointer", () => {
    trackPointer(at(10, 10));
    trackPointer(at(40, 40));
    expect(trackPointer(at(40, 40))).toBe(false);
    expect(pointerMoved()).toBe(false);
    expect(trackPointer(at(41, 40))).toBe(true);
  });
});
