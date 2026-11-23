import { describe, expect, it } from "vitest";
import opsSource from "../actions/ops/actions.ts?raw";
import type { Gvr } from "../ipc/types";
import type { TableView } from "../types";
import {
  BUILT_IN_SNIPPETS, commandLine, findSnippet, floatingTag, fullImage, KUBECTL_TEMPLATES, kubectlFor, kubectlForView, mirrordCommand,
  NO_KUBECTL, parseSnippetArgs, resourceArg, runSummary, sanitizeTools, shq, snippetFits, snippetsFor, validImage, type KubeTarget,
} from "./model";

const g = (resource: string, group = "", version = "v1"): Gvr => ({ group, version, resource });
const pod: KubeTarget = { context: "default", gvr: g("pods"), namespace: "kns-spike", name: "web-1", container: "nginx" };
const deploy: KubeTarget = { context: "default", gvr: g("deployments", "apps"), namespace: "kns-spike", name: "web" };
const node: KubeTarget = { context: "default", gvr: g("nodes"), name: "node-1" };
const ks: KubeTarget = { context: "default", gvr: g("kustomizations", "kustomize.toolkit.fluxcd.io", "v1"), namespace: "flux-system", name: "apps" };
const NOW = "2026-11-22T10:00:00.000Z";

describe("images", () => {
  it("spells out the full reference", () => {
    expect(fullImage("busybox:1.37.0")).toBe("docker.io/library/busybox:1.37.0");
    expect(fullImage("nicolaka/netshoot:v0.13")).toBe("docker.io/nicolaka/netshoot:v0.13");
    expect(fullImage("ghcr.io/a/b:1")).toBe("ghcr.io/a/b:1");
    expect(fullImage("localhost:5000/x")).toBe("localhost:5000/x:latest");
    expect(fullImage("busybox")).toBe("docker.io/library/busybox:latest");
    expect(fullImage("ghcr.io/a/b@sha256:abc")).toBe("ghcr.io/a/b@sha256:abc");
    expect(floatingTag("busybox")).toBe(true);
    expect(floatingTag("busybox:1.37.0")).toBe(false);
  });
  it("validates", () => {
    expect(validImage("busybox:1.37.0")).toBe(true);
    for (const bad of ["", "a b", "a\nb", "x".repeat(256)]) expect(validImage(bad)).toBe(false);
  });
});

describe("quoting", () => {
  it("leaves plain words and quotes the rest", () => {
    expect(shq("web-1")).toBe("web-1");
    expect(shq("app=web")).toBe("app=web");
    expect(shq('{"spec":{"suspend":true}}')).toBe(`'{"spec":{"suspend":true}}'`);
    expect(shq("a b")).toBe("'a b'");
    expect(shq("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shq("")).toBe("''");
  });
  it("refuses what no quoting pastes the same everywhere", () => {
    expect(shq("it's")).toBeNull();
    expect(shq("a\nb")).toBeNull();
    expect(commandLine(["kubectl", "a\u0007"])).toBeNull();
    // PowerShell ends single quotes at typographic quotes too
    expect(shq("a’; calc")).toBeNull();
  });
  it("quotes what PowerShell reads specially unquoted", () => {
    expect(shq("@x")).toBe("'@x'");
    expect(shq("a,b")).toBe("'a,b'");
  });
});

describe("kubectl templates", () => {
  it("covers every built ops action (or says it has no equivalent)", () => {
    const block = opsSource.slice(opsSource.lastIndexOf("registerActions({"));
    const ids = [...block.matchAll(/^\s+"([a-z]+\.[A-Za-z]+)":/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id in KUBECTL_TEMPLATES || NO_KUBECTL.has(id), id).toBe(true);
  });

  it("every template yields a quotable command for a typical target", () => {
    for (const id of Object.keys(KUBECTL_TEMPLATES)) {
      const t = id.startsWith("node.") ? node : id.startsWith("flux.") ? ks : id.startsWith("cronjob.") ? { ...deploy, gvr: g("cronjobs", "batch") } : id.startsWith("workload.") ? deploy : pod;
      const cmd = kubectlFor(id, t, { now: NOW, image: "busybox:1.37.0" });
      expect(cmd, id).toMatch(/^kubectl /);
      expect(cmd, id).toContain("--context default");
    }
  });

  it("spells context and namespace out", () => {
    expect(kubectlFor("workload.restart", deploy)).toBe("kubectl rollout restart deployments/web --context default -n kns-spike");
    expect(kubectlFor("workload.scale", deploy, { replicas: 3 })).toBe("kubectl scale deployments/web --replicas=3 --context default -n kns-spike");
    expect(kubectlFor("res.delete", pod)).toBe("kubectl delete pods web-1 --context default -n kns-spike");
    expect(kubectlFor("pod.kill", pod)).toBe("kubectl delete pods web-1 --grace-period=0 --force --context default -n kns-spike");
    expect(kubectlFor("res.logs", pod)).toBe("kubectl logs web-1 -c nginx --tail=200 -f --context default -n kns-spike");
    expect(kubectlFor("res.logs", deploy)).toBe("kubectl logs deployments/web --tail=200 -f --context default -n kns-spike");
    expect(kubectlFor("pod.shell", pod)).toBe("kubectl exec -it web-1 -c nginx --context default -n kns-spike -- sh");
    expect(kubectlFor("node.cordon", node)).toBe("kubectl cordon node-1 --context default");
    expect(kubectlFor("flux.suspendResume", ks, { suspend: false })).toBe(
      `kubectl patch kustomizations.kustomize.toolkit.fluxcd.io apps --type=merge -p '{"spec":{"suspend":false}}' --context default -n flux-system`,
    );
    expect(kubectlFor("flux.reconcile", ks, { now: NOW })).toBe(
      `kubectl annotate --overwrite kustomizations.kustomize.toolkit.fluxcd.io apps reconcile.fluxcd.io/requestedAt=${NOW} --context default -n flux-system`,
    );
    expect(kubectlFor("pod.debug", pod, { image: "nicolaka/netshoot:v0.13" })).toBe(
      "kubectl debug -it web-1 --image=nicolaka/netshoot:v0.13 --target=nginx --context default -n kns-spike",
    );
    expect(kubectlFor("pod.debug", { ...pod, container: undefined }, { image: "busybox:1.37.0", copy: true })).toBe(
      "kubectl debug web-1 -it --copy-to=web-1-debug --image=busybox:1.37.0 --share-processes --context default -n kns-spike",
    );
  });

  it("declines what it cannot express", () => {
    expect(kubectlFor("res.logs", { ...pod, gvr: g("configmaps") })).toBeNull();
    expect(kubectlFor("res.why", pod)).toBeNull();
    expect(kubectlFor("res.delete", { ...pod, name: "it's" })).toBeNull();
  });

  it("qualifies non-core groups", () => {
    expect(resourceArg(g("pods"))).toBe("pods");
    expect(resourceArg(g("jobs", "batch"))).toBe("jobs");
    expect(resourceArg(g("helmreleases", "helm.toolkit.fluxcd.io", "v2"))).toBe("helmreleases.helm.toolkit.fluxcd.io");
  });

  it("turns views into commands", () => {
    const table: TableView = { kind: "table", gvr: g("pods"), namespace: "kns-spike", filters: [{ mode: "label", selector: "app=web" }], faultsOnly: false, sort: null, wide: true };
    expect(kubectlForView(table, "default")).toBe("kubectl get pods -l app=web -o wide --context default -n kns-spike");
    expect(kubectlForView({ ...table, namespace: "*", filters: [], wide: false }, "default")).toBe("kubectl get pods --context default -A");
    const ref = { gvr: g("deployments", "apps"), namespace: "kns-spike", name: "web" };
    expect(kubectlForView({ kind: "doc", ref, format: "yaml", mode: "view", managedFields: false, wrap: false }, "default")).toBe(
      "kubectl get deployments web -o yaml --context default -n kns-spike",
    );
    expect(kubectlForView({ kind: "doc", ref, format: "describe", mode: "view", managedFields: false, wrap: false }, "default")).toBe(
      "kubectl describe deployments web --context default -n kns-spike",
    );
    expect(kubectlForView({ kind: "doc", ref, format: "yaml", mode: "edit", managedFields: false, wrap: false }, "default")).toBe(
      "kubectl edit deployments web --context default -n kns-spike",
    );
    expect(
      kubectlForView(
        { kind: "logs", target: { by: "object", ref: { gvr: g("pods"), namespace: "kns-spike", name: "web-1" } }, container: "*", since: "5m", previous: false, wrap: false, timestamps: true, filterLines: false },
        "default",
      ),
    ).toBe("kubectl logs web-1 --all-containers -f --timestamps --since=5m --context default -n kns-spike");
    expect(kubectlForView({ kind: "shell", target: { by: "object", ref: { gvr: g("pods"), namespace: "n", name: "p" } }, container: "c" }, "x")).toBe(
      "kubectl exec -it p -c c --context x -n n -- sh",
    );
    expect(kubectlForView({ kind: "hub" }, "default")).toBeNull();
  });
});

describe("mirrord", () => {
  it("copies a command with a placeholder or the given one", () => {
    expect(mirrordCommand(pod)).toBe("mirrord exec --context default --target pod/web-1/container/nginx --target-namespace kns-spike -- YOUR_COMMAND");
    expect(mirrordCommand({ ...pod, container: undefined }, ["npm", "run", "dev"])).toBe(
      "mirrord exec --context default --target pod/web-1 --target-namespace kns-spike -- npm run dev",
    );
    expect(mirrordCommand(pod, ["echo", "it's"])).toBeNull();
  });
});

describe("snippets", () => {
  it("matches by image, specific ones first", () => {
    const psql = findSnippet([], "psql")!;
    expect(snippetFits(psql, "docker.io/library/postgres:16")).toBe(true);
    expect(snippetFits(psql, "nginx:1.27")).toBe(false);
    const forPg = snippetsFor([], "postgres:16").map((s) => s.id);
    expect(forPg.slice(0, 2)).toEqual(["psql", "psql-tables"]);
    expect(forPg).toContain("env");
    expect(forPg).not.toContain("redis-cli");
    const forNginx = snippetsFor([], "nginx:1.27").map((s) => s.id);
    expect(forNginx).toEqual(BUILT_IN_SNIPPETS.filter((s) => !s.images).map((s) => s.id));
    expect(snippetsFor([], "bitnami/kafka:3.9").slice(0, 2).map((s) => s.id)).toEqual(["kafka-topics", "kafka-groups"]);
  });
  it("user snippets override built-ins with the same id", () => {
    const user = [{ id: "env", title: "mine", command: "env" }];
    expect(snippetsFor(user, "x").find((s) => s.id === "env")?.command).toBe("env");
    expect(findSnippet(user, "env")?.title).toBe("mine");
    expect(findSnippet([], "nope")).toBeUndefined();
  });
  it("parses :x arguments", () => {
    expect(parseSnippetArgs([])).toEqual({ kind: "pick" });
    expect(parseSnippetArgs(["env"])).toEqual({ kind: "run", id: "env" });
    expect(parseSnippetArgs(["save", "topics", "kafka-topics.sh", "--list"])).toEqual({ kind: "save", id: "topics", command: "kafka-topics.sh --list" });
    expect(parseSnippetArgs(["save", "Bad Name", "x"]).kind).toBe("error");
    expect(parseSnippetArgs(["save", "ok"]).kind).toBe("error");
    expect(parseSnippetArgs(["rm", "topics"])).toEqual({ kind: "remove", id: "topics" });
    expect(parseSnippetArgs(["rm"]).kind).toBe("error");
  });
  it("summarises a run", () => {
    expect(runSummary({ exitCode: 0, truncated: false, millis: 412, redactions: { count: 2 } })).toBe("exit 0 · 412 ms · redacted 2 values");
    expect(runSummary({ message: "timed out after 30s", truncated: true, millis: 30000, redactions: { count: 0 } })).toBe("timed out after 30s · 30.0 s · truncated");
  });
  it("sanitizes the persisted tools store", () => {
    const s = sanitizeTools({
      snippets: [
        { id: "ok", title: "OK", command: "echo ok", images: ["Postgres"] },
        { id: "ok", command: "dup" },
        { id: "Bad Id", command: "x" },
        { id: "empty", command: "  " },
        "junk",
      ],
      recentImages: ["busybox:1.37.0", "a b", 3],
    });
    expect(s.snippets).toEqual([{ id: "ok", title: "OK", command: "echo ok", images: ["postgres"] }]);
    expect(s.recentImages).toEqual(["busybox:1.37.0"]);
    expect(sanitizeTools(null)).toEqual({ snippets: [], recentImages: [] });
  });
});
