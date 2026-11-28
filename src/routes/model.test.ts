import { describe, expect, it } from "vitest";
import type { RouteBackend, RouteEntry, RouteMap } from "../ipc/types";
import { entryUrl, flatRows, groupHosts, journey, pathLabel, rowHealth, stepOpenWhy, stepRef, summary } from "./model";

const be = (service: string, ready: number, total: number, extra: Partial<RouteBackend> = {}): RouteBackend => ({ namespace: "shop", service, port: "80", targetPort: "8080", ready, total, ...extra });
const entry = (host: string, path: string, backends: RouteBackend[], extra: Partial<RouteEntry> = {}): RouteEntry => ({
  source: { kind: "Ingress", namespace: "shop", name: "web", via: "nginx", address: "203.0.113.10" }, host, tls: true, path, matchType: "Prefix", backends, ...extra,
});
const map = (entries: RouteEntry[]): RouteMap => ({ entries, at: "2026-11-28T10:00:00Z" });

const M = map([
  entry("shop.example.com", "/", [be("web", 3, 3, { workload: "Deployment/web" })]),
  entry("shop.example.com", "/api", [be("api", 2, 3)]),
  entry("checkout.example.com", "/", [be("checkout", 3, 3, { weight: 90 }), be("canary", 1, 1, { weight: 10 })], { source: { kind: "HTTPRoute", namespace: "shop", name: "checkout", via: "gateway infra/public" } }),
  entry("pay.example.com", "/hooks", [be("hooks", 0, 0, { problem: "Service hooks not found" })]),
  entry("www.example.com", "/", [], { filters: ["redirect → https (301)"] }),
]);

describe("routes model", () => {
  it("groups by host, a row per backend", () => {
    const g = groupHosts(M);
    expect(g.map((x) => [x.host, x.rows.length, x.problems])).toEqual([
      ["shop.example.com", 2, 1],
      ["checkout.example.com", 2, 0],
      ["pay.example.com", 1, 1],
      ["www.example.com", 1, 0],
    ]);
    const split = g[1].rows;
    expect(split.map((r) => [r.first, r.branch])).toEqual([[true, "first"], [false, "last"]]);
    expect(summary(g)).toEqual({ routes: 5, hosts: 4, problems: 2 });
  });

  it("filters by any word and keeps a split whole", () => {
    expect(flatRows(groupHosts(M, { filter: "canary" })).map((r) => r.backend?.service)).toEqual(["checkout", "canary"]);
    expect(flatRows(groupHosts(M, { filter: "shop api" })).length).toBe(1);
    expect(flatRows(groupHosts(M, { problemsOnly: true })).map((r) => r.backend?.service)).toEqual(["api", "hooks"]);
  });

  it("marks where a request stops", () => {
    const rows = flatRows(groupHosts(M));
    const h = (svc: string | undefined) => rowHealth(rows.find((r) => r.backend?.service === svc)!);
    expect(h("web")).toMatchObject({ service: "ok", pods: "ok", worst: "ok" });
    expect(h("api")).toMatchObject({ pods: "warn", toPods: "warn", worst: "warn" });
    expect(h("hooks")).toMatchObject({ service: "error", toService: "error", pods: "none" });
    const port = rowHealth({ key: "p", entry: M.entries[0], backend: be("web", 3, 3, { problem: "port 81 is not a port of the Service" }), first: true, branch: "only" });
    expect(port).toMatchObject({ service: "error", toService: "ok", toPods: "error" });
    const empty = rowHealth({ key: "e", entry: M.entries[0], backend: be("web", 0, 2, { problem: "no ready endpoints (0/2)" }), first: true, branch: "only" });
    expect(empty).toMatchObject({ service: "ok", pods: "error", toPods: "error" });
    expect(rowHealth(rows[rows.length - 1]).worst).toBe("ok");
  });

  it("words: url, path label, journey", () => {
    expect(entryUrl(M.entries[1])).toBe("https://shop.example.com/api");
    expect(entryUrl({ ...M.entries[0], host: "*", tls: false, matchType: "default" })).toBe("http://203.0.113.10/");
    expect([pathLabel(M.entries[1]), pathLabel(M.entries[0]), pathLabel({ ...M.entries[1], matchType: "Exact" })]).toEqual(["/api/*", "/*", "= /api"]);
    const j = journey(flatRows(groupHosts(M))[1]);
    expect(j.map((s) => s.title)).toEqual(["Request", "Enters", "Ingress", "Service", "Pods"]);
    expect(j[1].lines).toEqual(["at 203.0.113.10", "IngressClass nginx", "TLS ends here"]);
    expect(j[3].lines[1]).toBe("port 80 → pod port 8080");
    expect(j[4]).toMatchObject({ lines: ["2 of 3 ready"], health: "warn" });
    const all = flatRows(groupHosts(M));
    const redirect = journey(all[all.length - 1]);
    expect(redirect.map((s) => s.title)).toEqual(["Request", "Enters", "Ingress"]);
  });

  it("opens the object of each step", () => {
    const rows = flatRows(groupHosts(M));
    expect(stepRef(rows[0], 1)?.gvr.resource).toBe("ingresses");
    expect(stepRef(rows[2], 0)?.gvr).toEqual({ group: "gateway.networking.k8s.io", version: "v1", resource: "httproutes" });
    expect(stepRef(rows[0], 2)).toEqual({ gvr: { group: "", version: "v1", resource: "services" }, namespace: "shop", name: "web" });
    expect(stepRef(rows[0], 3)).toEqual({ gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "shop", name: "web" });
    const hooks = rows.find((r) => r.backend?.service === "hooks")!;
    expect(stepOpenWhy(hooks, 2)).toBe("the Service does not exist");
    expect(stepOpenWhy(rows[1], 3)).toBe("no workload behind the Service");
  });
});
