// The catalog as the hub shows it: every feature registered, so refinements made with registerTool
// from other packages' register() are checked too (src/hub/catalog.test.ts checks the static
// entries). Plus the getting-started paths and the things the hub and docs/tools.md must not promise.
import { beforeAll, describe, expect, it } from "vitest";
import toolsMd from "../../docs/tools.md?raw";
import { KEYMAP_ROWS } from "../actions/keymap-data";
import { registry } from "../actions/registry";
import { parseCommand, type CommandSpec } from "../palette/command/parse";
import { STATUS_BY, STATUSLESS, TOOL_GROUPS, TOOLS, toolById, toolForView } from "./catalog";
import { TOOL_EXTRAS } from "./extras";
import { GUIDES, guideById, guideForTool } from "./guides";
import { docAnchor, docAnchors } from "./model";
import { hubTarget } from "./actions";

beforeAll(async () => {
  await import("../ui/actions");
  await import("../store/settings-actions");
  await import("../panes/actions");
  const { registerFeatures } = await import("../features");
  registerFeatures();
});

const rowIds = new Set(KEYMAP_ROWS.map((r) => r.id as string));
const commands: CommandSpec[] = KEYMAP_ROWS.filter((r) => r.command).map((r) => ({ words: r.command!.split(" "), id: r.id }));
const parses = (line: string) => parseCommand(line, { commands, isResource: () => false }).type === "action";
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;
const anchors = new Set(docAnchors(toolsMd));
describe("effective catalog (after every register())", () => {
  it("keeps every entry well formed", () => {
    for (const t of TOOLS) {
      expect(t.summary.length, t.id).toBeLessThanOrEqual(80);
      expect(TOOL_GROUPS, t.id).toContain(t.group);
      for (const text of Object.values(t.help)) expect(sentences(text ?? ""), `${t.id}: ${text}`).toBeLessThanOrEqual(4);
      expect(t.actions.filter((a) => !rowIds.has(a)), t.id).toEqual([]);
      if (t.try) expect(rowIds.has(t.try.action), `${t.id} try`).toBe(true);
      for (const line of t.commands) expect(parses(line), `${t.id}: ${line}`).toBe(true);
      expect(anchors.has(docAnchor(t.doc)), `${t.id} doc`).toBe(true);
    }
  });

  it("has every built tool startable: an action, a how line, or a try", () => {
    for (const t of TOOLS.filter((x) => x.built())) {
      const startable = t.actions.some((a) => registry.get(a)?.built) || !!TOOL_EXTRAS[t.id]?.how || !!t.try;
      expect(startable, t.id).toBe(true);
    }
  });

  it("gives every built tool a Try or says why not", () => {
    for (const t of TOOLS.filter((x) => x.built())) {
      expect(!!t.try || !!TOOL_EXTRAS[t.id]?.noTry, t.id).toBe(true);
      if (t.try) expect(registry.get(t.try.action)?.built, `${t.id}: ${t.try.action}`).toBe(true);
    }
  });

  it("reports status for every tool or lists it as statusless", () => {
    for (const t of TOOLS) expect(STATUSLESS.has(t.id) || !!STATUS_BY[t.id], t.id).toBe(true);
  });

  it("finds the tool of a text view by its source", () => {
    expect(toolForView({ kind: "text", title: "x", source: { by: "pack", refs: [] } })?.id).toBe("pack");
    expect(toolForView({ kind: "text", title: "x", source: { by: "snippet", runId: "r1" } })?.id).toBe("snippets");
    expect(toolForView({ kind: "text", title: "x", source: { by: "bundle", id: "b1" } })?.id).toBe("trap");
    expect(toolForView({ kind: "text", title: "x", source: { by: "doc", anchor: "why" } })).toBeUndefined();
    expect(hubTarget(undefined, { kind: "text", title: "x", source: { by: "pack", refs: [] } })).toEqual({ tool: "pack" });
  });
});

describe("getting-started paths", () => {
  it("live on built entries and run only built actions; their commands parse", () => {
    for (const g of GUIDES) {
      expect(toolById(g.tool)?.built(), g.id).toBe(true);
      expect(guideForTool(g.tool)?.id).toBe(g.id);
      expect(anchors.has(g.id), `${g.id} doc anchor`).toBe(true);
      expect(g.steps.length).toBeGreaterThanOrEqual(4);
      for (const s of g.steps) {
        if (s.run) expect(registry.get(s.run.action)?.built, `${g.id}: ${s.run.action}`).toBe(true);
        if (s.command) expect(parses(s.command), `${g.id}: ${s.command}`).toBe(true);
        expect(sentences(s.body), `${g.id}: ${s.title}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it("opens from :tools <guide id>", () => {
    expect(hubTarget("start-local-dev", undefined)).toEqual({ tool: "env" });
    expect(hubTarget("start-agent", undefined)).toEqual({ tool: "mcp" });
    expect(guideById("nope")).toBeUndefined();
  });

  it("only opens dialogs for steps that would change something", () => {
    const writing = new Set(["agents.connect", "env.saveSet", "env.export", "dev.up", "pod.debug", "res.trap"]);
    for (const g of GUIDES) for (const s of g.steps) if (s.run && writing.has(s.run.action)) expect(s.run.writes, `${g.id}: ${s.run.action}`).toBe(true);
  });
});

describe("no promises for what was left out", () => {
  // C2: follow and changing the window inside the timeline; G: packing selected text; F: snippet output into a shell pane
  const texts = [
    toolsMd,
    ...TOOLS.map((t) => [t.summary, ...Object.values(t.help)].join(" ")),
    ...GUIDES.flatMap((g) => g.steps.map((s) => s.body)),
  ].join("\n").toLowerCase();

  it("does not offer them", () => {
    expect(texts).not.toMatch(/selected text|selection of (the )?text|select(ed)? lines? (to|and) pack/);
    expect(texts).not.toMatch(/(output|snippet)[^.\n]{0,40}(into|to) (a|the) shell( pane)?/);
    expect(texts).not.toMatch(/timeline[^.\n]{0,80}leader f|leader f[^.\n]{0,80}timeline/);
  });
});
