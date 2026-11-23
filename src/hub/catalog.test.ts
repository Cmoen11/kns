import { describe, expect, it } from "vitest";
import { KEYMAP_ROWS } from "../actions/keymap-data";
import { builtCommandWords, parseCommand, type CommandSpec } from "../palette/command/parse";
import { isToolId, setToolBuilt, TOOL_GROUPS, toolById, toolForKind, TOOLS } from "./catalog";
import { hubTarget } from "./index";

const ALL_IDS = [
  "palette", "panes", "logs", "shell", "describe-edit", "port-forward", "favourites", "filter",
  "why", "crash", "timeline", "journal", "trap", "sparklines", "reach", "relations", "rollout",
  "diff", "owners", "logs-merged", "logs-structured", "logs-patterns", "debug", "snippets", "kubectl",
  "devsets", "env", "names", "conn-string", "mirrord", "pack", "mcp", "proposals",
  "ns-health", "action-log", "status-colors",
];

const rowIds = new Set(KEYMAP_ROWS.map((r) => r.id as string));
// every command phrase of the keymap, built or not: the catalog names commands before they exist
const commands: CommandSpec[] = KEYMAP_ROWS.filter((r) => r.command).map((r) => ({ words: r.command!.split(" "), id: r.id }));
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;

describe("tools catalog", () => {
  it("has one entry per ToolId", () => {
    expect(TOOLS.map((t) => t.id).sort()).toEqual([...ALL_IDS].sort());
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
  });

  it("keeps summaries short and help structured", () => {
    for (const t of TOOLS) {
      expect(t.summary.length, t.id).toBeLessThanOrEqual(80);
      expect(TOOL_GROUPS).toContain(t.group);
      for (const text of Object.values(t.help)) expect(sentences(text ?? ""), `${t.id}: ${text}`).toBeLessThanOrEqual(4);
      expect(t.doc).toBe(`docs/tools.md#${t.id}`);
    }
  });

  it("names only actions of the keymap", () => {
    for (const t of TOOLS) {
      expect(t.actions.filter((a) => !rowIds.has(a)), t.id).toEqual([]);
      if (t.try) expect(rowIds.has(t.try.action), t.id).toBe(true);
    }
  });

  it("names commands that parse as actions in the : resolver", () => {
    for (const t of TOOLS) {
      for (const line of t.commands) {
        const cmd = parseCommand(line, { commands, isResource: () => false });
        expect(cmd.type, `${t.id}: ${line}`).toBe("action");
      }
    }
  });

  it("marks writing tools so Try only opens their dialog", () => {
    expect(toolById("debug")?.try?.writes).toBe(true);
    expect(toolById("trap")?.try?.writes).toBe(true);
    expect(toolById("why")?.try?.writes).toBeUndefined();
  });

  it("knows which tool a view kind belongs to", () => {
    expect(toolForKind("why")?.id).toBe("why");
    expect(toolForKind("agents")?.id).toBe("mcp");
    expect(toolForKind("table")).toBeUndefined();
  });

  it("reports tools without an action of their own as built by flag", () => {
    expect(toolById("crash")?.built()).toBe(false);
    setToolBuilt("crash");
    expect(toolById("crash")?.built()).toBe(true);
    setToolBuilt("crash", false);
    expect(isToolId("crash")).toBe(true);
    expect(isToolId("nope")).toBe(false);
  });
});

describe("hub.open target", () => {
  it("opens the named tool, or the tool of the focused view", () => {
    expect(hubTarget("why", "table")).toEqual({ tool: "why" });
    expect(hubTarget(undefined, "diff")).toEqual({ tool: "diff" });
    expect(hubTarget(undefined, "table")).toEqual({});
    expect(hubTarget("nope", undefined).error).toMatch(/no tool/);
  });
});

describe("command words shadow resources", () => {
  it("lists built command words only", () => {
    const words = builtCommandWords([
      { command: "why", built: true },
      { command: "env", built: false },
      { command: "split r", built: true },
    ]);
    expect(words.has("why")).toBe(true);
    expect(words.has("env")).toBe(false);
    expect(words.has("split")).toBe(true);
    expect(words.has("fav")).toBe(true);
  });
});
