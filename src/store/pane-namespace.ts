// The namespace a pane "is in", for `:pods`, `:svc` … without a namespace argument (k9s keeps the
// namespace). A table has its own; a view about an object (logs, shell, why, env, timeline, doc …)
// uses that object's namespace; a view about nothing namespaced (hub, settings, a node's YAML …)
// falls back to the most recent namespaced view in the pane's history. Pure.
import type { ObjectRef, PaneId, ViewState, Workspace } from "../types";

const nsOf = (r: ObjectRef | undefined): string | undefined => r?.namespace || undefined;

/** One namespace shared by every ref, else undefined. */
function common(refs: readonly ObjectRef[]): string | undefined {
  const all = new Set(refs.map((r) => r.namespace).filter((n): n is string => !!n));
  return all.size === 1 ? [...all][0] : undefined;
}

/**
 * The namespace of one view; `"*"` for an all-namespaces table. `follow` resolves a
 * `paneSelection` target (the pane it follows), depth-limited by the caller.
 */
export function viewNamespace(v: ViewState | undefined, follow: (pane: PaneId) => string | undefined = () => undefined): string | undefined {
  if (!v) return undefined;
  switch (v.kind) {
    case "table":
      return v.namespace;
    case "containers":
      return nsOf(v.pod);
    case "doc":
    case "why":
    case "timeline":
    case "env":
    case "relations":
      return nsOf(v.ref);
    case "reach":
      return nsOf(v.from);
    case "diff":
      return "ref" in v.left ? nsOf(v.left.ref) : nsOf(v.left.revision.owner);
    case "logs":
    case "shell":
    case "attach": {
      const t = v.target;
      if (t.by === "object") return nsOf(t.ref);
      if (t.by === "selector") return t.namespace || undefined;
      if (t.by === "objects") return common(t.refs);
      return follow(t.pane);
    }
    case "text":
      return v.source.by === "pack" ? common(v.source.refs) : undefined;
    default:
      return undefined;
  }
}

/** The pane's namespace: its current view's, else the newest namespaced entry before it. */
export function paneNamespaceIn(ws: Workspace, pane: PaneId, depth = 0): string | undefined {
  const p = ws.panes[pane];
  if (!p) return undefined;
  const follow = (other: PaneId) => (depth < 2 && other !== pane ? paneNamespaceIn(ws, other, depth + 1) : undefined);
  const own = viewNamespace(p.history[p.index], follow);
  if (own) return own;
  for (let i = Math.min(p.index, p.history.length) - 1; i >= 0; i--) {
    const ns = viewNamespace(p.history[i], follow);
    if (ns) return ns;
  }
  return undefined;
}
