import { describe, expect, it } from "vitest";
import type { Gvr } from "../ipc/types";
import { containerRows } from "./containers";
import { drill, selectorString } from "./drill";

const g = (group: string, resource: string, version = "v1"): Gvr => ({ group, version, resource });
const resolve = (name: string) =>
  name === "widgets.example.com" ? { gvr: g("example.com", "widgets"), namespaced: true } : name === "pod" ? { gvr: g("", "pods"), namespaced: true } : undefined;
const run = (gvr: Gvr, name = "web", namespace: string | undefined = "shop", eventObject?: string) =>
  drill({ gvr, ref: { gvr, namespace, name, uid: "u1" }, eventObject, resolve });

describe("drill-down (§4.3)", () => {
  it("workloads open their pods, scoped by owner", () => {
    for (const r of ["deployments", "statefulsets", "daemonsets", "replicasets"]) {
      expect(run(g("apps", r))).toMatchObject({
        view: { kind: "table", gvr: { resource: "pods" }, namespace: "shop", scope: { by: "owner", ref: { name: "web", uid: "u1" } } },
      });
    }
    expect(run(g("batch", "jobs"))).toMatchObject({ view: { gvr: { resource: "pods" }, scope: { by: "owner" } } });
  });
  it("cronjob -> jobs by owner; pod -> containers; node -> pods on the node; namespace -> its pods", () => {
    expect(run(g("batch", "cronjobs"))).toMatchObject({ view: { gvr: { group: "batch", resource: "jobs" }, scope: { by: "owner" } } });
    expect(run(g("", "pods"))).toMatchObject({ view: { kind: "containers", pod: { name: "web" } } });
    expect(run(g("", "nodes"), "node-1", undefined)).toMatchObject({ view: { gvr: { resource: "pods" }, namespace: "*", scope: { by: "node", name: "node-1" } } });
    expect(run(g("", "namespaces"), "kafka", undefined)).toMatchObject({ view: { gvr: { resource: "pods" }, namespace: "kafka" } });
  });
  it("a service needs its selector first", () => {
    expect(run(g("", "services"))).toEqual({ service: { gvr: g("", "services"), namespace: "shop", name: "web", uid: "u1" } });
    expect(selectorString({ app: "web", tier: "api" })).toBe("app=web,tier=api");
    expect(selectorString({})).toBeNull();
    expect(selectorString(null)).toBeNull();
  });
  it("a CRD opens its instances, or its describe when the kind is not served", () => {
    expect(run(g("apiextensions.k8s.io", "customresourcedefinitions"), "widgets.example.com", undefined)).toMatchObject({
      view: { kind: "table", gvr: { group: "example.com", resource: "widgets" }, namespace: "*" },
    });
    expect(run(g("apiextensions.k8s.io", "customresourcedefinitions"), "gone.example.com", undefined)).toMatchObject({ view: { kind: "doc", format: "describe" } });
  });
  it("an event opens the describe of the involved object", () => {
    expect(run(g("", "events"), "web.17a", "shop", "pod/web-7d9f8")).toMatchObject({
      view: { kind: "doc", format: "describe", ref: { gvr: { resource: "pods" }, namespace: "shop", name: "web-7d9f8" } },
    });
    expect(run(g("", "events"), "web.17a", "shop", "thing/x")).toMatchObject({ view: { kind: "doc", ref: { name: "web.17a" } } });
  });
  it("everything else is describe; a secret is never decoded", () => {
    for (const r of ["configmaps", "secrets", "persistentvolumeclaims"]) {
      expect(run(g("", r))).toMatchObject({ view: { kind: "doc", format: "describe", mode: "view" } });
    }
    expect(run(g("kustomize.toolkit.fluxcd.io", "kustomizations"))).toMatchObject({ view: { kind: "doc", format: "describe" } });
  });
});

describe("containerRows (§12.5)", () => {
  it("lists init, regular and ephemeral containers in spec order with their state", () => {
    const rows = containerRows({
      metadata: { namespace: "shop", creationTimestamp: "2026-01-01T00:00:00Z" },
      spec: {
        initContainers: [{ name: "init", image: "busybox" }],
        containers: [{ name: "main", image: "app:1", ports: [{ containerPort: 8080 }, { containerPort: 53, protocol: "UDP" }] }, { name: "sidecar", image: "proxy:2" }],
      },
      status: {
        initContainerStatuses: [{ name: "init", ready: false, restartCount: 0, state: { terminated: { exitCode: 0, reason: "Completed", startedAt: "2026-01-01T00:00:01Z" } } }],
        containerStatuses: [
          { name: "main", ready: true, restartCount: 2, state: { running: { startedAt: "2026-01-01T00:00:05Z" } } },
          { name: "sidecar", ready: false, restartCount: 9, state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    });
    expect(rows.map((r) => r.uid)).toEqual(["init/init", "ctr/main", "ctr/sidecar"]);
    expect(rows[0].cells).toEqual(["init", "Completed", false, 0, "init", "busybox", "", "", "", ""]);
    expect(rows[1].cells).toEqual(["main", "Running", true, 2, "ctr", "app:1", "8080/TCP,53/UDP", "", "", ""]);
    expect(rows[1].created).toBe("2026-01-01T00:00:05Z");
    expect(rows[2].cells.slice(0, 4)).toEqual(["sidecar", "CrashLoopBackOff", false, 9]);
    expect(rows[2].created).toBe("2026-01-01T00:00:00Z");
  });
  it("non-zero exits are errors; a container without status is waiting", () => {
    const rows = containerRows({
      spec: { containers: [{ name: "a" }, { name: "b" }] },
      status: { containerStatuses: [{ name: "a", state: { terminated: { exitCode: 137, reason: "OOMKilled" } } }] },
    });
    expect(rows.map((r) => r.cells[1])).toEqual(["OOMKilled", "Waiting"]);
  });
  it("garbage gives no rows", () => {
    expect(containerRows(null)).toEqual([]);
    expect(containerRows("x")).toEqual([]);
    expect(containerRows({ spec: { containers: "nope" } })).toEqual([]);
  });
});
