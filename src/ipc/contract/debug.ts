// Debug containers, debug copies and exec snippets (docs/plan-features.md §3 F). Owner F.
// Mirror: src-tauri/src/contract/debug.rs. None of this is exposed to agents (MCP).
import type { ObjRef } from "../types";
import type { RedactionReport } from "./pack";

export interface DebugRequest {
  /** the pod */
  ref: ObjRef;
  /** full image reference */
  image: string;
  /** container whose process namespace the debug container shares */
  target?: string;
}

export interface DebugPod {
  context: string;
  namespace: string;
  name: string;
  /** the pod it was made from */
  source: string;
  kind: "ephemeral" | "copy";
  /** ephemeral: the debug container's name; copy: the container a shell opens in */
  container?: string;
  /** RFC3339 */
  createdAt: string;
}

/** One exec snippet run: `sh -c <command>` in a container, no TTY, no stdin. */
export interface SnippetRunRequest {
  /** the pod */
  ref: ObjRef;
  container?: string;
  /** passed to `sh -c` as one argument */
  command: string;
  /** default 30, at most 120 */
  timeoutSeconds?: number;
}

/** Output of a snippet run: stdout and stderr merged in arrival order, cleaned and redacted in Rust. */
export interface SnippetOutput {
  output: string;
  /** absent when the process gave no exit status (killed, timed out, connection lost) */
  exitCode?: number;
  /** why there is no exit code, or a failure to start the command */
  message?: string;
  /** output was cut at the byte cap (256 KiB) or the timeout */
  truncated: boolean;
  millis: number;
  redactions: RedactionReport;
}

export interface DebugBackend {
  /** Adds an ephemeral container and waits until it runs; returns its name. */
  debugContainer(req: DebugRequest): Promise<string>;
  /** A sleeping copy of the pod (labels dropped, probes removed, 1 h deadline). */
  debugCopy(ref: ObjRef, image?: string, target?: string): Promise<DebugPod>;
  debugPodsList(context: string): Promise<DebugPod[]>;
  /** Deletes a debug copy; refuses any pod without the `kns.dev/debug=true` label. */
  debugPodDelete(ref: ObjRef): Promise<void>;
  /** Runs one snippet and returns its redacted output. */
  snippetRun(req: SnippetRunRequest): Promise<SnippetOutput>;
}
