import { describe, expect, it } from "vitest";
import { errorText, plural, runBulk, summarize } from "./bulk";
import {
  cordonPatch, fluxOwner, fluxOwnerText, isSuspended, labelsOf, ownerOf, reconcilePatch, RECONCILE_ANNOTATION, replicasOf, sourceRefOf,
} from "./flux";
import { createAccessCache, type AccessKey } from "./rbac";
import { canReapply, cleanForReapply } from "./reapply";
import { confirmText, deleteTier, dependentsNote, effectiveTier } from "./tiers";

describe("tier selection", () => {
  it("ranks deletes by kind", () => {
    expect(deleteTier("pods")).toBe(1);
    expect(deleteTier("configmaps")).toBe(1);
    expect(deleteTier("deployments", "apps")).toBe(2);
    expect(deleteTier("statefulsets", "apps")).toBe(2);
    expect(deleteTier("persistentvolumeclaims")).toBe(2);
    expect(deleteTier("namespaces")).toBe(3);
    expect(deleteTier("customresourcedefinitions", "apiextensions.k8s.io")).toBe(3);
  });

  it("treats Flux objects as tier 2 (they prune what they manage)", () => {
    expect(deleteTier("kustomizations", "kustomize.toolkit.fluxcd.io")).toBe(2);
    expect(deleteTier("helmreleases", "helm.toolkit.fluxcd.io")).toBe(2);
  });

  it("raises every write to tier 2 on a protected context, and leaves 2 and 3 alone", () => {
    expect(effectiveTier(0, { protected: false })).toBe(0);
    expect(effectiveTier(0, { protected: true })).toBe(2);
    expect(effectiveTier(1, { protected: true })).toBe(2);
    expect(effectiveTier(2, { protected: true })).toBe(2);
    expect(effectiveTier(3, { protected: true })).toBe(3);
  });

  it("makes a bulk delete typed, even of pods", () => {
    expect(effectiveTier(1, { protected: false, bulkDelete: true })).toBe(2);
    expect(effectiveTier(3, { protected: false, bulkDelete: true })).toBe(3);
  });

  it("asks for the name, or `<verb> N` for bulk", () => {
    expect(confirmText("delete", ["web"])).toBe("web");
    expect(confirmText("delete", ["a", "b", "c"])).toBe("delete 3");
    expect(confirmText("restart", ["a", "b"])).toBe("restart 2");
  });

  it("explains tier 3", () => {
    expect(dependentsNote("namespaces")).toMatch(/namespace/);
    expect(dependentsNote("pods")).toBeUndefined();
  });
});

describe("Flux detection", () => {
  it("finds the managing Kustomization from labels", () => {
    const o = fluxOwner({ "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system", app: "web" });
    expect(o).toEqual({ kind: "Kustomization", group: "kustomize.toolkit.fluxcd.io", name: "apps", namespace: "flux-system" });
    expect(fluxOwnerText(o!)).toBe("Kustomization flux-system/apps");
  });

  it("finds the managing HelmRelease from labels", () => {
    const o = fluxOwner({ "helm.toolkit.fluxcd.io/name": "traefik", "helm.toolkit.fluxcd.io/namespace": "kube-system" });
    expect(o?.kind).toBe("HelmRelease");
    expect(o?.namespace).toBe("kube-system");
  });

  it("keeps the owner without a namespace label, and ignores unmanaged objects", () => {
    expect(fluxOwner({ "kustomize.toolkit.fluxcd.io/name": "apps" })).toMatchObject({ name: "apps", namespace: undefined });
    expect(fluxOwner({ app: "web" })).toBeNull();
    expect(fluxOwner({ "kustomize.toolkit.fluxcd.io/name": "" })).toBeNull();
    expect(fluxOwner({ "kustomize.toolkit.fluxcd.io/name": 3 })).toBeNull();
    expect(fluxOwner(undefined)).toBeNull();
  });

  it("reads labels and state from arbitrary JSON without throwing", () => {
    expect(labelsOf(null)).toEqual({});
    expect(labelsOf({ metadata: { labels: { a: "b" } } })).toEqual({ a: "b" });
    expect(isSuspended({ spec: { suspend: true } })).toBe(true);
    expect(isSuspended({ spec: {} })).toBe(false);
    expect(isSuspended("x")).toBe(false);
    expect(replicasOf({ spec: { replicas: 3 } })).toBe(3);
    expect(replicasOf({ spec: { replicas: "3" } })).toBeNull();
    expect(replicasOf(null)).toBeNull();
  });

  it("resolves the source of a Kustomization and a HelmRelease", () => {
    expect(
      sourceRefOf({ metadata: { namespace: "flux-system" }, spec: { sourceRef: { kind: "GitRepository", name: "flux-system" } } }),
    ).toEqual({ kind: "GitRepository", group: undefined, name: "flux-system", namespace: "flux-system" });
    expect(
      sourceRefOf({
        metadata: { namespace: "apps" },
        spec: { chart: { spec: { chart: "x", sourceRef: { kind: "HelmRepository", name: "bitnami", namespace: "flux-system" } } } },
      }),
    ).toMatchObject({ kind: "HelmRepository", name: "bitnami", namespace: "flux-system" });
    expect(
      sourceRefOf({ metadata: { namespace: "apps" }, spec: { chartRef: { kind: "OCIRepository", name: "podinfo", apiVersion: "source.toolkit.fluxcd.io/v1" } } }),
    ).toEqual({ kind: "OCIRepository", group: "source.toolkit.fluxcd.io", name: "podinfo", namespace: "apps" });
    expect(sourceRefOf({ spec: { url: "https://example.org" } })).toBeNull();
    expect(sourceRefOf(null)).toBeNull();
  });

  it("builds the reconcile and cordon patches", () => {
    const p = reconcilePatch(new Date("2026-01-02T03:04:05.678Z"));
    expect(p.metadata.annotations[RECONCILE_ANNOTATION]).toBe("2026-01-02T03:04:05.678Z");
    expect(cordonPatch(true)).toEqual({ spec: { unschedulable: true } });
    expect(cordonPatch(false)).toEqual({ spec: { unschedulable: null } });
  });

  it("picks the controlling owner", () => {
    expect(
      ownerOf({
        metadata: {
          ownerReferences: [
            { apiVersion: "v1", kind: "Other", name: "o", uid: "1" },
            { apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-7d9f8", uid: "2", controller: true },
          ],
        },
      }),
    ).toEqual({ kind: "ReplicaSet", group: "apps", name: "web-7d9f8", uid: "2" });
    expect(ownerOf({ metadata: {} })).toBeNull();
  });
});

describe("bulk runner", () => {
  it("keeps order, never throws and reports per item", async () => {
    const results = await runBulk([1, 2, 3, 4], async (n) => {
      if (n % 2 === 0) throw { code: 403, reason: "Forbidden", message: `no ${n}` };
      return n * 10;
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect(results[0].value).toBe(10);
    expect(results[2].value).toBe(30);
    expect(errorText(results[1].error)).toBe("Forbidden: no 2");
  });

  it("never runs more than the limit at once and finishes everything", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    const results = await runBulk(items, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, i % 3));
      active--;
      return i;
    }, 6);
    expect(peak).toBe(6);
    expect(results.map((r) => r.value)).toEqual(items);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await runBulk([], async () => 1)).toEqual([]);
    const r = await runBulk(["a"], async (s) => s.toUpperCase(), 50);
    expect(r).toEqual([{ item: "a", ok: true, value: "A" }]);
  });

  it("summarizes one item, a clean bulk and a partial failure", async () => {
    const name = (s: string) => s;
    expect(summarize("Deleted", "pod", [{ item: "web-1", ok: true }], name).text).toBe("Deleted pod web-1");
    expect(summarize("Scaled", "deployment", [{ item: "web", ok: true }], name, "to 3").text).toBe("Scaled deployment web to 3");
    expect(summarize("Restarted", "deployment", [{ item: "a", ok: true }, { item: "b", ok: true }], name)).toMatchObject({
      kind: "ok", text: "Restarted 2 deployments", done: 2, failed: 0,
    });
    const partial = summarize(
      "Deleted", "pod",
      [{ item: "a", ok: true }, { item: "b", ok: false, error: { code: 403, reason: "Forbidden", message: "pods is forbidden" } }],
      name,
    );
    expect(partial).toMatchObject({ kind: "error", done: 1, failed: 1 });
    expect(partial.text).toBe("Deleted 1 of 2 pods; 1 failed: b: Forbidden: pods is forbidden");
    expect(summarize("Deleted", "pod", [{ item: "a", ok: false, error: new Error("boom") }], name).text).toBe("pod a: boom");
  });

  it("caps the failure list", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ item: `p${i}`, ok: false, error: { message: "x" } }));
    expect(summarize("Deleted", "pod", results, (s) => s).text).toMatch(/and 4 more$/);
  });

  it("pluralizes kinds", () => {
    expect(plural("pod")).toBe("pods");
    expect(plural("ingress")).toBe("ingresses");
    expect(plural("networkpolicy")).toBe("networkpolicies");
    expect(plural("gateway")).toBe("gateways");
  });
});

describe("RBAC cache", () => {
  const key: AccessKey = { context: "default", verb: "delete", group: "", version: "v1", resource: "pods", namespace: "shop" };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("is advisory while unknown, asks once and then answers from the cache", async () => {
    let calls = 0;
    let changes = 0;
    const cache = createAccessCache({ canI: async () => (calls++, false), onChange: () => changes++ });
    expect(cache.check(key)).toBeUndefined();
    expect(cache.check(key)).toBeUndefined();
    await flush();
    expect(calls).toBe(1);
    expect(changes).toBe(1);
    expect(cache.check(key)).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not signal a change when the answer is 'allowed'", async () => {
    let changes = 0;
    const cache = createAccessCache({ canI: async () => true, onChange: () => changes++ });
    cache.check(key);
    await flush();
    expect(cache.check(key)).toBe(true);
    expect(changes).toBe(0);
  });

  it("refreshes after the TTL and keeps the stale answer meanwhile", async () => {
    let t = 0;
    let answer = false;
    let calls = 0;
    const cache = createAccessCache({ canI: async () => (calls++, answer), onChange: () => {}, now: () => t, ttlMs: 1000 });
    cache.check(key);
    await flush();
    t = 2000;
    answer = true;
    expect(cache.check(key)).toBe(false);
    await flush();
    expect(calls).toBe(2);
    expect(cache.check(key)).toBe(true);
  });

  it("keys by verb, subresource and namespace, and survives a failing review", async () => {
    const seen: string[] = [];
    const cache = createAccessCache({
      canI: async (k) => {
        seen.push(`${k.verb}:${k.subresource ?? ""}:${k.namespace ?? ""}`);
        if (k.verb === "patch") throw new Error("offline");
        return true;
      },
      onChange: () => {},
    });
    cache.check(key);
    cache.check({ ...key, verb: "patch", subresource: "scale" });
    cache.check({ ...key, namespace: "other" });
    await flush();
    expect(seen).toEqual(["delete::shop", "patch:scale:shop", "delete::other"]);
    expect(cache.check({ ...key, verb: "patch", subresource: "scale" })).toBeUndefined();
    expect(cache.size()).toBe(2);
  });
});

describe("re-apply", () => {
  it("strips what the server owns", () => {
    const out = cleanForReapply(
      [
        "apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: cfg", "  namespace: shop", "  uid: abc",
        "  resourceVersion: '12'", "  creationTimestamp: 2026-01-01T00:00:00Z", "  labels:", "    app: web", "data:", "  a: b", "status:", "  x: 1",
      ].join("\n"),
    );
    expect(out).toContain("name: cfg");
    expect(out).toContain("app: web");
    expect(out).toContain("a: b");
    expect(out).not.toMatch(/uid|resourceVersion|creationTimestamp|status/);
  });

  it("rejects what is not an object", () => {
    expect(cleanForReapply("- a\n- b")).toBeNull();
    expect(cleanForReapply("{ unclosed")).toBeNull();
    expect(cleanForReapply("foo: bar")).toBeNull();
  });

  it("is not offered for data-bearing or owned objects", () => {
    expect(canReapply("configmaps", false)).toBe(true);
    expect(canReapply("pods", true)).toBe(false);
    expect(canReapply("persistentvolumeclaims", false)).toBe(false);
    expect(canReapply("namespaces", false)).toBe(false);
  });
});
