import { describe, expect, it, vi } from "vitest";
import type { Forward, Json } from "../../ipc/types";
import type { PaneState, ViewState } from "../../types";
import { concatBytes, createBatcher, debounce, decodeBase64 } from "./bytes";
import { cssColorToHex, withAlpha } from "./colors";
import {
  ageText, containerPorts, forwardHost, forwardsChanged, forwardUrl, idleWarnings, newlyBroken, ownerText, parseLocalPort, parsePort, parseRemotePort,
  portLabel, remoteText, targetText, validAddress,
} from "./ports";
import { containerOptions, needsContainerPicker, sessionRefs } from "./session-refs";
import { copyRange, findMatches, moveCopyCursor, previousMatch, scrollTargetFor } from "./term-search";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("decodeBase64", () => {
  it("decodes to raw bytes, including non-UTF-8 ones", () => {
    expect([...decodeBase64(btoa("hi\r\n"))]).toEqual([104, 105, 13, 10]);
    expect([...decodeBase64("/wCA")]).toEqual([255, 0, 128]);
  });
  it("keeps a split UTF-8 sequence split (the terminal joins it)", () => {
    const euro = [0xe2, 0x82, 0xac];
    const a = decodeBase64(btoa(String.fromCharCode(euro[0])));
    const b = decodeBase64(btoa(String.fromCharCode(euro[1], euro[2])));
    expect([...concatBytes([a, b])]).toEqual(euro);
  });
  it("returns empty for empty or broken input", () => {
    expect(decodeBase64("").length).toBe(0);
    expect(decodeBase64("***").length).toBe(0);
  });
});

function harness(opts: { maxPending?: number; maxHeld?: number } = {}) {
  const written: number[][] = [];
  let scheduled: (() => void) | null = null;
  const b = createBatcher({
    ...opts,
    write: (x) => written.push([...x]),
    schedule: (flush) => {
      scheduled = flush;
      return () => {
        scheduled = null;
      };
    },
  });
  return { b, written, tick: () => {
      const run = scheduled as (() => void) | null;
      scheduled = null;
      run?.();
    }, isScheduled: () => scheduled !== null };
}

describe("createBatcher", () => {
  it("writes many frames as one array per tick, in order", () => {
    const h = harness();
    h.b.push(bytes(1, 2));
    h.b.push(bytes(3));
    h.b.push(bytes());
    expect(h.written).toEqual([]);
    expect(h.b.pending).toBe(3);
    h.tick();
    expect(h.written).toEqual([[1, 2, 3]]);
    expect(h.b.pending).toBe(0);
  });
  it("schedules once per batch and again for the next one", () => {
    const h = harness();
    h.b.push(bytes(1));
    h.b.push(bytes(2));
    h.tick();
    expect(h.isScheduled()).toBe(false);
    h.b.push(bytes(3));
    expect(h.isScheduled()).toBe(true);
    h.tick();
    expect(h.written).toEqual([[1, 2], [3]]);
  });
  it("flushes without waiting once maxPending is queued", () => {
    const h = harness({ maxPending: 4 });
    h.b.push(bytes(1, 2));
    h.b.push(bytes(3, 4));
    expect(h.written).toEqual([[1, 2, 3, 4]]);
    expect(h.isScheduled()).toBe(false);
  });
  it("holds output (COPY mode) and releases it in one write", () => {
    const h = harness();
    h.b.push(bytes(1));
    h.b.hold(true);
    expect(h.isScheduled()).toBe(false);
    h.b.push(bytes(2));
    h.b.push(bytes(3));
    h.tick();
    expect(h.written).toEqual([]);
    h.b.hold(false);
    expect(h.written).toEqual([[1, 2, 3]]);
  });
  it("caps what it holds", () => {
    const h = harness({ maxHeld: 3 });
    h.b.hold(true);
    h.b.push(bytes(1, 2));
    h.b.push(bytes(3));
    expect(h.written).toEqual([[1, 2, 3]]);
  });
  it("clear drops the queue and the scheduled flush", () => {
    const h = harness();
    h.b.push(bytes(1));
    h.b.clear();
    h.tick();
    expect(h.written).toEqual([]);
    expect(h.b.pending).toBe(0);
  });
});

describe("debounce", () => {
  it("runs once after the last call and can be cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d();
    vi.advanceTimersByTime(40);
    d();
    vi.advanceTimersByTime(40);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
    d();
    d.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("containerPorts", () => {
  const pod: Json = {
    spec: {
      initContainers: [{ name: "proxy", ports: [{ containerPort: 15001 }] }],
      containers: [
        { name: "web", ports: [{ containerPort: 8080, name: "http", protocol: "TCP" }, { containerPort: 9090, name: "metrics" }, { containerPort: 53, protocol: "UDP" }] },
        { name: "sidecar", ports: [{ containerPort: 8080 }, { containerPort: 0 }, { containerPort: "x" }, null] },
        { name: "bare" },
      ],
    },
  };
  it("lists TCP ports in spec order, containers before init containers", () => {
    expect(containerPorts(pod)).toEqual([
      { container: "web", port: 8080, name: "http", protocol: "TCP" },
      { container: "web", port: 9090, name: "metrics", protocol: "TCP" },
      { container: "sidecar", port: 8080, protocol: "TCP" },
      { container: "proxy", port: 15001, protocol: "TCP" },
    ]);
  });
  it("filters by container", () => {
    expect(containerPorts(pod, "sidecar").map((p) => p.port)).toEqual([8080]);
    expect(containerPorts(pod, "bare")).toEqual([]);
    expect(containerPorts(pod, "missing")).toEqual([]);
  });
  it("tolerates pods without ports and junk", () => {
    expect(containerPorts({ spec: { containers: [{ name: "main", image: "x" }] } })).toEqual([]);
    expect(containerPorts({ spec: { containers: "nope" } })).toEqual([]);
    expect(containerPorts(null)).toEqual([]);
    expect(containerPorts("pod")).toEqual([]);
    expect(containerPorts({})).toEqual([]);
  });
  it("labels a port", () => {
    expect(portLabel({ container: "web", port: 8080, name: "http", protocol: "TCP" })).toBe("8080 http (web)");
    expect(portLabel({ container: "web", port: 8080, protocol: "TCP" })).toBe("8080 (web)");
  });
});

describe("port and address input", () => {
  it("parses ports", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort(" 443 ")).toBe(443);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("80a")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("")).toBeNull();
    expect(parsePort("8e3")).toBeNull();
  });
  it("treats an empty or zero local port as 'any'", () => {
    expect(parseLocalPort("")).toBe(0);
    expect(parseLocalPort("0")).toBe(0);
    expect(parseLocalPort("3000")).toBe(3000);
    expect(parseLocalPort("http")).toBeNull();
  });
  it("validates bind addresses", () => {
    // loopback IP literals only: Rust refuses host names, wildcard and LAN addresses
    for (const ok of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", " 127.0.0.1 "]) expect(validAddress(ok)).toBe(true);
    for (const bad of ["", "0.0.0.0", "localhost", "::", "fe80::1", "10.0.0.1", "127.256.0.1", "example.com", "http://x", "127.0.0.1:80"]) expect(validAddress(bad)).toBe(false);
  });
  it("parses remote ports by number or name", () => {
    expect(parseRemotePort("9094")).toBe(9094);
    expect(parseRemotePort(" http ")).toBe("http");
    expect(parseRemotePort("local-1")).toBe("local-1");
    expect(parseRemotePort("70000")).toBeNull();
    expect(parseRemotePort("Http")).toBeNull();
    expect(parseRemotePort("-x")).toBeNull();
    expect(parseRemotePort("")).toBeNull();
  });
  it("builds the address to copy and open", () => {
    expect(forwardHost({ address: "127.0.0.1", localPort: 8080 })).toBe("localhost:8080");
    expect(forwardHost({ address: "0.0.0.0", localPort: 8080 })).toBe("localhost:8080");
    expect(forwardHost({ address: "192.168.1.5", localPort: 80 })).toBe("192.168.1.5:80");
    expect(forwardHost({ address: "fe80::1", localPort: 80 })).toBe("[fe80::1]:80");
    expect(forwardUrl({ address: "::1", localPort: 3000 })).toBe("http://localhost:3000");
  });
  it("formats ages", () => {
    expect(ageText(-5)).toBe("0s");
    expect(ageText(59_000)).toBe("59s");
    expect(ageText(61_000)).toBe("1m");
    expect(ageText(3 * 3_600_000)).toBe("3h");
    expect(ageText(72 * 3_600_000)).toBe("3d");
  });
});

describe("forward listings", () => {
  const f = (id: string, patch: Partial<Forward> = {}): Forward => ({
    id, context: "c", target: { kind: "pod", namespace: "ns", name: "web" }, namespace: "ns", pod: "web", remotePort: 80, localPort: 8080, address: "127.0.0.1",
    connections: 0, status: "active", owner: { by: "user" }, startedAt: 0, ...patch,
  });
  it("labels targets, ports and owners", () => {
    const svc = f("a", { target: { kind: "service", namespace: "kafka", name: "kafka" }, resolvedPod: "kafka-0", remotePort: "local", resolvedPort: 9094 });
    expect(targetText(svc)).toBe("svc/kafka → kafka-0");
    expect(targetText({ ...svc, status: "waiting", resolvedPod: undefined })).toBe("svc/kafka → waiting");
    expect(targetText(f("b", { target: { kind: "workload", gvr: { group: "apps", version: "v1", resource: "deployments" }, namespace: "p", name: "orders" }, resolvedPod: "orders-1" }))).toBe("deploy/orders → orders-1");
    expect(targetText(f("c"))).toBe("pod/web");
    expect(remoteText(svc)).toBe("local (9094)");
    expect(remoteText(f("d"))).toBe("80");
    expect(ownerText(f("e"))).toBe("owner: me");
    expect(ownerText(f("e", { requestedBy: "claude-code" }))).toBe("owner: me · requested by claude-code");
    expect(ownerText(f("e", { owner: { by: "agent", client: "claude-code", idleStopMinutes: 15 } }))).toBe("agent: claude-code · stops when idle 15m");
    expect(ownerText(f("e", { owner: { by: "agent", client: "claude-code", idleStopMinutes: 0 } }))).toBe("agent: claude-code");
  });
  it("warns once a minute before an idle stop", () => {
    const soon = f("a", { idleStopAt: 1_000 + 50_000 });
    const later = f("b", { idleStopAt: 1_000 + 120_000 });
    expect(idleWarnings([soon, later, f("c")], 1_000, new Set()).map((x) => x.id)).toEqual(["a"]);
    expect(idleWarnings([soon], 1_000, new Set(["a"]))).toEqual([]);
  });
  it("notices a resolution change", () => {
    expect(forwardsChanged([f("a")], [f("a", { resolvedPod: "web-2" })])).toBe(true);
    expect(forwardsChanged([f("a")], [f("a", { status: "waiting" })])).toBe(true);
  });
  it("detects changes the UI shows", () => {
    expect(forwardsChanged([f("a")], [f("a")])).toBe(false);
    expect(forwardsChanged([f("a")], [f("a", { connections: 2 })])).toBe(true);
    expect(forwardsChanged([f("a")], [f("a"), f("b")])).toBe(true);
    expect(forwardsChanged([f("a")], [f("b")])).toBe(true);
  });
  it("reports a forward as broken once", () => {
    const broken = f("a", { status: "error", message: "lost" });
    expect(newlyBroken([f("a")], [broken]).map((x) => x.id)).toEqual(["a"]);
    expect(newlyBroken([broken], [broken])).toEqual([]);
    expect(newlyBroken([], [broken, f("b")]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("cssColorToHex", () => {
  it("handles the forms a computed style produces", () => {
    expect(cssColorToHex("rgb(255, 0, 128)")).toBe("#ff0080");
    expect(cssColorToHex("rgb(255 0 128)")).toBe("#ff0080");
    expect(cssColorToHex("rgba(0, 0, 0, 0.5)")).toBe("#00000080");
    expect(cssColorToHex("rgb(0 0 0 / 50%)")).toBe("#00000080");
    expect(cssColorToHex("color(srgb 1 0.5 0)")).toBe("#ff8000");
    expect(cssColorToHex("color(srgb 0.2 0.2 0.2 / 0.6)")).toBe("#33333399");
    expect(cssColorToHex("#DFB162")).toBe("#dfb162");
    expect(cssColorToHex("#abc")).toBe("#aabbcc");
    expect(cssColorToHex("transparent")).toBe("#00000000");
  });
  it("rejects what it cannot read", () => {
    expect(cssColorToHex("var(--k-text)")).toBeNull();
    expect(cssColorToHex("oklch(0.5 0.1 20)")).toBeNull();
    expect(cssColorToHex("")).toBeNull();
  });
  it("replaces the alpha", () => {
    expect(withAlpha("#102030", 0.5)).toBe("#10203080");
    expect(withAlpha("#102030ff", 0)).toBe("#10203000");
  });
});

describe("scrollback search", () => {
  const lines = ["GET /health 200", "", "error: boom", "Error again, error twice", "done"];
  const at = (i: number) => lines[i];
  it("finds every match, case-insensitively", () => {
    expect(findMatches(at, lines.length, "error")).toEqual([
      { line: 2, col: 0, length: 5 },
      { line: 3, col: 0, length: 5 },
      { line: 3, col: 13, length: 5 },
    ]);
    expect(findMatches(at, lines.length, "")).toEqual([]);
    expect(findMatches(at, lines.length, "nope")).toEqual([]);
  });
  it("respects the cap", () => {
    expect(findMatches(() => "aaaa", 100, "a", 7).length).toBe(7);
  });
  it("walks upwards and wraps to the newest", () => {
    const m = findMatches(at, lines.length, "error");
    expect(previousMatch(m, { line: lines.length, col: 0 })).toBe(2);
    expect(previousMatch(m, { line: 3, col: 13 })).toBe(1);
    expect(previousMatch(m, { line: 3, col: 0 })).toBe(0);
    expect(previousMatch(m, { line: 2, col: 0 })).toBe(2);
    expect(previousMatch([], { line: 0, col: 0 })).toBe(-1);
  });
});

describe("copy mode cursor", () => {
  it("moves and clamps", () => {
    expect(moveCopyCursor({ line: 5, anchor: null }, "down", 10).line).toBe(6);
    expect(moveCopyCursor({ line: 9, anchor: null }, "down", 10).line).toBe(9);
    expect(moveCopyCursor({ line: 0, anchor: null }, "up", 10).line).toBe(0);
    expect(moveCopyCursor({ line: 5, anchor: 2 }, "top", 10)).toEqual({ line: 0, anchor: 2 });
    expect(moveCopyCursor({ line: 5, anchor: null }, "bottom", 10).line).toBe(9);
    expect(moveCopyCursor({ line: 0, anchor: null }, "bottom", 0).line).toBe(0);
  });
  it("selects the cursor line, or anchor to cursor in either direction", () => {
    expect(copyRange({ line: 4, anchor: null })).toEqual({ start: 4, end: 4 });
    expect(copyRange({ line: 4, anchor: 7 })).toEqual({ start: 4, end: 7 });
    expect(copyRange({ line: 9, anchor: 7 })).toEqual({ start: 7, end: 9 });
  });
  it("scrolls only when the line is off screen", () => {
    expect(scrollTargetFor(10, 5, 10)).toBeNull();
    expect(scrollTargetFor(14, 5, 10)).toBeNull();
    expect(scrollTargetFor(4, 5, 10)).toBe(4);
    expect(scrollTargetFor(15, 5, 10)).toBe(6);
  });
});

describe("session references", () => {
  const shell = (session?: string): ViewState => ({ kind: "shell", target: { by: "object", ref: { gvr: { group: "", version: "v1", resource: "pods" }, name: "web" } }, session });
  const home: ViewState = { kind: "home" };
  const pane = (id: string, history: ViewState[], index: number): PaneState => ({ id, history, index });
  it("collects ids from every open pane's history and marks the current ones", () => {
    const refs = sessionRefs({
      panes: {
        a: pane("a", [home, shell("s1")], 1),
        b: pane("b", [shell("s2"), home], 1),
        c: pane("c", [shell()], 0),
      },
    });
    expect([...refs.all].sort()).toEqual(["s1", "s2"]);
    expect([...refs.current]).toEqual([["s1", "a"]]);
  });
  it("is empty without a workspace", () => {
    expect(sessionRefs(null).all.size).toBe(0);
  });
  it("needs the picker only for several regular or ephemeral containers", () => {
    const one = containerOptions({ containers: ["main"], initContainers: ["init"], ephemeralContainers: [] });
    expect(one.map((o) => `${o.name}:${o.group}`)).toEqual(["main:container", "init:init"]);
    expect(needsContainerPicker(one)).toBe(false);
    expect(needsContainerPicker(containerOptions({ containers: ["main"], initContainers: [], ephemeralContainers: ["debug"] }))).toBe(true);
    expect(needsContainerPicker(containerOptions({ containers: ["a", "b"], initContainers: [], ephemeralContainers: [] }))).toBe(true);
  });
});
