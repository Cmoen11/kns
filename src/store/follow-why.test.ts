import { describe, expect, it } from "vitest";
import type { ObjectRef, ViewState } from "../types";
import { FOLLOWING_KINDS, retarget } from "./follow";

const ref = (name: string): ObjectRef => ({ gvr: { group: "", version: "v1", resource: "pods" }, namespace: "kns-spike", name });

describe("follow rule for feature views (plan-features §2.10a)", () => {
  it("retargets a why pane like describe", () => {
    const why: ViewState = { kind: "why", ref: ref("web") };
    expect(retarget(why, ref("crashy"))).toEqual({ kind: "why", ref: ref("crashy") });
    expect(retarget(why, ref("web"))).toBe(why);
    expect(FOLLOWING_KINDS.has("why")).toBe(true);
  });

  it("keeps timeline and patterns pinned", () => {
    const timeline: ViewState = { kind: "timeline", ref: ref("web"), sinceMinutes: 60 };
    expect(retarget(timeline, ref("crashy"))).toBe(timeline);
    expect(FOLLOWING_KINDS.has("timeline")).toBe(false);
    expect(FOLLOWING_KINDS.has("patterns")).toBe(false);
  });
});
