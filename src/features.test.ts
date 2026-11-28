// Integration audit: every feature registered together. Catches an action id that two features
// both register (registerActions replaces silently), a view kind nobody renders, and drift between
// what is built and what docs/frontend.md says is hidden.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registry } from "./actions/registry";
import { shellStore } from "./shell/slots";
import { viewDef } from "./views/registry";
import { NOT_BUILT_FEATURES, PENDING, PENDING_PREFIXES } from "./features.pending";
import type { ViewKind } from "./types";

const calls = new Map<string, number>();

beforeAll(async () => {
  const original = registry.register.bind(registry);
  vi.spyOn(registry, "register").mockImplementation((map) => {
    for (const [id, h] of Object.entries(map)) if (h) calls.set(id, (calls.get(id) ?? 0) + 1);
    return original(map);
  });
  await import("./ui/actions");
  await import("./store/settings-actions");
  await import("./panes/actions");
  const { registerFeatures } = await import("./features");
  registerFeatures();
});

const KINDS: ViewKind[] = [
  "table", "containers", "doc", "logs", "shell", "attach", "portforwards", "home", "settings", "aliases", "messages",
  // feature kinds (docs/plan-features.md §2.8), placeholders until their owners build them
  "traps", "agents", "why", "timeline", "diff", "patterns", "env", "devsets", "text", "relations", "reach", "hub", "deploys", "traffic", "database",
];

/** Actions that have no handler on purpose (docs/frontend.md §16). Anything else must be built. */
const NOT_BUILT = [
  "flux.notReady", "fav.layoutPrevious", "pane.fitToTable", "workload.setImage", "rs.rollback",
  "res.usedBy", "res.warp", "node.drain", "pod.transfer", "pod.sanitize", "flux.trace", "editor.replace",
  // handled inside the key engine
  "pane.leader",
];

/**
 * Feature actions of docs/plan-features.md §2.7 that are not built yet (src/features.pending.ts).
 * Their keymap rows arrive with A2; until then only ids the registry already knows are expected.
 */
const pendingKnown = (): string[] => {
  const known = new Set(registry.list().map((d) => d.id as string));
  return NOT_BUILT_FEATURES.filter((id) => known.has(id));
};

describe("features, integrated", () => {
  it("registers every action id exactly once on the registry", () => {
    const twice = [...calls].filter(([, n]) => n > 1).map(([id]) => id);
    expect(twice).toEqual([]);
  });

  it("has a view for every view kind", () => {
    expect(KINDS.filter((k) => !viewDef(k))).toEqual([]);
  });

  it("has unique overlay names", () => {
    const names = shellStore.getState().overlays.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("builds everything except the documented gaps", () => {
    const unbuilt = registry.list().filter((d) => !d.built && !d.alias).map((d) => d.id).sort();
    expect(unbuilt).toEqual([...NOT_BUILT, ...pendingKnown()].sort());
  });

  it("keeps the pending arrays disjoint and each id within its package", () => {
    const all = Object.values(PENDING).flat();
    expect(all.length).toBe(new Set(all).size);
    for (const [pkg, ids] of Object.entries(PENDING)) {
      const prefixes = PENDING_PREFIXES[pkg] ?? [];
      expect(ids.filter((id) => !prefixes.some((p) => id.startsWith(p))), pkg).toEqual([]);
    }
  });
});
