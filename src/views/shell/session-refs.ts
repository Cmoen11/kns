// Which exec sessions a workspace still refers to (pure). A session lives exactly as long as some
// pane's history holds its id; panes on the reopen stack (`closed`) do not count (§4.6).
import type { PaneId, ViewState, Workspace } from "../../types";

export interface SessionRefs {
  /** every id in any open pane's history */
  all: Set<string>;
  /** id -> the pane whose current entry shows it */
  current: Map<string, PaneId>;
}

export const isShellView = (v: ViewState | undefined): v is Extract<ViewState, { kind: "shell" | "attach" }> =>
  !!v && (v.kind === "shell" || v.kind === "attach");

export function sessionRefs(ws: Pick<Workspace, "panes"> | null): SessionRefs {
  const all = new Set<string>();
  const current = new Map<string, PaneId>();
  if (!ws) return { all, current };
  for (const [pane, p] of Object.entries(ws.panes)) {
    for (let i = 0; i < p.history.length; i++) {
      const v = p.history[i];
      if (!isShellView(v) || !v.session) continue;
      all.add(v.session);
      if (i === p.index) current.set(v.session, pane);
    }
  }
  return { all, current };
}

/** Containers a shell can start in, picker order: containers, ephemeral, then init (sidecars). */
export interface ContainerOption {
  name: string;
  group: "container" | "ephemeral" | "init";
}

export function containerOptions(pod: { containers: readonly string[]; initContainers: readonly string[]; ephemeralContainers: readonly string[] }): ContainerOption[] {
  return [
    ...pod.containers.map((name): ContainerOption => ({ name, group: "container" })),
    ...pod.ephemeralContainers.map((name): ContainerOption => ({ name, group: "ephemeral" })),
    ...pod.initContainers.map((name): ContainerOption => ({ name, group: "init" })),
  ];
}

/**
 * §13.4 "with several containers the picker appears first": the picker is needed when the pod has
 * more than one regular or ephemeral container. Init containers alone never trigger it.
 */
export function needsContainerPicker(options: readonly ContainerOption[]): boolean {
  return options.filter((o) => o.group !== "init").length > 1;
}
