import { describe, expect, it } from "vitest";
import type { NsHealth, NsHealthSnapshot } from "../ipc/types";
import { faultsResource, healthText, knows, merged, nsCount, nsSeverity, problemsFirst, shareEntries, totals } from "./health-model";

const spike: NsHealth = { namespace: "kns-spike", podsFailing: 2, podsWarn: 1, workloads: [{ kind: "deployments", down: 1, degraded: 1 }] };
const games: NsHealth = { namespace: "games", podsFailing: 0, podsWarn: 1, workloads: [] };
const dbOnly: NsHealth = { namespace: "db", podsFailing: 0, podsWarn: 0, workloads: [{ kind: "statefulsets", down: 0, degraded: 1 }] };
const snap = (namespaces: NsHealth[], state: NsHealthSnapshot["state"] = "live"): NsHealthSnapshot => ({ context: "default", state, namespaces, pods: 10, workloads: 3 });

describe("namespace health model", () => {
  it("counts and grades a namespace", () => {
    expect(nsCount(spike)).toBe(5);
    expect(nsSeverity(spike)).toBe("error");
    expect(nsSeverity(games)).toBe("warn");
    expect(nsSeverity(undefined)).toBeNull();
    expect(nsCount(undefined)).toBe(0);
  });
  it("says what is wrong in words", () => {
    expect(healthText(spike)).toBe("2 pods failing, 1 pod warning, 1 deployment down, 1 deployment degraded");
    expect(healthText(dbOnly)).toBe("1 statefulset degraded");
    expect(healthText(undefined)).toBe("healthy");
  });
  it("opens pods, or the faulty workload kind", () => {
    expect(faultsResource(spike)).toBe("pods");
    expect(faultsResource(dbOnly)).toBe("statefulsets");
    expect(faultsResource(undefined)).toBe("pods");
  });
  it("sums every namespace", () => {
    const t = totals(snap([spike, games]));
    expect(t).toEqual({ namespaces: 2, count: 6, failing: 3, severity: "error" });
    expect(totals(snap([games])).severity).toBe("warn");
    expect(totals(null).count).toBe(0);
    expect(merged(snap([spike, dbOnly]))).toEqual({ namespace: "*", podsFailing: 2, podsWarn: 1, workloads: [{ kind: "deployments", down: 1, degraded: 1 }, { kind: "statefulsets", down: 0, degraded: 1 }] });
  });
  it("knows when the snapshot says something", () => {
    expect(knows(snap([], "live"))).toBe(true);
    expect(knows(snap([], "partial"))).toBe(true);
    expect(knows(snap([], "forbidden"))).toBe(false);
    expect(knows(snap([], "syncing"))).toBe(false);
    expect(knows(null)).toBe(false);
  });
  it("puts problems first, errors before warnings, stable otherwise", () => {
    const by = new Map([spike, games].map((h) => [h.namespace, h]));
    expect(problemsFirst(["a", "games", "b", "kns-spike", "c"], by)).toEqual(["kns-spike", "games", "a", "b", "c"]);
  });
  it("keeps unchanged entries by identity", () => {
    const prev = new Map([[spike.namespace, spike]]);
    const next = shareEntries(prev, [{ ...spike }, games]);
    expect(next.get("kns-spike")).toBe(spike);
    expect(next.get("games")).toBe(games);
    expect(shareEntries(prev, [{ ...spike, podsWarn: 9 }]).get("kns-spike")).not.toBe(spike);
  });
});
