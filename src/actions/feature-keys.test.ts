// The feature rows of docs/plan-features.md §2.7 (A2): every pending id has a keymap row, the new
// view kinds have list-like chains, and every new view-opening action is in ux.md §4.4.
import ux from "../../docs/ux.md?raw";
import { describe, expect, it } from "vitest";
import { NOT_BUILT_FEATURES } from "../features.pending";
import { KEYMAP_ROWS } from "./keymap-data";
import { createRegistry } from "./registry";
import { FEATURE_LIST_KINDS, LAYERS, tableScopes, viewScopes } from "./scopes";

const rows = new Map(KEYMAP_ROWS.map((r) => [r.id as string, r]));

describe("feature keymap rows", () => {
  it("has a row for every pending feature id", () => {
    expect(NOT_BUILT_FEATURES.filter((id) => !rows.has(id))).toEqual([]);
  });

  it("starts every pending id unbuilt", () => {
    const registry = createRegistry();
    for (const id of NOT_BUILT_FEATURES) expect(registry.get(id)?.built, id).toBe(false);
  });

  it("gives the feature kinds a list-like chain", () => {
    for (const kind of FEATURE_LIST_KINDS) {
      const chain = viewScopes({ kind });
      expect(chain.slice(-2), kind).toEqual(["list", "pane"]);
      if (kind !== "reach") expect(chain[0]).toBe(kind);
    }
  });

  it("puts dev from workload on kinds with a pod template and in the containers view", () => {
    for (const resource of ["pods", "deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "cronjobs"]) {
      expect(tableScopes({ resource, namespaced: true }), resource).toContain("can.env");
    }
    expect(tableScopes({ resource: "services", namespaced: true })).not.toContain("can.env");
    expect(viewScopes({ kind: "containers" })).toContain("can.env");
  });

  it("has a picker layer for dev sets", () => {
    expect(LAYERS.pickerDev.scopes).toEqual(["picker.dev", "picker", "olist"]);
  });

  it("lists every view-opening feature action in ux.md §4.4", () => {
    const section = ux.slice(ux.indexOf("### 4.4 Open in a new pane"), ux.indexOf("### 4.5"));
    const opens = NOT_BUILT_FEATURES.filter((id) => rows.get(id)?.opens === "view").concat(["hub.open"]);
    expect(opens.filter((id) => !section.includes(`\`${id}\``))).toEqual([]);
  });

  it("keeps the agreed keys (plan-features §2.7, as built)", () => {
    const keys = (id: string) => rows.get(id)?.keys;
    expect(keys("hub.open")).toBe("Mod+Shift+H | leader g");
    expect(keys("res.why")).toBe("W");
    expect(keys("res.diff")).toBe("D");
    expect(keys("res.timeline")).toBe("H");
    expect(keys("dev.fromWorkload")).toBe("E");
    expect(keys("pod.debug")).toBe("B");
    expect(keys("diff.split")).toBe("t");
    expect(keys("logs.goToPod")).toBe("O");
    expect(rows.get("hub.help")?.command).toBe("tools help");
  });
});
