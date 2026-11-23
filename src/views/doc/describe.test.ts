import { describe as suite, expect, it } from "vitest";
import type { EventRow, Json } from "../../ipc/types";
import { age, describe } from "./describe";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

suite("age", () => {
  it("formats like kubectl", () => {
    expect(age(ago(45_000), NOW)).toBe("45s");
    expect(age(ago(12 * 60_000), NOW)).toBe("12m");
    expect(age(ago(3 * 3_600_000 + 4 * 60_000), NOW)).toBe("3h4m");
    expect(age(ago(30 * 3_600_000), NOW)).toBe("1d6h");
    expect(age(ago(120 * 86_400_000), NOW)).toBe("120d");
    expect(age(undefined, NOW)).toBe("-");
    expect(age("not a date", NOW)).toBe("-");
  });
});

const pod: Json = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "web-7d9f8", namespace: "shop", creationTimestamp: ago(2 * 86_400_000),
    labels: { app: "web" }, ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f8" }],
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": "LASTAPPLIED", note: "x".repeat(400) },
  },
  spec: {
    nodeName: "node-1", serviceAccountName: "web",
    initContainers: [{ name: "migrate", image: "ghcr.io/x/migrate:1" }],
    containers: [
      {
        name: "main", image: "ghcr.io/x/web:1.4.2", ports: [{ containerPort: 3000, name: "http" }],
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
        env: [{ name: "A", value: "1" }], volumeMounts: [{ name: "data", mountPath: "/data", readOnly: true }],
      },
      { name: "sidecar", image: "busybox" },
    ],
    volumes: [{ name: "data", persistentVolumeClaim: { claimName: "web-data" } }],
  },
  status: {
    phase: "Running", podIP: "10.42.0.7", hostIP: "192.168.1.2", qosClass: "Burstable",
    conditions: [
      { type: "PodScheduled", status: "True", lastTransitionTime: ago(2 * 86_400_000) },
      { type: "Ready", status: "False", lastTransitionTime: ago(60_000), reason: "ContainersNotReady", message: "containers with unready status: [sidecar]" },
    ],
    containerStatuses: [
      { name: "main", ready: true, restartCount: 2, state: { running: { startedAt: ago(3_600_000) } }, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: ago(3_700_000) } } },
      { name: "sidecar", ready: false, restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 40s" } } },
    ],
  },
};

const events: EventRow[] = [
  { type: "Normal", reason: "Pulled", message: "Container image already present", count: 1, lastSeen: ago(600_000), source: "kubelet", objectKind: "Pod", objectName: "web-7d9f8" },
  { type: "Warning", reason: "BackOff", message: "Back-off restarting\nfailed container", count: 7, lastSeen: ago(30_000), source: "kubelet", objectKind: "Pod", objectName: "web-7d9f8" },
];

suite("describe", () => {
  it("renders a pod with containers, state, restarts and events", () => {
    const text = describe(pod, events, NOW);
    expect(text).toContain("Name:           web-7d9f8");
    expect(text).toContain("Namespace:      shop");
    expect(text).toContain("Kind:           Pod (v1)");
    expect(text).toContain("(2d ago)");
    expect(text).toContain("Labels:         app=web");
    expect(text).toContain("Controlled By:  ReplicaSet/web-7d9f8");
    expect(text).toContain("Node:           node-1 (192.168.1.2)");
    expect(text).toContain("Restarts:       7");
    expect(text).toMatch(/Init Containers:\n {2}migrate:\n {4}Image: +ghcr\.io\/x\/migrate:1/);
    expect(text).toContain("    State:          Running (started 1h ago)");
    expect(text).toContain("    Last State:     Terminated (OOMKilled, exit code 137, 1h1m ago)");
    expect(text).toContain("    State:          Waiting (CrashLoopBackOff): back-off 40s");
    expect(text).toContain("    Ports:          3000/TCP (http)");
    expect(text).toContain("requests: cpu=50m, memory=64Mi");
    expect(text).toContain("/data from data (ro)");
    expect(text).toContain("persistentVolumeClaim (web-data)");
    // Ready is listed first
    const cond = text.slice(text.indexOf("Conditions:"));
    expect(cond.indexOf("Ready")).toBeLessThan(cond.indexOf("PodScheduled"));
    // newest event first, message flattened to one line
    const ev = text.slice(text.indexOf("Events:"));
    expect(ev.indexOf("BackOff")).toBeLessThan(ev.indexOf("Pulled"));
    expect(ev).toContain("x7");
    expect(ev).toContain("Back-off restarting failed container");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("clips long annotation values", () => {
    const line = describe(pod, [], NOW).split("\n").find((l) => l.startsWith("Annotations:"))!;
    expect(line.length).toBeLessThan(140);
    expect(line.endsWith("…")).toBe(true);
    expect(describe(pod, [], NOW)).not.toContain("LASTAPPLIED");
  });

  it("says when there are no events or they could not be listed", () => {
    expect(describe(pod, [], NOW)).toMatch(/Events:\n {2}<none>\n$/);
    expect(describe(pod, null, NOW)).toContain("<could not list events>");
  });

  it("renders a deployment with replicas, strategy and the pod template", () => {
    const text = describe(
      {
        apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "shop" },
        spec: {
          replicas: 3, selector: { matchLabels: { app: "web" } }, strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: 0 } },
          template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "main", image: "web:2" }] } },
        },
        status: { updatedReplicas: 3, readyReplicas: 2, availableReplicas: 2, conditions: [{ type: "Available", status: "True" }] },
      },
      [],
      NOW,
    );
    expect(text).toContain("Replicas:       3 desired, 3 updated, 2 ready, 2 available");
    expect(text).toContain("Strategy:       RollingUpdate (maxSurge=25%, maxUnavailable=0)");
    expect(text).toContain("Selector:       app=web");
    expect(text).toMatch(/Pod Template:\n {2}Labels: +app=web\n {2}Containers:\n {4}main:\n {6}Image: +web:2/);
    expect(text).toContain("Available");
  });

  it("renders a cronjob", () => {
    const text = describe(
      { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "backup" }, spec: { schedule: "0 3 * * *", suspend: true, jobTemplate: { spec: { template: { spec: { containers: [{ name: "b", image: "restic" }] } } } } }, status: {} },
      [],
      NOW,
    );
    expect(text).toContain("Schedule:       0 3 * * *");
    expect(text).toContain("Suspend:        true");
    expect(text).toContain("Last Schedule:  <never>");
    expect(text).toContain("restic");
  });

  it("renders a service with its ports", () => {
    const text = describe(
      {
        apiVersion: "v1", kind: "Service", metadata: { name: "web" },
        spec: { type: "NodePort", clusterIP: "10.43.0.10", selector: { app: "web" }, ports: [{ name: "http", port: 80, targetPort: 3000, nodePort: 30080, protocol: "TCP" }] },
      },
      [],
      NOW,
    );
    expect(text).toContain("Type:           NodePort");
    expect(text).toContain("Selector:       app=web");
    expect(text).toMatch(/NAME +PORT +TARGET +NODEPORT\n +http +80\/TCP +3000 +30080/);
  });

  it("renders a node with roles, taints, capacity and conditions", () => {
    const text = describe(
      {
        apiVersion: "v1", kind: "Node", metadata: { name: "node-1", labels: { "node-role.kubernetes.io/control-plane": "true" } },
        spec: { unschedulable: true, taints: [{ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }] },
        status: {
          addresses: [{ type: "InternalIP", address: "192.168.1.2" }], capacity: { cpu: "4", memory: "8Gi" }, allocatable: { cpu: "4", memory: "7Gi" },
          nodeInfo: { kubeletVersion: "v1.35.1+k3s1", osImage: "Ubuntu" }, conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
        },
      },
      [],
      NOW,
    );
    expect(text).toContain("Roles:          control-plane");
    expect(text).toContain("Schedulable:    false (cordoned)");
    expect(text).toContain("Taints:         node.kubernetes.io/unschedulable:NoSchedule");
    expect(text).toMatch(/memory +8Gi +7Gi/);
    expect(text).toContain("Kubelet:        v1.35.1+k3s1");
    expect(text).toContain("KubeletReady");
  });

  it("never prints secret values, only key sizes", () => {
    const applied = JSON.stringify({ data: { password: "czNjcjN0" } });
    const text = describe(
      { apiVersion: "v1", kind: "Secret", metadata: { name: "db", annotations: { "kubectl.kubernetes.io/last-applied-configuration": applied } }, type: "Opaque", data: { password: "czNjcjN0" } },
      [],
      NOW,
    );
    expect(text).not.toContain("czNjcjN0");
    expect(text).toMatch(/password +6 bytes/);
  });

  it("falls back to conditions, spec and status for CRDs, with the Flux Ready condition on top", () => {
    const text = describe(
      {
        apiVersion: "kustomize.toolkit.fluxcd.io/v1", kind: "Kustomization", metadata: { name: "apps", namespace: "flux-system" },
        spec: { interval: "10m", suspend: false, path: "./apps", sourceRef: { kind: "GitRepository", name: "flux-system" } },
        status: {
          lastAppliedRevision: "main@sha1:abc123",
          conditions: [
            { type: "Reconciling", status: "False", reason: "Done" },
            { type: "Ready", status: "False", reason: "BuildFailed", message: "kustomize build failed", lastTransitionTime: ago(120_000) },
          ],
          inventory: { entries: [{ id: "a" }] },
        },
      },
      [],
      NOW,
    );
    expect(text).toContain("Ready:          False (BuildFailed): kustomize build failed");
    expect(text).toContain("Suspended:      false");
    expect(text).toContain("Interval:       10m");
    expect(text).toContain("Source:         GitRepository/flux-system");
    expect(text).toContain("Revision:       main@sha1:abc123");
    expect(text).toMatch(/Spec:\n {2}interval: 10m/);
    expect(text).toMatch(/Status:\n {2}lastAppliedRevision/);
    expect(text).not.toMatch(/Status:[\s\S]*conditions:/);
  });

  it("does not use the Pod section for a CRD that is also called Pod", () => {
    const text = describe({ apiVersion: "example.io/v1", kind: "Pod", metadata: { name: "x" }, spec: { foo: 1 } }, [], NOW);
    expect(text).toMatch(/Spec:\n {2}foo: 1/);
  });

  it("survives junk input", () => {
    expect(describe(null, [], NOW)).toContain("Name:");
    expect(describe({ metadata: "nope", spec: 3 } as Json, [], NOW)).toContain("Events:");
  });
});
