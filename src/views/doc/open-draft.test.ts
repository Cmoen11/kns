import { describe, expect, it } from "vitest";
import { draftLabel, draftLabelFor, isSecretRef } from "./open-draft";

describe("agent drafts", () => {
  it("refuses Secrets (they never go to the draft store)", () => {
    expect(isSecretRef({ gvr: { group: "", version: "v1", resource: "secrets" }, namespace: "x", name: "s" })).toBe(true);
    expect(isSecretRef({ gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "x", name: "d" })).toBe(false);
  });

  it("cleans the label (agent text) and defaults it", () => {
    expect(draftLabel()).toBe("AGENT DRAFT");
    expect(draftLabel("  ")).toBe("AGENT DRAFT");
    expect(draftLabel("fix‮evil​")).toBe("fixevil");
    expect(draftLabel("x".repeat(60)).length).toBe(40);
  });

  it("shows no label for a pane without a draft", () => {
    expect(draftLabelFor("p1", undefined)).toBeNull();
  });
});
