import { describe, expect, it } from "vitest";
import type { ApiResource } from "../../ipc/types";
import { groupResources, parseFavorites, recentTables, sectionOf } from "./home-model";
import { countItems, cursorIndex, filterRows, moveCursor, nearestItem, type ListRow } from "./list-model";

const res = (group: string, resource: string, verbs = ["list", "get"], version = "v1"): ApiResource => ({
  gvr: { group, version, resource }, kind: resource, singular: resource, namespaced: true, verbs, shortNames: [], categories: [], subresources: [],
});

describe("home sections", () => {
  it("sorts discovery into the spec's sections", () => {
    expect(sectionOf(res("", "pods"))).toBe("Workloads");
    expect(sectionOf(res("apps", "deployments"))).toBe("Workloads");
    expect(sectionOf(res("networking.k8s.io", "ingresses"))).toBe("Network");
    expect(sectionOf(res("", "secrets"))).toBe("Config");
    expect(sectionOf(res("storage.k8s.io", "storageclasses"))).toBe("Storage");
    expect(sectionOf(res("", "nodes"))).toBe("Cluster");
    expect(sectionOf(res("coordination.k8s.io", "leases"))).toBe("Cluster");
    expect(sectionOf(res("kustomize.toolkit.fluxcd.io", "kustomizations"))).toBe("Flux");
    expect(sectionOf(res("cert-manager.io", "certificates"))).toBe("CRDs");
    expect(sectionOf(res("traefik.io", "pods"))).toBe("CRDs");
  });

  it("keeps section order, known kinds first, and drops what cannot be listed", () => {
    const groups = groupResources([
      res("cert-manager.io", "certificates"),
      res("apps", "statefulsets"),
      res("", "pods"),
      res("apps", "deployments"),
      res("helm.toolkit.fluxcd.io", "helmreleases"),
      res("", "bindings", ["create"]),
      res("metrics.k8s.io", "pods"),
      res("", "pods/log"),
      res("apps", "deployments", ["list"], "v1beta1"),
    ]);
    expect(groups.map((g) => g.section)).toEqual(["Workloads", "Flux", "CRDs"]);
    expect(groups[0].items.map((r) => r.gvr.resource)).toEqual(["pods", "deployments", "statefulsets"]);
  });
});

describe("recent tables", () => {
  const pods = { group: "", version: "v1", resource: "pods" };
  const svc = { group: "", version: "v1", resource: "services" };
  const ws = {
    focused: "b",
    mru: ["b", "a"],
    panes: {
      a: { index: 1, history: [{ kind: "table", gvr: pods, namespace: "*" }, { kind: "table", gvr: svc, namespace: "shop" }] },
      b: { index: 2, history: [{ kind: "table", gvr: pods, namespace: "shop" }, { kind: "doc" }, { kind: "home" }] },
    },
  };

  it("lists the focused pane first, newest first, without duplicates", () => {
    expect(recentTables(ws).map((r) => `${r.gvr.resource}@${r.namespace}`)).toEqual(["pods@shop", "services@shop", "pods@*"]);
  });
  it("honours the limit and an absent workspace", () => {
    expect(recentTables(ws, 1)).toHaveLength(1);
    expect(recentTables(null)).toEqual([]);
  });
});

describe("favourites file", () => {
  const view = { gvr: { group: "", version: "v1", resource: "events" }, namespace: "*", faultsOnly: true, wide: false, filters: [], sort: null };
  it("reads the persisted envelope and the bare slice, sorted by slot", () => {
    const favorites = [
      { id: "x", name: "all pods", view: { ...view, gvr: { group: "", version: "v1", resource: "pods" }, namespace: { current: true } } },
      { id: "y", name: "warnings", slot: 3, view },
    ];
    const a = parseFavorites({ schema: 1, data: { favorites, layouts: [] } });
    expect(a.map((f) => f.name)).toEqual(["warnings", "all pods"]);
    expect(a[0]).toMatchObject({ slot: 3, namespace: "*", faultsOnly: true });
    expect(a[1].namespace).toBeNull();
    expect(parseFavorites({ favorites })).toHaveLength(2);
  });
  it("drops what it cannot trust", () => {
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites({ data: { favorites: "no" } })).toEqual([]);
    expect(parseFavorites({ favorites: [{ name: 3, view }, { name: "x" }, { name: "y", view: { gvr: { resource: "pods" } } }] })).toEqual([]);
  });
});

describe("list model", () => {
  const item = (key: string, ...cells: string[]): ListRow => ({ type: "item", key, cells });
  const rows: ListRow[] = [
    { type: "group", key: "g1", label: "Workloads" },
    item("pods", "pods", "po"),
    item("deploy", "deployments", "deploy"),
    { type: "group", key: "g2", label: "Network" },
    item("svc", "services", "svc"),
    { type: "group", key: "g3", label: "Empty" },
  ];

  it("filters items by every word and drops empty groups", () => {
    expect(filterRows(rows, "")).toBe(rows);
    expect(filterRows(rows, "SERV").map((r) => r.key)).toEqual(["g2", "svc"]);
    expect(filterRows(rows, "de ploy").map((r) => r.key)).toEqual(["g1", "deploy"]);
    expect(filterRows(rows, "nothing")).toEqual([]);
    expect(countItems(rows)).toBe(3);
  });

  it("moves the cursor over items only and clamps at the ends", () => {
    expect(moveCursor(rows, 1, 1)).toBe(2);
    expect(moveCursor(rows, 2, 1)).toBe(4);
    expect(moveCursor(rows, 4, 1)).toBe(4);
    expect(moveCursor(rows, 4, -1)).toBe(2);
    expect(moveCursor(rows, 1, -1)).toBe(1);
    expect(moveCursor(rows, 1, 10)).toBe(4);
    expect(moveCursor(rows, -1, 1)).toBe(1);
    expect(moveCursor([], -1, 1)).toBe(-1);
    expect(nearestItem(rows, rows.length - 1, -1)).toBe(4);
  });

  it("follows the cursor by key and falls back to the first item", () => {
    expect(cursorIndex(rows, "svc")).toBe(4);
    expect(cursorIndex(rows, "gone")).toBe(1);
    expect(cursorIndex(rows, null)).toBe(1);
    expect(cursorIndex([{ type: "group", key: "g", label: "x" }], null)).toBe(-1);
  });
});
