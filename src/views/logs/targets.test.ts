import { describe, expect, it } from "vitest";
import type { PodRef } from "../../ipc/types";
import type { LogsView } from "../../types";
import {
  containerChoices, expandSources, gutterMode, gutterWidth, markerFor, middleEllipsis, objectsTarget, sinceQuery, sourceLabel, streamConfig, streamKey, TAIL_LINES,
  targetName, unionPods,
} from "./targets";

describe("targets", () => {
  const pod = (name: string, extra: Partial<PodRef> = {}): PodRef => ({
    namespace: "ns", name, containers: ["main"], initContainers: [], ephemeralContainers: [], phase: "Running", ...extra,
  });

  it("maps since to the API range", () => {
    expect(sinceQuery("tail")).toEqual({ tailLines: TAIL_LINES });
    expect(sinceQuery("head")).toEqual({});
    expect(sinceQuery("5m")).toEqual({ sinceSeconds: 300 });
    expect(sinceQuery("1h")).toEqual({ sinceSeconds: 3600 });
  });

  it("expands pods to one source per container", () => {
    const pods = [pod("b", { containers: ["main", "sidecar"], initContainers: ["init"], ephemeralContainers: ["debug"] }), pod("a")];
    const all = expandSources(pods, "*");
    expect(all.sources.map((s) => `${s.pod}/${s.container}:${s.kind}`)).toEqual([
      "a/main:container", "b/init:init", "b/main:container", "b/sidecar:container", "b/debug:ephemeral",
    ]);
    expect(expandSources(pods, "sidecar").sources.map((s) => `${s.pod}/${s.container}`)).toEqual(["b/sidecar"]);
    expect(expandSources(pods, "nope").sources).toEqual([]);
  });

  it("caps the merged stream at a number of pods", () => {
    const pods = Array.from({ length: 11 }, (_, i) => pod(`p${String(i).padStart(2, "0")}`));
    const r = expandSources(pods, "*", 8);
    expect(r.sources).toHaveLength(8);
    expect(r.skippedPods).toBe(3);
  });

  it("lists picker choices once, labelled by kind", () => {
    const pods = [pod("a", { initContainers: ["init"], containers: ["main", "sidecar"] }), pod("b", { ephemeralContainers: ["debug"] })];
    expect(containerChoices(pods)).toEqual([
      { value: "*", label: "All containers" },
      { value: "main", label: "main" },
      { value: "sidecar", label: "sidecar" },
      { value: "init", label: "init (init)" },
      { value: "debug", label: "debug (ephemeral)" },
    ]);
  });

  it("gives stable text markers and a middle ellipsis", () => {
    expect([0, 1, 25, 26, 51, 52, 60].map(markerFor)).toEqual(["a", "b", "z", "A", "Z", "1", "9"]);
    expect(middleEllipsis("short", 10)).toBe("short");
    expect(middleEllipsis("web-7d9f8c6b5-x2kqz", 11)).toBe("web-7…x2kqz");
    expect(middleEllipsis("web-7d9f8c6b5-x2kqz", 11)).toHaveLength(11);
  });

  it("shows in the gutter only what tells sources apart", () => {
    expect(gutterMode(1, 1)).toBe("none");
    expect(gutterMode(1, 3)).toBe("container");
    expect(gutterMode(3, 3)).toBe("pod");
    expect(gutterMode(2, 5)).toBe("both");
    const sources = [{ pod: "web-7d9f8c6b5-x2kqz", container: "main" }, { pod: "web-7d9f8c6b5-abcde", container: "istio-proxy-sidecar" }];
    expect(gutterWidth("none", sources)).toBe(0);
    expect(gutterWidth("container", sources)).toBe(19);
    expect(gutterWidth("pod", sources)).toBe(21);
    expect(gutterWidth("both", sources)).toBe(32);
    expect(sourceLabel("container", "a", "web", "main", 19)).toBe("main");
    expect(sourceLabel("pod", "b", "web-7d9f8c6b5-x2kqz", "main", 13)).toBe("b web-7…x2kqz");
    expect(sourceLabel("both", "a", "web-7d9f8c6b5-x2kqz", "main", 32)).toBe("a web-7d9f8c6b5-x2kqz/main");
    const long = sourceLabel("both", "a", "web-7d9f8c6b5-x2kqz", "istio-proxy-sidecar", 24);
    expect(long).toBe("a web-7…x2kqz/istio…ecar");
    expect(long.length).toBeLessThanOrEqual(24);
  });

  it("keys a stream set on target, container, since and previous only", () => {
    const view: LogsView = {
      kind: "logs", target: { by: "object", ref: { gvr: { group: "", version: "v1", resource: "pods" }, namespace: "ns", name: "a" } },
      container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false,
    };
    const key = (v: LogsView) => streamKey(streamConfig(v, "ctx")!);
    expect(key({ ...view, wrap: true, timestamps: true, filterLines: true, match: { mode: "re", text: "x" } })).toBe(key(view));
    expect(key({ ...view, container: "main" })).not.toBe(key(view));
    expect(key({ ...view, since: "5m" })).not.toBe(key(view));
    expect(key({ ...view, previous: true })).not.toBe(key(view));
    expect(streamConfig(view, null)).toBeNull();
    expect(streamConfig({ ...view, target: { by: "paneSelection", pane: "p1" } }, "ctx")).toBeNull();
  });
});

describe("merged logs targets", () => {
  const ref = (name: string, resource = "pods") => ({ gvr: { group: resource === "pods" ? "" : "apps", version: "v1", resource }, namespace: "ns", name });
  const podRef = (name: string, namespace = "ns") => ({ namespace, name, containers: ["main"], initContainers: [], ephemeralContainers: [], phase: "Running" });

  it("drops duplicate refs and keeps order", () => {
    expect(objectsTarget([ref("b"), ref("a"), ref("b")]).refs.map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("has a stream key independent of mark order", () => {
    const cfg = (refs: ReturnType<typeof ref>[]) => streamConfig({ kind: "logs", target: objectsTarget(refs), container: "*", since: "tail", previous: false, wrap: false, timestamps: false, filterLines: false }, "ctx")!;
    expect(streamKey(cfg([ref("a"), ref("b")]))).toBe(streamKey(cfg([ref("b"), ref("a")])));
    expect(streamKey(cfg([ref("a"), ref("b")]))).not.toBe(streamKey(cfg([ref("a")])));
    expect(targetName(objectsTarget([ref("a"), ref("b"), ref("c")]))).toBe("3 objects");
  });

  it("unions pods, first seen wins", () => {
    const u = unionPods([[podRef("a"), podRef("b")], [podRef("b"), podRef("c"), podRef("b", "other")]]);
    expect(u.map((p) => `${p.namespace}/${p.name}`)).toEqual(["ns/a", "ns/b", "ns/c", "other/b"]);
  });
});
