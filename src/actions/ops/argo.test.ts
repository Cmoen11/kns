import { describe, expect, it } from "vitest";
import {
  appStatusText, argoOwner, argoOwnerText, isArgoManager, operationPhase, parseTrackingId, refreshPatch, selfHeals, syncPatch, TRACKING_ANNOTATION,
} from "./argo";

describe("parseTrackingId (mirror of argo.rs)", () => {
  it("reads app, group, kind, namespace and name", () => {
    expect(parseTrackingId("web-test:apps/Deployment:shop/web")).toEqual({ app: "web-test", group: "apps", kind: "Deployment", namespace: "shop", name: "web" });
  });
  it("reads the app namespace of apps in any namespace and the empty core group", () => {
    expect(parseTrackingId("shop_web-test:/Service:shop/web")).toEqual({ app: "web-test", appNamespace: "shop", group: "", kind: "Service", namespace: "shop", name: "web" });
  });
  it("leaves the namespace out for cluster-scoped objects", () => {
    expect(parseTrackingId("infra:rbac.authorization.k8s.io/ClusterRole:/reader")).toEqual({ app: "infra", group: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "reader" });
  });
  it.each(["", "app", "app:apps/Deployment", "app:Deployment:shop/web", ":apps/Deployment:shop/web", "_x:apps/D:a/b", "app:apps/:a/b", "app:apps/D:a/"])("rejects %j", (bad) => {
    expect(parseTrackingId(bad)).toBeNull();
  });
});

describe("argoOwner", () => {
  it("prefers the tracking annotation", () => {
    expect(argoOwner({ metadata: { annotations: { [TRACKING_ANNOTATION]: "shop_web-prod:apps/Deployment:shop/web" }, labels: { "argocd.argoproj.io/instance": "x" } } }))
      .toEqual({ app: "web-prod", namespace: "shop" });
  });
  it("reads the instance label", () => {
    expect(argoOwner({ metadata: { labels: { "argocd.argoproj.io/instance": "web" } } })).toEqual({ app: "web" });
  });
  it("does not take Helm's app.kubernetes.io/instance for Argo CD", () => {
    expect(argoOwner({ metadata: { labels: { "app.kubernetes.io/instance": "web" }, managedFields: [{ manager: "helm" }] } })).toBeNull();
    expect(argoOwner({ metadata: { labels: { "app.kubernetes.io/instance": "web" } } })).toBeNull();
  });
  it("takes app.kubernetes.io/instance when Argo CD wrote the object", () => {
    expect(argoOwner({ metadata: { labels: { "app.kubernetes.io/instance": "web" }, managedFields: [{ manager: "argocd-controller" }] } })).toEqual({ app: "web" });
  });
  it("is null for anything else", () => {
    expect(argoOwner(null)).toBeNull();
    expect(argoOwner({ metadata: { annotations: { [TRACKING_ANNOTATION]: 3 } } })).toBeNull();
  });
  it("names the owner", () => {
    expect(argoOwnerText({ app: "web", namespace: "shop" })).toBe("Application shop/web");
    expect(argoOwnerText({ app: "web" })).toBe("Application web");
  });
});

describe("Application helpers", () => {
  it("classifies Argo CD field managers", () => {
    expect(isArgoManager("argocd-application-controller")).toBe(true);
    expect(isArgoManager("argo-rollouts")).toBe(false);
  });
  it("reads self-heal, the operation phase and the status text", () => {
    const app = { spec: { syncPolicy: { automated: { selfHeal: true } } }, status: { sync: { status: "OutOfSync" }, health: { status: "Healthy" }, operationState: { phase: "Running" } } };
    expect(selfHeals(app)).toBe(true);
    expect(selfHeals({ spec: { syncPolicy: { automated: {} } } })).toBe(false);
    expect(operationPhase(app)).toBe("Running");
    expect(appStatusText(app)).toBe("OutOfSync · Healthy");
    expect(appStatusText({})).toBe("");
  });
  it("builds the refresh and sync patches", () => {
    expect(refreshPatch(true)).toEqual({ metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } });
    expect(syncPatch().operation.sync.prune).toBe(false);
  });
});
