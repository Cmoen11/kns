import { describe as suite, expect, it } from "vitest";
import type { Json } from "../../ipc/types";
import { describe } from "./describe";
import { argoOwnerOfText } from "./yaml-helpers";

const NOW = Date.parse("2026-11-25T12:00:00Z");

suite("describe with Argo CD", () => {
  it("says which Application manages an object", () => {
    const deploy = {
      apiVersion: "apps/v1", kind: "Deployment",
      metadata: { name: "web", namespace: "shop", annotations: { "argocd.argoproj.io/tracking-id": "shop_web:apps/Deployment:shop/web" } },
      spec: {}, status: {},
    };
    expect(describe(deploy, [], NOW)).toMatch(/^Managed By: +Argo CD Application shop\/web$/m);
  });

  it("names the Flux owner the same way", () => {
    const cm = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x", labels: { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" } } };
    expect(describe(cm, [], NOW)).toMatch(/^Managed By: +Flux Kustomization flux-system\/apps$/m);
  });

  it("summarises an Application", () => {
    const app: Json = {
      apiVersion: "argoproj.io/v1alpha1", kind: "Application",
      metadata: { name: "web", namespace: "shop" },
      spec: {
        project: "shop",
        source: { repoURL: "https://github.com/example/shop-ops.git", path: "web/test", targetRevision: "HEAD" },
        destination: { name: "workload-test", namespace: "shop" },
        syncPolicy: { automated: { selfHeal: true } },
      },
      status: {
        sync: { status: "OutOfSync", revision: "4f2c9e1" },
        health: { status: "Degraded" },
        resources: [
          { kind: "Service", namespace: "shop", name: "web", status: "Synced", health: { status: "Healthy" } },
          { kind: "Deployment", namespace: "shop", name: "web", status: "OutOfSync", health: { status: "Degraded", message: "progress deadline" } },
        ],
      },
    };
    const text = describe(app, [], NOW);
    expect(text).toMatch(/^Status: +OutOfSync · Degraded$/m);
    expect(text).toMatch(/^Source: +https:\/\/github.com\/example\/shop-ops.git web\/test @ HEAD$/m);
    expect(text).toMatch(/^Destination: +workload-test \/ shop$/m);
    expect(text).toMatch(/^Auto-sync: +self-heal$/m);
    expect(text).toContain("Resources Not Synced Or Healthy:");
    expect(text).toMatch(/Deployment +shop\/web +OutOfSync +Degraded +progress deadline/);
    expect(text).not.toMatch(/Service +shop\/web/);
  });

  it("finds the Application in an edited manifest", () => {
    expect(argoOwnerOfText("metadata:\n  annotations:\n    argocd.argoproj.io/tracking-id: web:apps/Deployment:shop/web\n")).toBe("Application web");
    expect(argoOwnerOfText("metadata: {}\n")).toBeNull();
    expect(argoOwnerOfText(": : :")).toBeNull();
  });
});
