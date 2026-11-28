// HTTP routes (`:routes`, docs/tools.md#routes): every way into the cluster over HTTP that
// Ingresses and Gateway API HTTPRoutes describe, one entry per host and path match, each followed to
// the Services it ends at (port, targetPort, ready endpoints, workload). Only reads.
// Mirror: src-tauri/src/contract/routes.rs (types), src-tauri/src/routes.rs (command).

export interface RoutesRequest {
  context: string;
  /** one namespace; none: every namespace */
  namespace?: string;
  /** where to look when listing across namespaces is forbidden (a team's namespaces) */
  namespaces?: string[];
}

/** The object that declares a route. */
export interface RouteSource {
  kind: "Ingress" | "HTTPRoute" | (string & {});
  namespace: string;
  name: string;
  /** what serves it: the IngressClass (`nginx`) or the Gateway (`gateway infra/public`) */
  via?: string;
  /** the address clients reach it at (load balancer IP or hostname) */
  address?: string;
}

/** Where one route ends: a Service port, and what is behind it. */
export interface RouteBackend {
  namespace: string;
  service: string;
  /** the Service port as the route names it: a number or a port name */
  port: string;
  /** the container port it maps to, when the Service has the port */
  targetPort?: string;
  /** share of the requests in percent, when a rule splits between backends */
  weight?: number;
  /** the workload of the endpoints' pods as `Kind/name` */
  workload?: string;
  /** an ExternalName Service: the DNS name it points at */
  externalName?: string;
  ready: number;
  total: number;
  /** the first broken link */
  problem?: string;
}

/** One host and path match of an Ingress rule or HTTPRoute rule. */
export interface RouteEntry {
  source: RouteSource;
  /** `*` for any host */
  host: string;
  tls: boolean;
  path: string;
  /** Prefix, Exact, RegularExpression, ImplementationSpecific, or default (an Ingress default backend) */
  matchType: string;
  /** further conditions of an HTTPRoute match: `header x-canary: 1`, `method POST` */
  conditions?: string[];
  /** what the route does on the way: `redirect → https (301)`, `rewrite prefix → /` */
  filters?: string[];
  /** empty for a rule that only redirects */
  backends: RouteBackend[];
}

export interface RouteMap {
  entries: RouteEntry[];
  /** what could not be read (forbidden lists, Gateway API not installed, a cap) */
  notes?: string[];
  /** RFC 3339 */
  at: string;
}

export interface RoutesBackend {
  /** The HTTP routes of a namespace (or every namespace) and where each one ends. Only reads. */
  routeMap(req: RoutesRequest): Promise<RouteMap>;
}
