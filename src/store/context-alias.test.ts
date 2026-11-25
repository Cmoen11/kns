// Context aliases (docs/ux.md §8.2): a display name kept in settings, accepted wherever a context
// is typed, never one that could mean two contexts.
import { beforeAll, describe, expect, it } from "vitest";
import { aliasProblem, contextByName, contextName, sanitizeSettings, setContextAlias, settingsStore } from "./settings";
import { layoutStore, moveTab, openTabs, setLayoutContext } from "./layout";

const CONTEXTS = ["arn:aws:eks:eu-west-1:123:cluster/prod-main", "staging", "dev"];
const PROD = CONTEXTS[0];

beforeAll(async () => {
  await settingsStore.hydrated;
  await layoutStore.hydrated;
});

describe("context aliases", () => {
  it("are stored trimmed, and dropped when empty or the context's own name", () => {
    const s = sanitizeSettings({ contexts: { a: { alias: "  prod " }, b: { alias: "" }, c: { alias: "c" }, d: { alias: 3 } } });
    expect(s.contexts.a.alias).toBe("prod");
    expect(s.contexts.b.alias).toBeUndefined();
    expect(s.contexts.c.alias).toBeUndefined();
    expect(s.contexts.d.alias).toBeUndefined();
  });

  it("name the context everywhere and resolve back to it", () => {
    setContextAlias(PROD, "prod");
    expect(contextName(PROD)).toBe("prod");
    expect(contextName("staging")).toBe("staging");
    expect(contextByName("prod", CONTEXTS)).toBe(PROD);
    expect(contextByName("PROD", CONTEXTS)).toBe(PROD);
    expect(contextByName(PROD, CONTEXTS)).toBe(PROD);
    expect(contextByName("nope", CONTEXTS)).toBeNull();
  });

  it("never mean two contexts", () => {
    expect(aliasProblem("dev", "prod", CONTEXTS)).toMatch(/already has this alias/);
    expect(aliasProblem("dev", "Staging", CONTEXTS)).toMatch(/another context/);
    expect(aliasProblem("dev", "my dev", CONTEXTS)).toMatch(/no spaces/);
    expect(aliasProblem("dev", "@x", CONTEXTS)).not.toBeNull();
    expect(aliasProblem("dev", "x".repeat(41), CONTEXTS)).toMatch(/at most/);
    expect(aliasProblem(PROD, "prod", CONTEXTS)).toBeNull();
    expect(aliasProblem("dev", "", CONTEXTS)).toBeNull();
  });

  it("clear with an empty alias", () => {
    setContextAlias(PROD, "");
    expect(contextName(PROD)).toBe(PROD);
  });
});

describe("tab order", () => {
  it("moves a tab by dragging", () => {
    for (const c of ["a", "b", "c"]) setLayoutContext(c, 1440);
    expect(openTabs()).toEqual(["a", "b", "c"]);
    moveTab("c", 0);
    expect(openTabs()).toEqual(["c", "a", "b"]);
    moveTab("c", 99);
    expect(openTabs()).toEqual(["a", "b", "c"]);
  });
});
