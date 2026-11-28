// Tauri mapping of RoutesBackend (contract/routes.ts, routes.rs).
import type { RoutesBackend } from "../types";
import { call } from "./call";

export const routesTauri: RoutesBackend = {
  routeMap: (req) => call("route_map", { req }),
};
