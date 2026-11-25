import { describe, expect, it } from "vitest";
import type { FieldOwner, ManagerClass } from "../ipc/types";
import { driftPaths, gitOpsOf, isFluxManaged, ownersByLine, pointerLines } from "./owners-model";

const own = (path: string, managerClass: ManagerClass, manager: string = managerClass): FieldOwner => ({ path, manager, managerClass, operation: "Apply" });

describe("Argo CD field owners", () => {
  const owners = [
    own("/spec/replicas", "argo", "argocd-controller"),
    own("/spec/template", "argo", "argocd-controller"),
    own("/spec/replicas", "kubectl", "kubectl-scale"),
    own("/metadata/annotations/x", "kns"),
  ];

  it("names the GitOps controller, Flux first", () => {
    expect(gitOpsOf(owners)).toBe("Argo CD");
    expect(gitOpsOf([own("/a", "flux"), own("/b", "argo")])).toBe("Flux");
    expect(gitOpsOf([own("/a", "kubectl")])).toBeNull();
    expect(isFluxManaged(owners)).toBe(false);
  });

  it("drift is what a human set that Argo CD does not own", () => {
    expect(driftPaths(owners)).toEqual(["/metadata/annotations/x"]);
  });

  it("shows A, but a human's change wins the line", () => {
    const lines = pointerLines("spec:\n  replicas: 2\n  template: {}\n");
    expect(ownersByLine(owners, lines).map((l) => [l.line, l.letter])).toEqual([[2, "k"], [3, "A"]]);
  });
});
