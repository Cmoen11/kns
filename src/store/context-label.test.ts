import { describe, expect, it } from "vitest";
import { contextDetail, shortClusterName } from "./context-label";

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster/pd-1";

describe("context labels", () => {
  it("shortens EKS ARNs and GKE names", () => {
    expect(shortClusterName(ARN)).toBe("pd-1 · 123456789012 · eu-west-1");
    expect(shortClusterName("gke_my-proj_europe-north1_main")).toBe("main · my-proj");
    expect(shortClusterName("rancher-desktop")).toBe("rancher-desktop");
  });

  it("names the cluster once when the user is named after it", () => {
    expect(contextDetail(ARN, ARN)).toBe("pd-1 · 123456789012 · eu-west-1");
    expect(contextDetail("rancher-desktop", "rancher-desktop")).toBe("rancher-desktop");
    expect(contextDetail("kind-dev", "admin")).toBe("kind-dev / admin");
    expect(contextDetail(ARN, "")).toBe("pd-1 · 123456789012 · eu-west-1");
  });
});
