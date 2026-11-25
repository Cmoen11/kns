// Tauri mapping of TrafficBackend (contract/traffic.ts, traffic.rs).
import type { TrafficBackend } from "../types";
import { call } from "./call";

export const trafficTauri: TrafficBackend = {
  trafficSample: (req) => call("traffic_sample", { req }),
};
