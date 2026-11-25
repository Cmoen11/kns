import { describe, expect, it } from "vitest";
import type { TrafficConnection, TrafficSample } from "../ipc/types";
import { addSample, ago, connecting, EMPTY, flowStatus, peerKey, peerLabel, sortFlows } from "./model";

const pg: TrafficConnection = { proto: "tcp", direction: "out", localPort: 41230, remoteIp: "10.43.9.9", remotePort: 5432, state: "ESTABLISHED", peer: { kind: "service", namespace: "payments", name: "postgres" } };
const web = (n: number): TrafficConnection => ({ proto: "tcp", direction: "in", localPort: 8080, remoteIp: `10.42.0.${n}`, remotePort: 50000 + n, state: "ESTABLISHED", peer: { kind: "pod", namespace: "shop", name: `web-${n}`, workload: "Deployment/web" } });
const ext: TrafficConnection = { proto: "tcp", direction: "out", localPort: 44000, remoteIp: "52.1.2.3", remotePort: 443, state: "SYN_SENT", peer: { kind: "external", name: "52.1.2.3" } };
const sample = (connections: TrafficConnection[]): TrafficSample => ({ container: "app", at: "", listening: [{ proto: "tcp", ip: "0.0.0.0", port: 8080 }], connections });

describe("traffic model", () => {
  it("groups connections into flows: outbound by peer port, inbound by own port and workload", () => {
    const t = addSample(EMPTY, sample([pg, { ...pg, localPort: 41231 }, web(17), web(18), ext]), 1000);
    expect(t.readings).toBe(1);
    expect(t.flows.size).toBe(3);
    const pool = t.flows.get("out|tcp|svc:payments/postgres|5432")!;
    expect(pool).toMatchObject({ open: 2, port: 5432, seen: 1, states: ["ESTABLISHED"] });
    const inbound = t.flows.get("in|tcp|pod:shop/Deployment/web|8080")!;
    expect(inbound).toMatchObject({ open: 2, members: ["web-17", "web-18"] });
    expect(connecting(t.flows.get("out|tcp|external:52.1.2.3|443")!)).toBe(true);
  });

  it("keeps a flow it saw before, closed, and counts readings", () => {
    const t1 = addSample(EMPTY, sample([pg, ext]), 1000);
    const t2 = addSample(t1, sample([pg]), 4000);
    const gone = t2.flows.get("out|tcp|external:52.1.2.3|443")!;
    expect(gone).toMatchObject({ open: 0, states: [], lastAt: 1000, seen: 1 });
    expect(connecting(gone)).toBe(false);
    expect(flowStatus(gone, 13000)).toBe("seen 12 s ago");
    const pool = t2.flows.get("out|tcp|svc:payments/postgres|5432")!;
    expect(pool).toMatchObject({ seen: 2, firstAt: 1000, lastAt: 4000 });
    expect(flowStatus(pool, 4000)).toBe("1 open · ESTABLISHED");
  });

  it("names peers and sorts them stably", () => {
    expect(peerLabel(pg.peer, "shop")).toBe("svc payments/postgres");
    expect(peerLabel(web(1).peer, "shop")).toBe("deployment web");
    expect(peerLabel({ kind: "pod", namespace: "monitoring", name: "p-0", workload: "StatefulSet/prometheus" }, "shop")).toBe("statefulset monitoring/prometheus");
    expect(peerLabel({ kind: "pod", namespace: "shop", name: "lone" }, "shop")).toBe("pod lone");
    expect(peerLabel({ kind: "loopback", name: "127.0.0.1" }, "shop")).toBe("localhost (a container of this pod)");
    expect(peerKey({ kind: "pod", namespace: "x", name: "p-1" })).toBe("pod:x/p-1");
    const t = addSample(EMPTY, sample([pg, web(1), ext]), 0);
    expect(sortFlows(t.flows.values(), "shop").map((f) => f.port)).toEqual([443, 8080, 5432]);
    expect(ago(30_000)).toBe("30 s");
    expect(ago(600_000)).toBe("10 min");
  });
});
