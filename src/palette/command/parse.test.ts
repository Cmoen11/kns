import { describe, expect, it } from "vitest";
import { complete, parseCommand, shadowedName, suggest, tokenize, type CommandSpec, type CompleteEnv } from "./parse";

const c = (phrase: string, id: string): CommandSpec => ({ words: phrase.split(" "), id });

const RESOURCES = ["pods", "po", "pod", "deployments", "deploy", "events", "ev", "namespaces", "ns", "helmreleases", "hr", "nodes", "no"];

const env: CompleteEnv = {
  commands: [
    c("ns", "namespace.pick"), c("ctx", "context.pick"), c("protect", "context.protect"),
    c("alias", "aliases.show"), c("home", "home.open"), c("pf", "pf.open"), c("errors", "messages.open"),
    c("flux!", "flux.notReady"), c("reconcile", "flux.reconcile"), c("reconcile source", "flux.reconcileWithSource"),
    c("split", "pane.splitRight"), c("split r", "pane.splitRight"), c("split d", "pane.splitDown"),
    c("close", "pane.close"), c("only", "pane.closeOthers"), c("zoom", "pane.zoom"), c("equal", "pane.equalize"),
    c("fav save", "fav.saveView"), c("layout save", "fav.saveLayout"),
    c("theme", "app.theme"), c("mode", "app.mode"), c("ui", "ui.zoom"), c("rows", "app.density"),
    c("ro", "app.readOnly"), c("kill", "app.killSwitch"), c("reconnect", "conn.reconnect"),
    c("keys", "settings.open"), c("keys reset", "keymap.resetAll"), c("q", "app.quit"),
  ],
  isResource: (a) => RESOURCES.includes(a),
  resources: RESOURCES,
  namespaces: ["default", "flux-system", "shop", "kube-system"],
  contexts: ["default", "staging"],
  favourites: ["warnings", "web pods"],
  layouts: ["triage", "work"],
};

const p = (s: string) => parseCommand(s, env);

describe("tokenize", () => {
  it("strips the colon and splits on whitespace", () => {
    expect(tokenize(":po  kube-system ")).toEqual(["po", "kube-system"]);
    expect(tokenize("  ")).toEqual([]);
  });
});

describe("parseCommand: resources", () => {
  it("resource by alias", () => {
    expect(p(":po")).toEqual({ type: "resource", alias: "po", filters: [] });
    expect(p("pod")).toEqual({ type: "resource", alias: "pod", filters: [] });
    expect(p(":Deploy")).toEqual({ type: "resource", alias: "deploy", filters: [] });
  });

  it("namespace argument", () => {
    expect(p(":po kube-system")).toEqual({ type: "resource", alias: "po", namespace: "kube-system", filters: [] });
    expect(p(":po all")).toMatchObject({ namespace: "*" });
    expect(p(":po -A")).toMatchObject({ namespace: "*" });
    expect(p(":po -n web")).toMatchObject({ namespace: "web" });
  });

  it("label selector", () => {
    expect(p(":pod app=x")).toEqual({ type: "resource", alias: "pod", filters: [{ mode: "label", selector: "app=x" }] });
    expect(p(":pod app=x,tier!=db")).toMatchObject({ filters: [{ mode: "label", selector: "app=x,tier!=db" }] });
    expect(p(":pod -l app")).toMatchObject({ filters: [{ mode: "label", selector: "app" }] });
  });

  it("regex, inverse and fuzzy filters", () => {
    expect(p(":pod /web-.*")).toMatchObject({ filters: [{ mode: "re", text: "web-.*" }] });
    expect(p(":pod /!web")).toMatchObject({ filters: [{ mode: "not", text: "web" }] });
    expect(p(":pod -f fz")).toMatchObject({ filters: [{ mode: "fuzzy", text: "fz" }] });
  });

  it("context argument", () => {
    expect(p(":pod @staging")).toEqual({ type: "resource", alias: "pod", filters: [], context: "staging" });
  });

  it("combines arguments in any order", () => {
    expect(p(":pod shop app=web /api -f x @staging")).toEqual({
      type: "resource", alias: "pod", namespace: "shop", context: "staging",
      filters: [{ mode: "label", selector: "app=web" }, { mode: "re", text: "api" }, { mode: "fuzzy", text: "x" }],
    });
  });

  it("reports malformed arguments", () => {
    expect(p(":pod a b")).toEqual({ type: "error", message: 'unexpected argument "b"' });
    expect(p(":pod -f")).toEqual({ type: "error", message: "-f needs a value" });
    expect(p(":pod @")).toMatchObject({ type: "error" });
    expect(p(":pod /")).toMatchObject({ type: "error" });
    expect(p(":pod @a @b")).toMatchObject({ type: "error" });
  });
});

describe("parseCommand: commands", () => {
  it("empty input", () => {
    expect(p(":")).toEqual({ type: "empty" });
    expect(p("")).toEqual({ type: "empty" });
  });

  it("a command wins over a resource with the same name", () => {
    expect(p(":ns")).toEqual({ type: "action", id: "namespace.pick", args: [] });
    expect(p(":ns kube-system")).toEqual({ type: "action", id: "namespace.pick", args: ["kube-system"] });
    expect(p(":ctx staging")).toEqual({ type: "action", id: "context.pick", args: ["staging"] });
  });

  it("views", () => {
    expect(p(":ev")).toEqual({ type: "resource", alias: "ev", filters: [] });
    expect(p(":pf")).toEqual({ type: "action", id: "pf.open", args: [] });
    expect(p(":alias")).toEqual({ type: "action", id: "aliases.show", args: [] });
    expect(p(":home")).toEqual({ type: "action", id: "home.open", args: [] });
    expect(p(":errors")).toEqual({ type: "action", id: "messages.open", args: [] });
    expect(p(":flux!")).toEqual({ type: "action", id: "flux.notReady", args: [] });
  });

  it("the longest phrase wins", () => {
    expect(p(":reconcile")).toEqual({ type: "action", id: "flux.reconcile", args: [] });
    expect(p(":reconcile source")).toEqual({ type: "action", id: "flux.reconcileWithSource", args: [] });
    expect(p(":keys")).toEqual({ type: "action", id: "settings.open", args: [] });
    expect(p(":keys reset")).toEqual({ type: "action", id: "keymap.resetAll", args: [] });
    expect(p(":split d")).toEqual({ type: "action", id: "pane.splitDown", args: [] });
    expect(p(":split")).toEqual({ type: "action", id: "pane.splitRight", args: [] });
    expect(p(":split down")).toEqual({ type: "action", id: "pane.splitRight", args: ["down"] });
  });

  it("pane, appearance and safety commands pass their arguments", () => {
    expect(p(":close")).toMatchObject({ id: "pane.close" });
    expect(p(":only")).toMatchObject({ id: "pane.closeOthers" });
    expect(p(":zoom")).toMatchObject({ id: "pane.zoom" });
    expect(p(":equal")).toMatchObject({ id: "pane.equalize" });
    expect(p(":theme claude")).toEqual({ type: "action", id: "app.theme", args: ["claude"] });
    expect(p(":mode mork")).toEqual({ type: "action", id: "app.mode", args: ["mork"] });
    expect(p(":ui 125")).toEqual({ type: "action", id: "ui.zoom", args: ["125"] });
    expect(p(":rows 28")).toEqual({ type: "action", id: "app.density", args: ["28"] });
    expect(p(":ro on")).toEqual({ type: "action", id: "app.readOnly", args: ["on"] });
    expect(p(":protect off")).toEqual({ type: "action", id: "context.protect", args: ["off"] });
    expect(p(":kill on")).toEqual({ type: "action", id: "app.killSwitch", args: ["on"] });
    expect(p(":reconnect")).toMatchObject({ id: "conn.reconnect" });
    expect(p(":q")).toMatchObject({ id: "app.quit" });
    expect(p(":Q")).toMatchObject({ id: "app.quit" });
  });

  it("favourites and layouts", () => {
    expect(p(":fav warnings")).toEqual({ type: "fav", name: "warnings" });
    expect(p(":fav web pods")).toEqual({ type: "fav", name: "web pods" });
    expect(p(":fav")).toEqual({ type: "fav", name: "" });
    expect(p(":fav save web 3")).toEqual({ type: "action", id: "fav.saveView", args: ["web", "3"] });
    expect(p(":layout triage")).toEqual({ type: "layout", name: "triage" });
    expect(p(":layout save triage 2")).toEqual({ type: "action", id: "fav.saveLayout", args: ["triage", "2"] });
  });

  it("unknown words are errors, and unbuilt commands are simply unknown", () => {
    expect(p(":nope")).toEqual({ type: "error", message: 'unknown command "nope"' });
    expect(parseCommand(":pf", { commands: [], isResource: () => false })).toMatchObject({ type: "error" });
  });
});

describe("completion", () => {
  it("completes the first word from commands, then resources", () => {
    expect(complete(":rec", env)).toBe("reconcile");
    expect(complete(":dep", env)).toBe("deployments");
    expect(complete(":p", env)).toBe("protect");
    expect(complete(":po", env)).toBe("pods");
    expect(complete(":lay", env)).toBe("layout");
  });

  it("returns null when nothing is longer than what was typed", () => {
    expect(complete(":pods", env)).toBeNull();
    expect(complete(":zzz", env)).toBeNull();
    expect(complete(":", env)).toBeNull();
    expect(complete(":po ", env)).toBeNull();
  });

  it("completes namespaces after a resource and after ns", () => {
    expect(complete(":po ku", env)).toBe("po kube-system");
    expect(complete(":ns fl", env)).toBe("ns flux-system");
    // one namespace only
    expect(complete(":po default sh", env)).toBeNull();
    expect(complete(":po app=x sh", env)).toBe("po app=x shop");
  });

  it("completes contexts after ctx and @", () => {
    expect(complete(":ctx st", env)).toBe("ctx staging");
    expect(complete(":pod @st", env)).toBe("pod @staging");
  });

  it("completes favourites, layouts, phrases and options", () => {
    expect(complete(":fav wa", env)).toBe("fav warnings");
    expect(complete(":fav s", env)).toBe("fav save");
    expect(complete(":layout tr", env)).toBe("layout triage");
    expect(complete(":keys r", env)).toBe("keys reset");
    expect(complete(":theme c", env)).toBe("theme claude");
    expect(complete(":ro o", env)).toBe("ro on");
    expect(complete(":ui 12", env)).toBe("ui 125");
  });

  it("keeps the typed stem and is case-insensitive on the word", () => {
    expect(complete("PO Ku", env)).toBe("PO kube-system");
  });

  it("suggest lists every match in order", () => {
    expect(suggest(":re", env)).toEqual(["reconcile", "reconnect"]);
    expect(suggest(":ns ", env)).toEqual([]);
  });
});

describe("collision rule: a built-in verb wins over a resource (plan-features §2.7)", () => {
  const withWhy: CompleteEnv = { ...env, commands: [...env.commands, c("why", "res.why")], isResource: (a) => a === "why" || a === "why.example.io" };
  it("resolves the verb first, the resource as name.group", () => {
    expect(parseCommand(":why", withWhy)).toEqual({ type: "action", id: "res.why", args: [] });
    expect(parseCommand(":why.example.io", withWhy)).toEqual({ type: "resource", alias: "why.example.io", filters: [] });
  });
  it("names a shadowed resource name.group", () => {
    const words = new Set(["why"]);
    expect(shadowedName("why", "example.io", words)).toBe("why.example.io");
    expect(shadowedName("pods", "", words)).toBe("pods");
    expect(shadowedName("whys", "example.io", words)).toBe("whys");
  });
});
