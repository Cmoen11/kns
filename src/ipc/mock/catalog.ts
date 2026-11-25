// Mock of CatalogBackend (contract/catalog.ts): a small organisation over the mock cluster's
// namespaces, and the RBAC of a team member who may only use a few of them (the `team-test`
// context: listing namespaces or anything across all of them is forbidden).
import type { Catalog, CatalogBackend, TableQuery } from "../types";

/** The mock context of a team member on a shared cluster. */
export const TEAM_CONTEXT = { name: "team-test", cluster: "arn:aws:eks:eu-north-1:000000000000:cluster/eks-test", user: "team-dev", awsProfile: "sso-team" };
/** What that member may list and watch. */
export const TEAM_NAMESPACES: readonly string[] = ["shop", "payments", "kafka"];

/** Whether the mock's RBAC refuses a table query: the team context only grants its namespaces. */
export function mockForbidden(q: TableQuery, namespaced: boolean): boolean {
  if (q.context !== TEAM_CONTEXT.name) return false;
  if (q.gvr.resource === "namespaces" || q.gvr.resource === "nodes") return true;
  if (!namespaced) return false;
  if (q.namespaces?.length) return false;
  return !q.namespace || !TEAM_NAMESPACES.includes(q.namespace);
}

const link = (url: string, title: string) => ({ url, title });

export const MOCK_CATALOG: Catalog = {
  source: "~/catalog.yaml (mock)",
  teams: [
    { name: "webshop", title: "Webshop", links: [link("https://example.com/slack/webshop", "#team-webshop"), link("https://example.com/wiki/webshop", "Wiki")], members: ["dev"] },
    { name: "support", title: "Customer support", links: [link("https://example.com/slack/support", "#team-support")], members: ["sam"] },
    { name: "platform", title: "Platform", links: [], members: ["ops"] },
  ],
  users: [
    { name: "dev", email: "dev@example.com", memberOf: ["webshop"] },
    { name: "sam", email: "sam@example.com", memberOf: ["support"] },
    { name: "ops", email: "ops@example.com", memberOf: ["platform"] },
  ],
  systems: [
    {
      name: "shop", title: "Webshop", description: "The shop front and its order API", owner: "webshop", namespace: "shop",
      environments: ["test", "prod"], expectedSecrets: ["kafka-credentials"], links: [],
      components: [
        { name: "shop-ops", description: "Operations repository for the shop", type: "gitops", repo: "example/shop-ops", workloads: [], links: [link("https://github.com/example/shop-ops", "GitHub")], gitops: { tool: "argocd", path: "argocd", imageFile: "{app}/eks-{env}/image.yaml", appPrefix: "shop-" } },
        { name: "shop-web", description: "Shop front", type: "service", repo: "example/shop-web", workloads: ["web"], links: [link("https://github.com/example/shop-web", "GitHub")] },
        { name: "shop-orders", description: "Order API", type: "service", repo: "example/shop-orders", workloads: ["orders"], links: [link("https://github.com/example/shop-orders", "GitHub")] },
      ],
    },
    {
      name: "payments", title: "Payments", description: "Card and invoice payments", owner: "webshop", namespace: "payments",
      environments: ["test", "stage", "prod"], expectedSecrets: [], links: [],
      components: [{ name: "payments-api", description: "Payment API", type: "service", repo: "example/payments-api", workloads: [], links: [] }],
    },
    {
      name: "kafka", title: "Event streaming", description: "Kafka for the shop", owner: "webshop", namespace: "kafka",
      environments: [], expectedSecrets: [], links: [], components: [],
    },
    {
      name: "support", title: "Support desk", description: "Tickets and chat", owner: "support", namespace: "support",
      environments: ["test", "prod"], expectedSecrets: [], links: [], components: [],
    },
    {
      name: "games", title: "Games", description: "Loyalty games", owner: "support", namespace: "games",
      environments: ["test"], expectedSecrets: [], links: [], components: [],
    },
    { name: "docs", title: "Docs site", description: "No namespace of its own", owner: "platform", environments: [], expectedSecrets: [], links: [], components: [] },
  ],
  clusters: [
    { name: "eks-test", title: "eks-test", environment: "test", contextMatch: ["eks-test", "k3s-home"], protected: false, labels: { team: "tags.datadoghq.com/team", system: "tags.datadoghq.com/system" } },
    { name: "eks-prod", title: "eks-prod", environment: "prod", contextMatch: ["eks-prod", "k3s-staging"], protected: true, labels: { team: "tags.datadoghq.com/team", system: "tags.datadoghq.com/system" } },
  ],
  warnings: [],
};

let chosen = true;

export const catalogMock: CatalogBackend = {
  catalogLoad: () => Promise.resolve(chosen ? MOCK_CATALOG : null),
  catalogChoose: () => {
    chosen = true;
    return Promise.resolve(MOCK_CATALOG);
  },
  catalogForget: () => {
    chosen = false;
    return Promise.resolve();
  },
  catalogOpen: (url) => {
    window.open(url, "_blank", "noopener");
    return Promise.resolve();
  },
};
