import { describe, expect, it } from "vitest";
import type { FieldOwner, ManagerClass } from "../ipc/types";
import { driftHidden, driftPaths, isFluxManaged, ownersByLine, ownersTip, pointerLines } from "./owners-model";

const YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: kns-spike
  labels:
    app: web
  annotations:
    kubectl.kubernetes.io/restartedAt: "2026"
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: main
          image: nginx:1.27
          ports:
            - containerPort: 80
        - name: sidecar
          image: busybox
status:
  replicas: 2
`;

const own = (path: string, managerClass: ManagerClass, manager: string = managerClass, extra: Partial<FieldOwner> = {}): FieldOwner => ({
  path, manager, managerClass, operation: managerClass === "flux" ? "Apply" : "Update", ...extra,
});

describe("pointerLines", () => {
  const lines = pointerLines(YAML);
  it("maps keys, list items and escaped keys to their lines", () => {
    expect(lines.get("/apiVersion")).toEqual({ start: 1, end: 1 });
    expect(lines.get("/metadata/labels/app")?.start).toBe(7);
    expect(lines.get("/metadata/annotations/kubectl.kubernetes.io~1restartedAt")?.start).toBe(9);
    expect(lines.get("/spec/replicas")?.start).toBe(11);
    expect(lines.get("/spec/template/spec/containers/0")?.start).toBe(15);
    expect(lines.get("/spec/template/spec/containers/0/image")?.start).toBe(16);
    expect(lines.get("/spec/template/spec/containers/0/ports/0/containerPort")?.start).toBe(18);
    expect(lines.get("/spec/template/spec/containers/1/name")?.start).toBe(19);
  });
  it("knows where a value ends", () => {
    expect(lines.get("/metadata")).toEqual({ start: 3, end: 9 });
    expect(lines.get("/spec/template/spec/containers/0")).toEqual({ start: 15, end: 18 });
  });
  it("gives nothing for broken YAML", () => {
    expect(pointerLines("a: [").size).toBe(0);
  });
});

describe("ownersByLine", () => {
  const lines = pointerLines(YAML);
  it("one letter per line, a human's change first, unknown paths dropped", () => {
    const owners = [
      own("/metadata/labels/app", "flux", "kustomize-controller"),
      own("/spec/replicas", "kubectl", "kubectl-scale", { subresource: "scale" }),
      own("/spec/template/spec/containers/0/image", "flux", "kustomize-controller"),
      own("/spec/template/spec/containers/0/image", "kubectl", "kubectl-edit"),
      own("/metadata/annotations/kubectl.kubernetes.io~1restartedAt", "kns"),
      own("/status/replicas", "controller", "kube-controller-manager", { subresource: "status" }),
      own("/spec/template/spec/containers/7/image", "flux"),
    ];
    const by = ownersByLine(owners, lines);
    expect(by.map((e) => [e.line, e.letter])).toEqual([[7, "F"], [9, "K"], [11, "k"], [16, "k"], [22, "C"]]);
    expect(by.find((e) => e.line === 16)?.owners.length).toBe(2);
  });
  it("hover text names every manager", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    const [e] = ownersByLine([own("/spec/replicas", "kubectl", "kubectl-scale", { subresource: "scale", time: "2026-11-22T11:00:00Z" })], lines);
    expect(ownersTip(e, now)).toBe("kubectl-scale · kubectl · Update scale · 60m ago");
  });
});

describe("drift", () => {
  const owners = [
    own("/metadata/labels/app", "flux"),
    own("/spec/replicas", "kubectl", "kubectl-scale"),
    own("/spec/template/spec/containers/0/image", "flux"),
    own("/spec/template/spec/containers/0/image", "kubectl", "kubectl-edit"),
    own("/metadata/annotations/kubectl.kubernetes.io~1restartedAt", "kns"),
    own("/status/replicas", "kubectl", "kubectl", { subresource: "status" }),
    own("/spec/template/spec/containers/1/image", "controller"),
  ];
  it("is what a human set and Flux does not own", () => {
    expect(isFluxManaged(owners)).toBe(true);
    expect(isFluxManaged([own("/a", "kubectl")])).toBe(false);
    expect(driftPaths(owners)).toEqual(["/metadata/annotations/kubectl.kubernetes.io~1restartedAt", "/spec/replicas"]);
  });
  it("hides everything but drift fields, their parents and the name", () => {
    const lines = pointerLines(YAML);
    const hidden = driftHidden(["/spec/replicas"], lines, 22);
    // kept: 1 apiVersion, 2 kind, 3 metadata, 4 name, 5 namespace, 10 spec, 11 replicas
    expect(hidden).toEqual([{ start: 6, end: 9 }, { start: 12, end: 22 }]);
  });
  it("keeps a whole drifted block", () => {
    const lines = pointerLines(YAML);
    const hidden = driftHidden(["/spec/template/spec/containers/0"], lines, 22);
    expect(hidden).toEqual([{ start: 6, end: 9 }, { start: 11, end: 11 }, { start: 19, end: 22 }]);
  });
});
