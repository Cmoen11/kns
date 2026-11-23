// B2: k9s annotations and the per-service address (ports.ts).
import { describe, expect, it } from "vitest";
import { hintPort, k9sHints, serviceAddress } from "./ports";

describe("k9s port-forward annotations", () => {
  it("parses [container::][local:]remote specs like Rust", () => {
    const pod = {
      metadata: {
        annotations: {
          "k9scli.io/auto-port-forwards": "zorg::5556",
          "k9scli.io/port-forwards": "bozo::9090:p1, 8080 ,web::http, bad port, 0, ::x:y, a::70000, BIG::80, 18081:8081",
        },
      },
    };
    expect(k9sHints(pod)).toEqual([
      { container: "zorg", remotePort: 5556, auto: true },
      { container: "bozo", remotePort: "p1", localPort: 9090, auto: false },
      { remotePort: 8080, auto: false },
      { container: "web", remotePort: "http", auto: false },
      { remotePort: 8081, localPort: 18081, auto: false },
    ]);
    expect(k9sHints({})).toEqual([]);
    expect(k9sHints({ metadata: { annotations: { "k9scli.io/port-forwards": 5 } } })).toEqual([]);
  });

  it("maps a named hint to the pod's port", () => {
    const ports = [{ container: "app", port: 8080, name: "http", protocol: "TCP" }];
    expect(hintPort({ remotePort: "http", auto: false }, ports)).toBe(8080);
    expect(hintPort({ remotePort: 9000, auto: false }, ports)).toBe(9000);
    expect(hintPort({ remotePort: "grpc", auto: false }, ports)).toBeNull();
  });
});

describe("address per service", () => {
  it("is stable, in 127.0.1.2-254, and skips taken ones", () => {
    const a = serviceAddress("payments/postgres", []);
    expect(a).toMatch(/^127\.0\.1\.(\d+)$/);
    expect(serviceAddress("payments/postgres", [])).toBe(a);
    const b = serviceAddress("payments/postgres", [a!]);
    expect(b).not.toBe(a);
    expect(Number(b!.split(".")[3])).toBeGreaterThanOrEqual(2);
    const all = Array.from({ length: 253 }, (_, i) => `127.0.1.${i + 2}`);
    expect(serviceAddress("x", all)).toBeNull();
  });
});
