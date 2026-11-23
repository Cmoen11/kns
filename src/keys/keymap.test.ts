import { describe, expect, it } from "vitest";
import { KEYMAP_ROWS } from "../actions/keymap-data";
import { createRegistry } from "../actions/registry";
import { isScopeId, knownSegments, SCOPES, tableScopes } from "../actions/scopes";
import { bindingKey, type Platform } from "./chord";
import { conflictsFor, createKeymap, findConflicts, sanitizeOverrides } from "./keymap";

const platforms: Platform[] = ["win", "mac"];

function fmt(c: ReturnType<typeof findConflicts>) {
  return c.map((x) => `${x.a} ~ ${x.b} on "${bindingKey(x.seq)}" (${x.kind}) in [${x.segment.join(" ")}]`);
}

describe("default keymap table", () => {
  it("builds: unique ids, valid scopes, valid chords, valid alias targets", () => {
    const registry = createRegistry();
    expect(registry.list().length).toBe(KEYMAP_ROWS.length);
    for (const d of registry.list()) {
      expect(d.built).toBe(false);
      expect(d.scopes.length).toBeGreaterThan(0);
      for (const s of d.scopes) expect(isScopeId(s)).toBe(true);
    }
  });

  it("gives every action a key or a command", () => {
    const registry = createRegistry();
    for (const d of registry.list()) {
      const reachable = d.win.length > 0 || d.mac.length > 0 || d.command !== undefined;
      expect(reachable, d.id).toBe(true);
    }
  });

  it("uses every scope in at least one known segment, and every scope is used by an action", () => {
    const inSegments = new Set(knownSegments().flat());
    const inRows = new Set(createRegistry().list().flatMap((d) => d.scopes));
    for (const s of SCOPES) {
      expect(inSegments.has(s), `scope ${s} is in no known segment`).toBe(true);
      // scopes that only tag a view for hints/when need no bindings of their own
      if (!["home", "aliases", "messages", "help", "menu"].includes(s)) {
        expect(inRows.has(s), `scope ${s} has no action`).toBe(true);
      }
    }
  });

  for (const platform of platforms) {
    for (const k9s of [false, true]) {
      it(`has no binding collisions within a scope segment (${platform}, k9s-mode ${k9s ? "on" : "off"})`, () => {
        const registry = createRegistry();
        const keymap = createKeymap(registry);
        keymap.setK9sMode(k9s);
        expect(fmt(findConflicts(keymap, platform))).toEqual([]);
      });
    }
  }

  it("the collision check catches a real collision", () => {
    const registry = createRegistry();
    const keymap = createKeymap(registry);
    keymap.setOverrides({ "res.yaml": { win: [["d"]] } });
    const found = findConflicts(keymap, "win");
    expect(found.some((c) => [c.a, c.b].sort().join() === "res.describe,res.yaml")).toBe(true);
    // and a prefix collision
    keymap.setOverrides({ "nav.top": { win: [["d", "d"]] } });
    expect(findConflicts(keymap, "win").some((c) => c.kind === "prefix" && c.a === "res.describe")).toBe(true);
  });

  it("does not report keys reused in disjoint scopes", () => {
    const registry = createRegistry();
    const keymap = createKeymap(registry);
    // `s` is shell on pods and scale on deployments
    expect(tableScopes({ resource: "pods", namespaced: true })).toContain("can.shell");
    expect(tableScopes({ resource: "pods", namespaced: true })).not.toContain("can.scale");
    expect(conflictsFor(keymap, registry, "logs.autoscroll", ["s"], "win")).toEqual([]);
  });

  it("conflictsFor names the action a new binding collides with", () => {
    const registry = createRegistry();
    const keymap = createKeymap(registry);
    const c = conflictsFor(keymap, registry, "res.yaml", ["d"], "win");
    expect(c.map((x) => (x.a === "res.yaml" ? x.b : x.a))).toContain("res.describe");
    expect(conflictsFor(keymap, registry, "res.yaml", ["leader", "r"], "win").length).toBeGreaterThan(0);
  });
});

describe("keymap layering", () => {
  it("expands the leader per platform", () => {
    const keymap = createKeymap(createRegistry());
    expect(keymap.display("pane.splitRight", "win")).toEqual([["Ctrl+.", "r"]]);
    expect(keymap.display("pane.splitRight", "mac")).toEqual([["Cmd+.", "r"]]);
    expect(keymap.display("pane.last", "win")).toEqual([["Ctrl+.", "Ctrl+."]]);
    expect(keymap.bindings("pane.splitRight", "win")).toEqual([["leader", "r"]]);
  });

  it("follows a rebound leader", () => {
    const keymap = createKeymap(createRegistry());
    keymap.setOverrides({ "pane.leader": { win: [["Ctrl+B"]] } });
    expect(keymap.leaders("win")).toEqual(["Ctrl+B"]);
    expect(keymap.display("pane.splitRight", "win")).toEqual([["Ctrl+B", "r"]]);
    expect(keymap.lookup("Ctrl+B", "win").length).toBeGreaterThan(10);
  });

  it("includes alias rows in an action's display bindings", () => {
    const keymap = createKeymap(createRegistry());
    expect(keymap.display("pane.next", "win").map(bindingKey)).toEqual(["F6", "Tab"]);
    expect(keymap.display("pane.zoom", "win").map(bindingKey)).toContain("f");
  });

  it("layers defaults < k9s preset < user overrides", () => {
    const keymap = createKeymap(createRegistry());
    expect(keymap.bindings("palette.open", "win").map(bindingKey)).toContain("Ctrl+K");
    keymap.setK9sMode(true);
    expect(keymap.bindings("palette.open", "win").map(bindingKey)).toEqual(["Ctrl+Shift+P", "leader p"]);
    expect(keymap.bindings("pod.kill", "win").map(bindingKey)).toContain("Ctrl+K");
    // macOS keeps Cmd+K next to the restored Ctrl+K
    expect(keymap.bindings("palette.open", "mac").map(bindingKey)).toContain("Cmd+K");
    keymap.setOverrides({ "palette.open": { win: [["F2"]] } });
    expect(keymap.bindings("palette.open", "win")).toEqual([["F2"]]);
    keymap.setOverrides({ "palette.open": { win: [] } });
    expect(keymap.bindings("palette.open", "win")).toEqual([]);
  });

  it("drops unknown ids and invalid chords from persisted overrides", () => {
    const registry = createRegistry();
    const clean = sanitizeOverrides(
      {
        "no.such.action": { win: [["x"]] },
        "res.yaml": { win: [["Shift+y"], ["Bogus+Q"], "nope", ["r", "leader"]], mac: "nope" },
        "res.edit": 42,
      },
      registry,
    );
    expect(clean).toEqual({ "res.yaml": { win: [["Y"]] } });
    expect(sanitizeOverrides(null, registry)).toEqual({});
  });
});
