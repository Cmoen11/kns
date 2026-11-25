import { describe, expect, it } from "vitest";
import { MOCK_CATALOG } from "../ipc/mock/catalog";
import { clusterOf, componentOf, contextsFor, namespacesIn, nsDetail, scopeTeams, systemOfNamespace, teamNamespaces, userOf } from "./model";
import { mergeKnown } from "./namespaces";

const c = MOCK_CATALOG;
const ctx = (name: string, cluster: string) => ({ name, cluster, user: "u" });

describe("catalog model", () => {
  it("matches a context to its cluster by name or cluster, as a whole word", () => {
    expect(clusterOf(c, ctx("x", "arn:aws:eks:eu-north-1:1:cluster/eks-test"))?.environment).toBe("test");
    expect(clusterOf(c, ctx("eks-prod", "whatever"))?.environment).toBe("prod");
    expect(clusterOf(c, ctx("eks-tester", "nope"))).toBeNull();
    expect(clusterOf(null, ctx("eks-prod", ""))).toBeNull();
    expect(contextsFor(c, [ctx("a", "eks-prod"), ctx("b", "eks-test")], "prod").map((x) => x.name)).toEqual(["a"]);
  });

  it("finds the user by email or name and scopes to their teams unless teams are chosen", () => {
    expect(userOf(c, "DEV@example.com")?.name).toBe("dev");
    expect(scopeTeams(c, "dev@example.com", [])).toEqual(["webshop"]);
    expect(scopeTeams(c, "dev@example.com", ["support", "nope"])).toEqual(["support"]);
    expect(scopeTeams(c, "", [])).toEqual([]);
  });

  it("lists the namespaces of an environment and the team's among them", () => {
    const info = namespacesIn(c, "prod", ["webshop"]);
    // games runs in test only; docs has no namespace
    expect([...info.keys()].sort()).toEqual(["kafka", "payments", "shop", "support"]);
    expect(info.get("shop")?.mine).toBe(true);
    expect(info.get("support")?.mine).toBe(false);
    expect(teamNamespaces(c, "test", ["support"])).toEqual(["games", "support"]);
    expect(nsDetail(info.get("shop"))).toBe("Webshop · Webshop");
    expect(nsDetail(info.get("kafka"))).toBe("Event streaming · Webshop");
  });

  it("finds the component behind a workload", () => {
    const shop = systemOfNamespace(c, "shop");
    expect(componentOf(shop, "orders")?.name).toBe("shop-orders");
    expect(componentOf(shop, "shop-web-7f9c")?.name).toBe("shop-web");
    expect(componentOf(shop, "unrelated")).toBeUndefined();
  });
});

describe("mergeKnown", () => {
  const scope = { info: namespacesIn(c, "test", ["webshop"]), mine: teamNamespaces(c, "test", ["webshop"]) };

  it("keeps the listed namespaces and puts the team's first", () => {
    const m = mergeKnown({ listed: ["default", "shop", "support"], forbidden: false, scope, recent: [], slots: [] });
    expect(m.shown.map((n) => n.name)).toEqual(["shop", "default", "support"]);
    // the catalog's other namespaces are searchable
    expect(m.searchable.map((n) => n.name)).toContain("payments");
  });

  it("offers the team's and the used namespaces when listing is forbidden", () => {
    const m = mergeKnown({ listed: [], forbidden: true, scope, recent: ["games"], slots: [{ name: "x", pinned: true }, null] });
    expect(m.shown.map((n) => n.name)).toEqual(["kafka", "payments", "shop", "games", "x"]);
    expect(m.shown.every((n) => !n.listed)).toBe(true);
  });

  it("without a catalog falls back on the history alone", () => {
    const m = mergeKnown({ listed: [], forbidden: true, scope: { info: new Map(), mine: [] }, recent: ["b", "a"], slots: [] });
    expect(m.shown.map((n) => n.name)).toEqual(["a", "b"]);
  });
});
