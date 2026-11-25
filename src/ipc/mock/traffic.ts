// Mock of TrafficBackend (contract/traffic.ts): every pod listens on 8080 and 9090, keeps a pool
// to Postgres and Kafka, asks kube-dns now and then, takes requests from the shop front, and calls
// an external API every other reading, so the aggregate in the view grows over time. Pods in
// `games` have a distroless image (no `cat`) and no debug container.
import type { BackendError, TrafficBackend, TrafficConnection, TrafficPeer } from "../types";
import { delay } from "./shared";

let reading = 0;
const svc = (namespace: string, name: string): TrafficPeer => ({ kind: "service", namespace, name });
const pod = (namespace: string, name: string, workload: string): TrafficPeer => ({ kind: "pod", namespace, name, workload });
const conn = (direction: "in" | "out", localPort: number, remoteIp: string, remotePort: number, peer: TrafficPeer, state = "ESTABLISHED", proto: "tcp" | "udp" = "tcp"): TrafficConnection => ({
  proto, direction, localPort, remoteIp, remotePort, state, peer,
});

export const trafficMock: TrafficBackend = {
  trafficSample: (req) => {
    if (req.ref.namespace === "games") {
      return Promise.reject({ code: 0, reason: "NeedsDebug", message: `no container of ${req.ref.name} could run \`cat\` (a distroless image?): add a debug container (B on the pod) and kns reads the table through it` } satisfies BackendError);
    }
    const n = reading++;
    const connections: TrafficConnection[] = [
      conn("out", 41230, "10.43.9.9", 5432, svc("payments", "postgres")),
      conn("out", 41232, "10.43.9.9", 5432, svc("payments", "postgres")),
      conn("out", 39410, "10.43.9.12", 9092, svc("kafka", "kafka")),
      conn("out", 39000 + (n % 50), "127.0.0.1", 15001, { kind: "loopback", name: "127.0.0.1" }, "TIME_WAIT"),
      conn("in", 8080, `10.42.0.${17 + (n % 3)}`, 50100 + n, pod("shop", `web-7f9c-xk2p${n % 3}`, "Deployment/web")),
      conn("in", 9090, "10.42.0.3", 46000 + n, pod("monitoring", "prometheus-0", "StatefulSet/prometheus")),
    ];
    if (n % 2 === 0) connections.push(conn("out", 44000 + n, "52.29.14.7", 443, { kind: "external", name: "52.29.14.7" }, n % 4 === 0 ? "SYN_SENT" : "ESTABLISHED"));
    if (n % 3 === 0) connections.push(conn("out", 53000 + n, "10.43.0.10", 53, svc("kube-system", "kube-dns"), "ESTABLISHED", "udp"));
    if (n % 5 === 0) connections.push(conn("out", 47000, "10.42.0.1", 8125, { kind: "node", name: "node-7f3a9c21" }, "ESTABLISHED", "udp"));
    return delay(
      {
        container: req.container ?? "app",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        listening: [{ proto: "tcp", ip: "0.0.0.0", port: 8080 }, { proto: "tcp", ip: "0.0.0.0", port: 9090 }],
        connections,
        notes: req.ref.context === "team-test" ? ["nodes: forbidden"] : [],
      },
      150,
    );
  },
};
