// Tauri mapping of DebugBackend (contract/debug.ts). Owner F; debug.rs.
import type { DebugBackend } from "../types";
import { call } from "./call";

export const debugTauri: DebugBackend = {
  debugContainer: (req) => call("debug_container", { req }),
  debugCopy: (objRef, image, target) => call("debug_copy", { objRef, image, target }),
  debugPodsList: (context) => call("debug_pods_list", { context }),
  debugPodDelete: (objRef) => call("debug_pod_delete", { objRef }),
  snippetRun: (req) => call("snippet_run", { req }),
};
