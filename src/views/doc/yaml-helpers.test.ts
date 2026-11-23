import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MARK_MINE, MARK_SEP, MARK_THEIRS, conflictMarkerLines, diffLines, merge3 } from "./merge3";
import { findMatches, matchAtOrAfter, stepMatch } from "./search-match";
import {
  MASK, classifyConflict, errorLines, fieldPaths, fluxOwner, maskSecretPair, parseSecretEdit, secretDoc, secretManifest,
  stripManagedFields, toBase64, toJsonText, yamlSyntaxError,
} from "./yaml-helpers";

const YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  uid: 1f0c-22
  labels:
    kustomize.toolkit.fluxcd.io/name: apps
    kustomize.toolkit.fluxcd.io/namespace: flux-system
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: main
          image: web:1
        - name: sidecar
          image: busybox
`;

describe("error lines", () => {
  it("extracts field paths from API messages", () => {
    expect(fieldPaths('Deployment.apps "web" is invalid: spec.template.spec.containers[1].image: Required value')).toContainEqual([
      "spec", "template", "spec", "containers", 1, "image",
    ]);
    expect(fieldPaths(".spec.replicas: expected numeric")).toEqual([["spec", "replicas"]]);
  });

  it("maps a field path to the line of its key", () => {
    expect(errorLines(YAML, 'Deployment.apps "web" is invalid: spec.template.spec.containers[1].image: Required value')).toEqual([17]);
    expect(errorLines(YAML, ".spec.replicas: expected numeric (int or float), got string")).toEqual([10]);
  });

  it("falls back to the deepest existing parent", () => {
    expect(errorLines(YAML, "spec.template.spec.containers[0].ports[0].containerPort: Required value")).toEqual([14]);
    expect(errorLines(YAML, 'unknown field "spec.replicass"')).toEqual([9]);
  });

  it("ignores paths that do not start at a top-level key and honours explicit lines", () => {
    expect(errorLines(YAML, 'pods "web" is forbidden: User "x" cannot patch resource in API group "apps.k8s.io"')).toEqual([]);
    expect(errorLines(YAML, "error converting YAML to JSON: yaml: line 4: mapping values are not allowed")).toEqual([4]);
    expect(errorLines(YAML, "yaml: line 400: nope")).toEqual([]);
  });

  it("reports the first syntax error with its line", () => {
    expect(yamlSyntaxError(YAML)).toBeNull();
    const e = yamlSyntaxError("a: 1\nb: [1, 2\nc: 3\n");
    expect(e).not.toBeNull();
    expect(e!.line).toBeGreaterThanOrEqual(2);
    expect(e!.message).not.toContain("\n");
  });
});

describe("object helpers", () => {
  it("strips managedFields without mutating", () => {
    const obj = { metadata: { name: "a", managedFields: [{ manager: "x" }] }, spec: {} };
    expect(stripManagedFields(obj)).toEqual({ metadata: { name: "a" }, spec: {} });
    expect(obj.metadata.managedFields).toHaveLength(1);
    expect(toJsonText(obj, false)).not.toContain("managedFields");
    expect(toJsonText(obj, true)).toContain("managedFields");
    expect(stripManagedFields(null)).toBeNull();
  });

  it("finds the Flux owner", () => {
    expect(fluxOwner(YAML)).toEqual({ resource: "kustomizations", name: "apps", namespace: "flux-system" });
    expect(fluxOwner("metadata:\n  labels:\n    helm.toolkit.fluxcd.io/name: r\n    helm.toolkit.fluxcd.io/namespace: ns\n")).toEqual({
      resource: "helmreleases", name: "r", namespace: "ns",
    });
    expect(fluxOwner("metadata:\n  name: x\n")).toBeNull();
    expect(fluxOwner("a: [")).toBeNull();
  });

  it("classifies conflicts", () => {
    expect(classifyConflict({ code: 409, reason: "Conflict", message: 'Apply failed with 1 conflict: conflict with "kubectl": .spec.replicas' })).toBe("fieldManager");
    expect(classifyConflict({ code: 409, reason: "Conflict", message: "the object has been modified; please apply your changes to the latest version" })).toBe("version");
    expect(classifyConflict({ code: 422, reason: "Invalid", message: "spec.replicas: Invalid value" })).toBeNull();
    expect(classifyConflict(new Error("x"))).toBeNull();
  });
});

describe("secrets", () => {
  const decoded = { password: "s3cr3t", "tls.crt": null, config: "a: 1\nb: 2\n" };

  it("masks values and never shows binary ones", () => {
    const d = secretDoc(decoded, new Set());
    expect(d.text).not.toContain("s3cr3t");
    expect(d.text).toContain(`password: ${MASK}`);
    expect(d.text).toContain("tls.crt: binary, locked");
    expect(d.keyOfLine).toEqual(["config", "password", "tls.crt"]);
  });

  it("reveals single keys and maps every line of a multi-line value to its key", () => {
    const d = secretDoc(decoded, new Set(["config"]));
    expect(d.text).toContain("a: 1");
    expect(d.text).not.toContain("s3cr3t");
    expect(d.keyOfLine.filter((k) => k === "config").length).toBeGreaterThan(1);
    expect(d.text.split("\n").length - 1).toBe(d.keyOfLine.length);
    expect(secretDoc(decoded, "all").text).toContain("s3cr3t");
  });

  it("round-trips the edit document, with binary keys as comments", () => {
    const text = secretDoc(decoded, "all", { edit: true }).text;
    expect(text).toContain("# tls.crt: binary, locked");
    expect(parseSecretEdit(text)).toEqual({ password: "s3cr3t", config: "a: 1\nb: 2\n" });
    expect(parseSecretEdit("")).toEqual({});
    expect(parseSecretEdit("n: 5\nb: true\n")).toEqual({ n: "5", b: "true" });
  });

  it("keeps typed values verbatim: no number, null or precision coercion", () => {
    expect(parseSecretEdit("pin: 0123\nver: 1.0\ntoken: 12345678901234567890\nnothing: null\nempty:\nquoted: \"007\"\n")).toEqual({
      pin: "0123", ver: "1.0", token: "12345678901234567890", nothing: "null", empty: "", quoted: "007",
    });
    // what the edit document shows for such values parses back to the same strings
    const tricky = { pin: "0123", ver: "1.0", yes: "true", nil: "null", multi: "a\n b\n", lead: " x" };
    expect(parseSecretEdit(secretDoc(tricky, "all", { edit: true }).text)).toEqual(tricky);
  });

  it("rejects nested values with the line", () => {
    expect(() => parseSecretEdit("a: x\nb:\n  c: 1\n")).toThrowError(/must be a string/);
    try {
      parseSecretEdit("a: x\nb:\n  c: 1\n");
    } catch (e) {
      expect((e as { line: number }).line).toBe(2);
    }
  });

  it("builds the manifest: edited values re-encoded, binary kept, identity kept", () => {
    const obj = {
      apiVersion: "v1", kind: "Secret", type: "kubernetes.io/tls",
      metadata: { name: "db", namespace: "shop", uid: "u", resourceVersion: "9", labels: { app: "db" }, managedFields: [] },
      data: { password: "b2xk", "tls.crt": "AAEC", gone: "eA==" },
    };
    const out = parse(secretManifest(obj, { password: "nytt ø" }, { password: "old", "tls.crt": null, gone: "x" })) as Record<string, unknown>;
    expect(out.metadata).toEqual({ name: "db", namespace: "shop", labels: { app: "db" } });
    expect(out.type).toBe("kubernetes.io/tls");
    expect(out.data).toEqual({ password: toBase64("nytt ø"), "tls.crt": "AAEC" });
    expect(atob(toBase64("abc"))).toBe("abc");
    expect(new TextDecoder().decode(Uint8Array.from(atob(toBase64("nytt ø")), (c) => c.charCodeAt(0)))).toBe("nytt ø");
  });

  it("masks a diff but still shows which keys change", () => {
    const m = maskSecretPair({ a: "1", b: "2", c: "3" }, { a: "1", b: "20", d: "4" });
    expect(m.before).toBe(`a: ${MASK}\nb: ${MASK} (current)\nc: ${MASK}\n`);
    expect(m.after).toBe(`a: ${MASK}\nb: ${MASK} (changed)\nd: ${MASK}\n`);
    expect(m.before + m.after).not.toMatch(/[0-9]/);
  });
});

describe("merge3", () => {
  const base = ["a", "b", "c", "d", "e", "f", "g"].join("\n");

  it("diffs lines into hunks", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([{ a0: 1, a1: 2, lines: ["x"] }]);
    expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([{ a0: 1, a1: 1, lines: ["b"] }]);
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([{ a0: 1, a1: 2, lines: [] }]);
    expect(diffLines(["a"], ["a"])).toEqual([]);
    expect(diffLines(["a", "b", "c", "d", "e"], ["a", "B", "c", "D", "e"])).toHaveLength(2);
  });

  it("merges changes in different places", () => {
    const mine = base.replace("b", "B");
    const theirs = base.replace("f", "F");
    expect(merge3(base, mine, theirs)).toEqual({ text: "a\nB\nc\nd\ne\nF\ng", conflicts: 0 });
  });

  it("takes either side alone and identical changes once", () => {
    const mine = base.replace("d", "D");
    expect(merge3(base, mine, base)).toEqual({ text: mine, conflicts: 0 });
    expect(merge3(base, base, mine)).toEqual({ text: mine, conflicts: 0 });
    expect(merge3(base, mine, mine)).toEqual({ text: mine, conflicts: 0 });
  });

  it("merges an insert with a delete elsewhere", () => {
    const mine = "a\nb\nNEW\nc\nd\ne\nf\ng";
    const theirs = "a\nb\nc\nd\ne\ng";
    expect(merge3(base, mine, theirs)).toEqual({ text: "a\nb\nNEW\nc\nd\ne\ng", conflicts: 0 });
  });

  it("writes conflict markers for overlapping changes", () => {
    const r = merge3(base, base.replace("d", "MINE"), base.replace("d", "THEIRS"));
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(["a", "b", "c", MARK_MINE, "MINE", MARK_SEP, "THEIRS", MARK_THEIRS, "e", "f", "g"].join("\n"));
    expect(conflictMarkerLines(r.text)).toEqual([4, 6, 8]);
    expect(conflictMarkerLines(base)).toEqual([]);
  });

  it("treats adjacent changes as a conflict and keeps later clean hunks", () => {
    const r = merge3(base, "a\nB\nc\nd\ne\nf\ng", "a\nb\nC\nd\ne\nF\ng");
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain(`${MARK_MINE}\nB\nc\n${MARK_SEP}\nb\nC\n${MARK_THEIRS}`);
    expect(r.text.endsWith("d\ne\nF\ng")).toBe(true);
  });

  it("rebases a resourceVersion bump under an edit", () => {
    const b = "metadata:\n  resourceVersion: \"1\"\nspec:\n  replicas: 2\n  paused: false\n";
    const mine = b.replace("replicas: 2", "replicas: 3");
    const theirs = b.replace('"1"', '"2"');
    expect(merge3(b, mine, theirs)).toEqual({ text: mine.replace('"1"', '"2"'), conflicts: 0 });
  });
});

describe("search", () => {
  const text = "Name: web\nname: Web\nimage: web:1\n";

  it("finds text with smart case", () => {
    expect(findMatches(text, "web", "text").matches).toHaveLength(3);
    expect(findMatches(text, "Web", "text").matches).toEqual([{ from: 16, to: 19 }]);
    expect(findMatches(text, "", "text").matches).toEqual([]);
    expect(findMatches(text, "a.b", "text").matches).toEqual([]);
    expect(findMatches("a.b axb", "a.b", "text").matches).toEqual([{ from: 0, to: 3 }]);
  });

  it("supports regular expressions and reports bad ones", () => {
    expect(findMatches(text, "^name", "re").matches).toHaveLength(2);
    expect(findMatches(text, "web:\\d", "re").matches).toEqual([{ from: 27, to: 32 }]);
    expect(findMatches(text, "(", "re").error).toBeTruthy();
    expect(findMatches(text, "x*", "re").matches).toEqual([]);
  });

  it("caps the match list", () => {
    const r = findMatches("a".repeat(6000), "a", "text");
    expect(r.capped).toBe(true);
    expect(r.matches).toHaveLength(5000);
  });

  it("steps and wraps", () => {
    const m = findMatches(text, "web", "text").matches;
    expect(matchAtOrAfter(m, 0)).toBe(0);
    expect(matchAtOrAfter(m, 7)).toBe(1);
    expect(matchAtOrAfter(m, 1000)).toBe(0);
    expect(matchAtOrAfter([], 0)).toBe(-1);
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
    expect(stepMatch(3, -1, 1)).toBe(0);
    expect(stepMatch(0, -1, 1)).toBe(-1);
  });
});
