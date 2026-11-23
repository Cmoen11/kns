import { afterEach, describe, expect, it } from "vitest";
import { activityGroups, groupSection, layoutSections, registerActivityGroup, resetActivityGroups, type ActivityGroup, type SectionSpec } from "./groups";
import { headerKey, type PanelRow } from "./model";

const row = (key: string, section = "x"): PanelRow => ({ key, section, label: key });
const group = (id: string, order: number, rows: PanelRow[] = []): ActivityGroup => ({ id, label: id, order, useRows: () => ({ rows }) });

afterEach(() => resetActivityGroups());

describe("activity groups", () => {
  it("closes registration once the panel read the list", () => {
    registerActivityGroup(group("traps", 45));
    expect(activityGroups().map((g) => g.id)).toEqual(["traps"]);
    expect(() => registerActivityGroup(group("late", 50))).toThrow(/mounted/);
  });

  it("replaces a group with the same id and refuses built-in ids", () => {
    registerActivityGroup(group("traps", 45));
    registerActivityGroup(group("traps", 46));
    expect(activityGroups().map((g) => g.order)).toEqual([46]);
    resetActivityGroups();
    expect(() => registerActivityGroup(group("forwards", 1))).toThrow(/built-in/);
  });

  it("renders nothing for an empty group, and places groups by order", () => {
    const builtin: SectionSpec[] = [
      { id: "forwards", label: "Port-forwards", order: 10, items: [] },
      { id: "operations", label: "Operations", order: 100, items: [row("op1", "operations")] },
    ];
    const agent = group("agentRequests", 5, [row("p1")]);
    const empty = group("traps", 45);
    const agents = group("agents", 90, [row("claude")]);
    const specs = [...builtin, groupSection(agent, agent.useRows()), groupSection(empty, empty.useRows()), groupSection(agents, agents.useRows())];
    const out = layoutSections(specs, {}, headerKey);
    expect(out.filter((r) => r.header).map((r) => r.section)).toEqual(["agentRequests", "forwards", "agents", "operations"]);
    // the group's rows carry its id as their section, the header its count
    expect(out.find((r) => r.key === "p1")?.section).toBe("agentRequests");
    expect(out.find((r) => r.key === headerKey("agentRequests"))?.count).toBe(1);
    // a built-in section with no rows keeps its header
    expect(out.some((r) => r.key === headerKey("forwards"))).toBe(true);
  });

  it("folds a collapsed section to its header", () => {
    const g = group("agents", 90, [row("a"), row("b")]);
    const out = layoutSections([groupSection(g, g.useRows())], { agents: true }, headerKey);
    expect(out.map((r) => r.key)).toEqual([headerKey("agents")]);
  });
});
