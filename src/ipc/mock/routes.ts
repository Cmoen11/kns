// Mock of RoutesBackend (contract/routes.ts): a small shop behind an nginx Ingress and a Gateway API
// Gateway, with one of each kind of trouble so the view has something to point at: a canary split,
// a header match with a rewrite, a redirect-only rule, an endpoint that is not ready, a Service
// port that does not exist, a missing Service, a support desk with no ready pods and an
// ExternalName Service.
import type { RouteBackend, RouteEntry, RouteSource, RoutesBackend } from "../types";
import { delay } from "./shared";

const ing = (namespace: string, name: string, via = "nginx", address = "203.0.113.10"): RouteSource => ({ kind: "Ingress", namespace, name, via, address });
const http = (namespace: string, name: string): RouteSource => ({ kind: "HTTPRoute", namespace, name, via: "gateway infra/public", address: "lb-7f3a.elb.eu-north-1.example" });

const be = (namespace: string, service: string, port: string, targetPort: string | undefined, workload: string | undefined, ready: number, total: number, extra: Partial<RouteBackend> = {}): RouteBackend => ({
  namespace, service, port, targetPort, workload, ready, total, ...extra,
});

const entry = (source: RouteSource, host: string, path: string, backends: RouteBackend[], extra: Partial<RouteEntry> = {}): RouteEntry => ({
  source, host, tls: host !== "*" && !host.endsWith(".internal"), path, matchType: "Prefix", backends, ...extra,
});

const web = ing("shop", "web");
const checkout = http("shop", "checkout");
const ENTRIES: RouteEntry[] = [
  entry(http("shop", "checkout"), "checkout.example.com", "/", [
    be("shop", "checkout", "80", "8080", "Deployment/checkout", 3, 3, { weight: 90 }),
    be("shop", "checkout-canary", "80", "8080", "Deployment/checkout-canary", 1, 1, { weight: 10 }),
  ]),
  entry(checkout, "checkout.example.com", "/beta", [be("shop", "checkout-canary", "80", "8080", "Deployment/checkout-canary", 1, 1)], {
    matchType: "Exact",
    conditions: ["header x-canary: 1", "method GET"],
    filters: ["rewrite prefix → /"],
  }),
  entry(ing("kafka", "kafka-ui", "nginx-internal", "10.0.12.40"), "kafka-ui.internal", "/", [be("kafka", "kafka-ui", "http", "8080", "Deployment/kafka-ui", 1, 1)]),
  entry(http("payments", "payments"), "pay.example.com", "/", [be("payments", "payments-api", "443", "8443", "Deployment/payments-api", 2, 2)]),
  entry(http("payments", "payments"), "pay.example.com", "/webhooks", [be("payments", "webhooks", "80", undefined, undefined, 0, 0, { problem: "Service webhooks not found" })]),
  entry(web, "shop.example.com", "/", [be("shop", "web", "80", "8080", "Deployment/web", 3, 3)]),
  entry(web, "shop.example.com", "/admin", [be("shop", "admin", "8080", undefined, "Deployment/admin", 1, 1, { problem: "port 8080 is not a port of the Service" })], { matchType: "Exact" }),
  entry(web, "shop.example.com", "/api", [be("shop", "api", "80", "http", "Deployment/api", 2, 3)]),
  entry(web, "shop.example.com", "/search", [be("shop", "search", "80", "7700", "StatefulSet/search", 2, 2)]),
  entry(ing("support", "helpdesk"), "support.example.com", "/", [be("support", "helpdesk", "80", "3000", "Deployment/helpdesk", 0, 2, { problem: "no ready endpoints (0/2)" })]),
  entry(ing("games", "arcade", "traefik", "203.0.113.22"), "arcade.example.com", "/", [be("games", "arcade-legacy", "any", undefined, undefined, 0, 0, { externalName: "arcade.legacy-hosting.example.net" })]),
  entry(http("shop", "www-redirect"), "www.example.com", "/", [], { filters: ["redirect → https shop.example.com (301)"] }),
  entry(web, "*", "/", [be("shop", "default-backend", "80", "8080", "Deployment/default-backend", 1, 1)], { matchType: "default", tls: false }),
];

export const routesMock: RoutesBackend = {
  routeMap: (req) => {
    const ns = req.namespace;
    const entries = ns ? ENTRIES.filter((e) => e.source.namespace === ns) : ENTRIES;
    const notes = req.context === "team-test" ? ["httproutes: forbidden across all namespaces; looked in shop, payments"] : [];
    return delay({ entries, notes, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") }, 180);
  },
};
