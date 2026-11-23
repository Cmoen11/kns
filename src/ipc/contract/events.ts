// Backend -> UI events (docs/plan-features.md §2.2). Owner A1.
// Tauri: one event name, `kns://event`. Mock: src/ipc/mock/events.ts.
// Events are hints, not state: consumers re-list on boot and on each event.
import type { Unsubscribe } from "../types";
import type { AgentShowView, McpStatus } from "./agents";
import type { UpdateStatus } from "./update";

export type BackendEvent =
  /** re-list with proposalsList() */
  | { type: "proposals"; pending: number }
  | { type: "devSets"; context: string }
  | { type: "forwards" }
  | { type: "agentActivity"; client: string; tool: string; at: string; ok: boolean }
  | { type: "agentShow"; client: string; view: AgentShowView }
  | { type: "trapFired"; trapId: string; bundleId: string }
  | { type: "mcp"; status: McpStatus }
  | { type: "journal"; context: string; rows: number }
  /** auto-update state changed (contract/update.ts) */
  | { type: "update"; status: UpdateStatus };

export const BACKEND_EVENT = "kns://event";

export interface EventsBackend {
  onEvent(cb: (e: BackendEvent) => void): Unsubscribe;
}
