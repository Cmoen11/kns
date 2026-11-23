import { describe, expect, it } from "vitest";
import { classifyWord, deriveStatus, isFault, leadingInt, parseRatio, type StatusInput } from "./status";
import vectors from "./__fixtures__/fault-vectors.json";

const input = (resource: string, cells: Record<string, string>, extra: Partial<StatusInput> = {}): StatusInput => ({
  resource, get: (c) => cells[c], ageSec: 3600, ...extra,
});

describe("deriveStatus", () => {
  it("pods: running and ready is ok", () => {
    expect(deriveStatus(input("pods", { status: "Running", ready: "1/1", restarts: "0" }))).toEqual({ state: "ok", word: "Running" });
  });
  it("pods: partially ready is warn, 0/N is error, young is progress", () => {
    expect(deriveStatus(input("pods", { status: "Running", ready: "1/2" }))?.state).toBe("warn");
    expect(deriveStatus(input("pods", { status: "Running", ready: "0/1" }))?.state).toBe("error");
    expect(deriveStatus(input("pods", { status: "Running", ready: "0/1" }, { ageSec: 10 }))?.state).toBe("progress");
  });
  it("pods: 5+ restarts warn", () => {
    expect(deriveStatus(input("pods", { status: "Running", ready: "1/1", restarts: "7 (2m ago)" }))?.state).toBe("warn");
  });
  it("pods: error words", () => {
    for (const w of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Error", "Failed", "Evicted", "Init:Error", "CreateContainerConfigError"]) {
      expect(deriveStatus(input("pods", { status: w, ready: "0/1" }))?.state).toBe("error");
    }
  });
  it("pods: transient states turn warn after 60s", () => {
    expect(deriveStatus(input("pods", { status: "ContainerCreating" }, { ageSec: 5 }))?.state).toBe("progress");
    expect(deriveStatus(input("pods", { status: "Pending" }, { ageSec: 300 }))?.state).toBe("warn");
    expect(deriveStatus(input("pods", { status: "Init:1/2" }, { ageSec: 5 }))?.state).toBe("progress");
  });
  it("pods: Completed is done although 0/1", () => {
    expect(deriveStatus(input("pods", { status: "Completed", ready: "0/1" }))?.state).toBe("done");
  });
  it("deletionTimestamp wins", () => {
    expect(deriveStatus(input("pods", { status: "Running", ready: "1/1" }, { deleting: true }))).toEqual({ state: "terminating", word: "Terminating" });
  });
  it("workloads derive from replicas", () => {
    expect(deriveStatus(input("deployments", { ready: "2/2" }))).toEqual({ state: "ok", word: "Ready" });
    expect(deriveStatus(input("deployments", { ready: "1/2" }))?.state).toBe("warn");
    expect(deriveStatus(input("deployments", { ready: "0/2" }))?.state).toBe("error");
    expect(deriveStatus(input("deployments", { ready: "0/0" }))?.state).toBe("done");
    expect(deriveStatus(input("daemonsets", { desired: "3", ready: "3" }))?.state).toBe("ok");
    expect(deriveStatus(input("statefulsets", { ready: "0/1" }, { ageSec: 5 }))?.state).toBe("progress");
  });
  it("cronjobs, jobs, nodes, events", () => {
    expect(deriveStatus(input("cronjobs", { suspend: "true" }))?.state).toBe("suspended");
    expect(deriveStatus(input("cronjobs", { suspend: "false" }))?.state).toBe("ok");
    expect(deriveStatus(input("jobs", { status: "Complete" }))?.state).toBe("done");
    expect(deriveStatus(input("jobs", { completions: "0/1" }))?.state).toBe("progress");
    expect(deriveStatus(input("nodes", { status: "Ready" }))?.state).toBe("ok");
    expect(deriveStatus(input("nodes", { status: "Ready,SchedulingDisabled" }))?.state).toBe("warn");
    expect(deriveStatus(input("nodes", { status: "NotReady" }))?.state).toBe("error");
    expect(deriveStatus(input("events", { type: "Warning" }))?.state).toBe("warn");
    expect(deriveStatus(input("events", { type: "Normal" }))?.state).toBe("none");
  });
  it("flux kinds read Ready and Suspended", () => {
    expect(deriveStatus(input("kustomizations", { ready: "True" }, { flux: true }))?.state).toBe("ok");
    expect(deriveStatus(input("kustomizations", { ready: "False" }, { flux: true }))?.state).toBe("error");
    expect(deriveStatus(input("helmreleases", { ready: "Unknown" }, { flux: true }))?.state).toBe("progress");
    expect(deriveStatus(input("helmreleases", { ready: "True", suspended: "True" }, { flux: true }))?.state).toBe("suspended");
  });
  it("generic kinds use a Status or Phase column; kinds without one have no status", () => {
    expect(deriveStatus(input("persistentvolumeclaims", { status: "Bound" }))?.state).toBe("ok");
    expect(deriveStatus(input("persistentvolumes", { status: "Released" }))?.state).toBe("warn");
    expect(deriveStatus(input("namespaces", { status: "Active" }))?.state).toBe("ok");
    expect(deriveStatus(input("widgets", { phase: "Failed" }))?.state).toBe("error");
    expect(deriveStatus(input("configmaps", { data: "3" }))).toBeNull();
  });
  it("containers", () => {
    expect(deriveStatus(input("containers", { state: "Running", ready: "true" }))?.state).toBe("ok");
    expect(deriveStatus(input("containers", { state: "Completed", ready: "false" }))?.state).toBe("done");
    expect(deriveStatus(input("containers", { state: "CrashLoopBackOff", ready: "false" }))?.state).toBe("error");
    expect(deriveStatus(input("containers", { state: "PodInitializing", ready: "false" }, { ageSec: 5 }))?.state).toBe("progress");
  });
  it("faults are warn and error only", () => {
    expect(isFault({ state: "warn", word: "" })).toBe(true);
    expect(isFault({ state: "error", word: "" })).toBe(true);
    expect(isFault({ state: "progress", word: "" })).toBe(false);
    expect(isFault(null)).toBe(false);
  });
});

describe("helpers", () => {
  it("parseRatio / leadingInt / classifyWord", () => {
    expect(parseRatio("2/3")).toEqual([2, 3]);
    expect(parseRatio("x")).toBeNull();
    expect(leadingInt("12 (3h ago)")).toBe(12);
    expect(leadingInt(undefined)).toBeNull();
    expect(classifyWord("Unknown")).toBe("unknown");
    expect(classifyWord("Terminating")).toBe("terminating");
    expect(classifyWord("something-new")).toBe("unknown");
  });
});

// The shared vectors: src-tauri/src/nshealth.rs checks the same file (namespace health counts).

describe("fault vectors shared with Rust", () => {
  for (const v of vectors.vectors as unknown as { resource: string; cells: Record<string, string>; ageSec: number; deleting?: boolean; state: string }[]) {
    it(`${v.resource} ${JSON.stringify(v.cells)} ${v.ageSec}s -> ${v.state}`, () => {
      expect(deriveStatus(input(v.resource, v.cells, { ageSec: v.ageSec, deleting: v.deleting }))?.state).toBe(v.state);
    });
  }
});
