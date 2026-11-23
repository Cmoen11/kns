// Feature F (docs/plan-features.md §3 F): debug container and debug copy, exec snippets, copy as
// kubectl, the mirrord command. Registers the actions (./actions, eager), the two lazy dialogs,
// the "Debug pods" activity group (order 46), the `snippet` text source, the hub status of the
// debug tool and the refined catalog entries of its four tools.
import { useEffect, useMemo } from "react";
import { registerOverlay, useCluster } from "../foundation";
import { registerTool, registerToolStatus, toolById, type ToolSpec } from "../hub/catalog";
import type { DebugPod } from "../ipc/types";
import { registerActivityGroup, type GroupRows } from "../sidepanels/groups";
import type { PanelRow } from "../sidepanels/model";
import { registerTextSource } from "../views/text";
import "./actions";
import "./debug.css";
import { DEBUG_OVERLAY, deleteAllCopies, deleteDebugCopy, openDebugShell, SNIPPET_OVERLAY, trackLastActions } from "./flows";
import { runDoc } from "./runs";
import { refreshDebugPods, useDebugPods } from "./store";

const NO_ROWS: GroupRows = { rows: [] };

function podRow(p: DebugPod): PanelRow {
  const copy = p.kind === "copy";
  return {
    key: `debug:${p.kind}:${p.namespace}/${p.name}/${p.container ?? ""}`,
    section: "debug",
    label: copy ? p.name : `${p.name} · ${p.container ?? "debug"}`,
    detail: copy ? `copy of ${p.source || "?"} · ${p.namespace} · x deletes` : `ephemeral · ${p.namespace} · goes away with the pod`,
    since: p.createdAt ? Date.parse(p.createdAt) || undefined : undefined,
    glyph: "ok",
    activate: () => openDebugShell(p),
    // ephemeral containers cannot be removed: no stop on their rows
    stop: copy ? () => deleteDebugCopy(p) : undefined,
  };
}

/** Activity "Debug pods": listed when the context changes and after each debug action; no polling. */
function useDebugRows(): GroupRows {
  const context = useCluster((s) => (s.status === "connected" ? s.context : null));
  useEffect(() => {
    void refreshDebugPods(context);
  }, [context]);
  const pods = useDebugPods((s) => (s.context === context ? s.pods : null));
  return useMemo(() => {
    if (!pods || pods.length === 0) return NO_ROWS;
    const copies = pods.filter((p) => p.kind === "copy");
    return { rows: pods.map(podRow), stopAll: copies.length ? () => deleteAllCopies(pods) : undefined };
  }, [pods]);
}

/** Better help now that the tools work; ids, actions and try stay as the catalog has them. */
function refine(id: "debug" | "snippets" | "kubectl" | "mirrord", patch: Partial<ToolSpec>): void {
  const t = toolById(id);
  if (!t) return;
  const { built: _built, ...rest } = t;
  registerTool({ ...rest, ...patch });
}

export function register(): void {
  registerOverlay(DEBUG_OVERLAY, () => import("./DebugDialog"));
  registerOverlay(SNIPPET_OVERLAY, () => import("./SnippetDialog"));
  registerActivityGroup({ id: "debug", label: "Debug pods", order: 46, useRows: useDebugRows });
  registerTextSource("snippet", (src) => Promise.resolve(runDoc(src.runId)));
  registerToolStatus("debug", () => {
    const n = useDebugPods((s) => s.pods.length);
    return n > 0 ? { text: `${n} debug pod${n === 1 ? "" : "s"}`, state: "active" } : null;
  });
  trackLastActions();

  refine("debug", {
    summary: "Attach a debug container with tools to a running pod, or debug a sleeping copy",
    help: {
      answers: "`B` adds an ephemeral container (busybox or netshoot) that shares the target container's processes and opens a shell in it. `:debug copy` makes a sleeping copy of the pod instead, for a container that crashes before you can look.",
      notFor: "Changing the running workload: the copy has no labels, so no Service or ReplicaSet uses it.",
      safety: "A cluster write (tier 2 on protected contexts, refused read-only). Ephemeral containers cannot be removed until the pod goes; copies are deleted from Activity → Debug pods or after 1 h.",
      example: "`B` on a `web` pod in kns-spike, pick netshoot, then `ps` shows nginx.",
    },
  });
  refine("snippets", {
    summary: "Run a saved command in a pod (env, psql, redis-cli, kafka) and read the output",
    help: {
      answers: "`:x` lists the snippets that fit the container's image and runs one as a single exec; `:x env` runs one by name. The output opens as text with secret-looking values masked.",
      notFor: "Interactive work: open a shell (`s`) for that.",
      safety: "Runs as an exec (`create pods/exec`). Output is redacted in Rust before kns shows it.",
      example: "`:x save topics kafka-topics.sh --bootstrap-server localhost:9092 --list`, then `:x topics` on a broker pod.",
    },
    commands: [":x", ":x <name>", ":x save <name> <command>", ":x rm <name>"],
  });
  refine("kubectl", {
    help: {
      answers: "Copies the kubectl command for the last thing you did on the cursor row (restart, scale, delete, logs, debug), else for the focused view (get, describe, logs, exec), with `--context` and `-n` spelled out.",
      notFor: "Running it: kns only copies the text.",
    },
  });
  refine("mirrord", {
    summary: "Copy the mirrord command that runs a local process as this pod",
    help: {
      answers: "Copies `mirrord exec --context <ctx> --target pod/<name> --target-namespace <ns> -- YOUR_COMMAND`; `:mirrord npm run dev` fills in the command.",
      notFor: "Starting mirrord: kns never runs it.",
      safety: "Nothing happens in the cluster until you run the command yourself.",
    },
    commands: [":mirrord", ":mirrord <command>"],
  });
}
