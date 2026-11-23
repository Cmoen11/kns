import { describe, expect, it } from "vitest";
import { createRegistry, type ActionContext } from "../actions/registry";
import type { ViewKind } from "../types";
import { createViewActions } from "./view-actions";

const ctx = (id: string) => ({ id, source: "key", newPane: null, args: [], repeat: false }) as unknown as ActionContext;

function setup() {
  const registry = createRegistry();
  let kind: ViewKind | undefined = "table";
  const actions = createViewActions(registry, () => kind);
  return { registry, actions, setKind: (k: ViewKind | undefined) => (kind = k) };
}

describe("registerViewActions", () => {
  it("lets two features implement the same action id for their own view kinds", () => {
    const { registry, actions, setKind } = setup();
    const ran: string[] = [];
    actions.register(["table", "containers"], { "nav.down": () => void ran.push("table") });
    actions.register(["home", "aliases"], { "nav.down": () => void ran.push("tools") });
    expect(registry.get("nav.down")!.built).toBe(true);
    const h = registry.handler("nav.down")!;
    h.run(ctx("nav.down"));
    setKind("home");
    h.run(ctx("nav.down"));
    setKind("containers");
    h.run(ctx("nav.down"));
    expect(ran).toEqual(["table", "tools", "table"]);
  });

  it("is absent for kinds without a handler and forwards when/enabled of the active one", () => {
    const { registry, actions, setKind } = setup();
    let rows = 0;
    actions.register(["table"], { "nav.open": { run: () => undefined, enabled: () => rows > 0 || "no row selected", when: () => rows >= 0 } });
    const h = registry.handler("nav.open")!;
    expect(h.when!(ctx("nav.open"))).toBe(true);
    expect(h.enabled!(ctx("nav.open"))).toBe("no row selected");
    rows = 1;
    expect(h.enabled!(ctx("nav.open"))).toBe(true);
    rows = -1;
    expect(h.when!(ctx("nav.open"))).toBe(false);
    setKind("logs");
    expect(h.when!(ctx("nav.open"))).toBe(false);
    setKind(undefined);
    expect(h.when!(ctx("nav.open"))).toBe(false);
  });

  it("unregisters per feature and un-builds the action when the last kind leaves", () => {
    const { registry, actions, setKind } = setup();
    const ran: string[] = [];
    const offTable = actions.register(["table"], { "nav.up": () => void ran.push("table") });
    const offLogs = actions.register(["logs"], { "nav.up": () => void ran.push("logs") });
    offTable();
    expect(registry.get("nav.up")!.built).toBe(true);
    expect(registry.handler("nav.up")!.when!(ctx("nav.up"))).toBe(false);
    setKind("logs");
    registry.handler("nav.up")!.run(ctx("nav.up"));
    expect(ran).toEqual(["logs"]);
    offLogs();
    expect(registry.get("nav.up")!.built).toBe(false);
  });

  it("rejects unknown ids like registerActions does", () => {
    const { actions } = setup();
    expect(() => actions.register(["table"], { "nope.nothing": () => undefined } as never)).toThrow();
  });
});
