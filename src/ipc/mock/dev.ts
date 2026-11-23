// Mock of DevBackend (contract/dev.ts). Owner B-dev.
// Seeds: a human, approved set `shop` and an agent-authored, unapproved set `orders-dev`.
// deploy/orders in shop has 14 env keys (9 from secrets), 3 dependencies (kafka with a LOCAL
// listener, schema-registry, postgres) and one side effect (the consumer group).
import type {
  ConnCopyResult, ConnInfo, ConnMemory, DevBackend, DevForward, DevSet, DevSetDraft, DevSetFailure, EnvExportResult, ExportConfirm, EnvReport, EnvRow, EnvSpec, Forward, ObjRef,
  Rewrite, SecretKeyRef, SecretKeys, ServiceKind, VolumeInfo, VolumesExportResult,
} from "../types";
import { inMockRepo, MOCK_REPO, mockSaveDialog } from "./dialog";
import { emitMock } from "./events";
import { mockServiceInfo, mockStartForward, registerMockObjects } from "./fwd";
import { delay, fail, mockContextFlags, mockForwards, mockHash, mockId, nowIso } from "./shared";

const DEPLOY = { group: "apps", version: "v1", resource: "deployments" };
registerMockObjects("deployments", [{ namespace: "shop", name: "orders", cells: ["1/1", 1, 1, "12d"] }]);

/** sha256 stand-in over everything except name, updatedAt, origin, approvedHash, hash, approvedSnapshot. */
export function devSetHash(set: Omit<DevSet, "hash" | "updatedAt"> | DevSet): string {
  const { name: _n, origin: _o, approvedHash: _a, approvedSnapshot: _s, ...rest } = set as DevSet;
  const { hash: _h, updatedAt: _u, ...content } = rest;
  return mockHash(content);
}

const kafkaFwd: DevForward = { key: "kafka", target: { kind: "service", namespace: "kafka", name: "kafka" }, remotePort: 9094, localPort: 9094, pin: true, label: "kafka" };
const registryFwd: DevForward = { key: "schema-registry", target: { kind: "service", namespace: "kafka", name: "schema-registry" }, remotePort: 8081, localPort: 18081, pin: true };
const postgresFwd: DevForward = { key: "postgres", target: { kind: "service", namespace: "payments", name: "postgres" }, remotePort: 5432, localPort: 15432, pin: true };
const rewrites: Rewrite[] = [
  { match: { service: "kafka", namespace: "kafka", port: 9092 }, to: { forward: "kafka" } },
  { match: { service: "schema-registry", namespace: "kafka", port: 8081 }, to: { forward: "schema-registry" } },
  { match: { service: "postgres", namespace: "payments", port: 5432 }, to: { forward: "postgres" } },
];
const ordersEnv: EnvSpec = {
  workload: { gvr: DEPLOY, namespace: "shop", name: "orders" },
  container: "orders",
  overrides: [{ key: "SPRING_KAFKA_CONSUMER_GROUP_ID", value: "orders-local-me" }],
  format: "dotenv",
};

function seal(set: Omit<DevSet, "hash">, approved: boolean): DevSet {
  const hash = devSetHash(set);
  const full: DevSet = { ...set, hash };
  if (!approved) return full;
  const { approvedSnapshot: _s, ...snapshot } = { ...full, approvedHash: hash };
  return { ...full, approvedHash: hash, approvedSnapshot: snapshot };
}

const sets = new Map<string, DevSet>();
for (const s of [
  seal({ id: "ds-shop", name: "shop", context: "default", forwards: [kafkaFwd, postgresFwd], rewrites: [rewrites[0], rewrites[2]], autoStart: false, origin: { by: "user" }, updatedAt: nowIso() }, true),
  seal(
    { id: "ds-orders-dev", name: "orders-dev", context: "default", forwards: [kafkaFwd, registryFwd, postgresFwd], rewrites, env: ordersEnv, autoStart: false, origin: { by: "agent", client: "claude-code", at: nowIso() }, updatedAt: nowIso() },
    false,
  ),
]) {
  sets.set(s.id, s);
}

/** Saves a draft as `origin` (agents: same rules as Rust's devset::save for ownership and stripping). */
export function mockSaveDevSet(draft: DevSetDraft, origin: DevSet["origin"]): { set: DevSet; warnings: string[] } {
  if (!/^[a-z0-9-]{1,40}$/.test(draft.name)) throw { code: 0, reason: "Invalid", message: `a set name is 1-40 of a-z 0-9 -, not "${draft.name}"` };
  const ports = draft.forwards.map((f) => f.localPort);
  if (new Set(ports).size !== ports.length) throw { code: 0, reason: "Invalid", message: "a local port is used twice" };
  const prev = draft.id ? sets.get(draft.id) : undefined;
  if (origin.by === "agent" && prev && (prev.origin.by !== "agent" || prev.origin.client !== origin.client)) {
    throw { code: 403, reason: "NotOwner", message: `set "${prev.name}" was not created by ${origin.client}; save a copy instead` };
  }
  const clash = [...sets.values()].find((s) => s.name === draft.name && s.context === draft.context && s.id !== draft.id);
  if (clash) throw { code: 409, reason: "Conflict", message: `a set named ${draft.name} exists in ${draft.context}` };
  const agent = origin.by === "agent";
  const base: Omit<DevSet, "hash"> = {
    id: prev?.id ?? mockId("ds-"),
    name: draft.name,
    context: draft.context,
    forwards: draft.forwards,
    rewrites: draft.rewrites,
    env: draft.env && agent ? { ...draft.env, includeSecrets: undefined } : draft.env,
    autoStart: agent ? false : draft.autoStart,
    connSecrets: agent ? undefined : draft.connSecrets,
    origin: agent ? origin : { by: "user" },
    updatedAt: nowIso(),
  };
  let set = seal(base, !agent);
  if (agent && prev?.approvedSnapshot) set = { ...set, approvedSnapshot: prev.approvedSnapshot };
  sets.set(set.id, set);
  emitMock({ type: "devSets", context: set.context });
  return { set, warnings: [] };
}

export function mockDevSet(id: string): DevSet | undefined {
  return sets.get(id);
}

const secret = (key: string, from: string, hits: EnvRow["hits"] = []): EnvRow => ({ key, source: "secret", from, masked: true, hits });

function ordersReport(): EnvReport {
  return {
    container: "orders",
    containers: ["orders"],
    rows: [
      { key: "KAFKA_BOOTSTRAP_SERVERS", source: "literal", value: "kafka.kafka.svc.cluster.local:9092", masked: false, hits: [{ service: "kafka", namespace: "kafka", port: 9092, span: [0, 34] }] },
      { key: "SCHEMA_REGISTRY_URL", source: "configMap", from: "configmap/orders:SCHEMA_REGISTRY_URL", value: "http://schema-registry.kafka:8081", masked: false, hits: [{ service: "schema-registry", namespace: "kafka", port: 8081, span: [7, 33] }] },
      { key: "SPRING_KAFKA_CONSUMER_GROUP_ID", source: "literal", value: "orders", masked: false, hits: [] },
      { key: "LOG_LEVEL", source: "configMap", from: "configmap/orders", value: "info", masked: false, hits: [] },
      { key: "JAVA_OPTS", source: "literal", value: "-Xmx256m", masked: false, hits: [] },
      secret("DATABASE_URL", "secret/orders:DATABASE_URL", [{ service: "postgres", namespace: "payments", port: 5432 }]),
      secret("API_PASSWORD", "secret/orders:API_PASSWORD"),
      secret("DB_USER", "secret/orders-db:username"),
      secret("DB_PASSWORD", "secret/orders-db:password"),
      secret("PRICING_API_KEY", "secret/orders-keys:PRICING_API_KEY"),
      secret("SHIPPING_TOKEN", "secret/orders-keys:SHIPPING_TOKEN"),
      secret("OAUTH_CLIENT_SECRET", "secret/orders-keys:OAUTH_CLIENT_SECRET"),
      secret("MAPS_API_KEY", "secret/orders-keys:MAPS_API_KEY"),
      secret("PAYMENT_PASSWORD", "secret/orders-keys:PAYMENT_PASSWORD"),
    ],
    deps: [
      { service: svc("kafka", "kafka"), port: 9092, kind: "kafka", ready: true, suggestedForward: kafkaFwd, suggestedRewrite: rewrites[0], notes: ["advertised as kafka.kafka.svc.cluster.local:9092; use listener LOCAL, pinned 9094"] },
      { service: svc("kafka", "schema-registry"), port: 8081, kind: "schemaRegistry", ready: true, suggestedForward: registryFwd, suggestedRewrite: rewrites[1], notes: [] },
      { service: svc("payments", "postgres"), port: 5432, kind: "postgres", ready: true, suggestedForward: postgresFwd, suggestedRewrite: rewrites[2], notes: [] },
    ],
    warnings: ["SPRING_KAFKA_CONSUMER_GROUP_ID=orders: a local run joins the in-cluster consumer group; override suggested (orders-local-me)"],
    overrides: [{ key: "SPRING_KAFKA_CONSUMER_GROUP_ID", value: "orders-local-me" }],
    redactions: { count: 0, byRule: {} },
  };
}

function otherReport(ref: ObjRef, container?: string): EnvReport {
  const c = container ?? ref.name;
  return {
    container: c,
    containers: [c],
    rows: [
      { key: "LOG_LEVEL", source: "literal", value: "info", masked: false, hits: [] },
      { key: "PORT", source: "literal", value: "8080", masked: false, hits: [] },
      secret("API_TOKEN", `secret/${ref.name}:API_TOKEN`),
      { key: "POD_IP", source: "field", from: "status.podIP", masked: false, hits: [] },
    ],
    deps: [],
    warnings: [],
    overrides: [],
    redactions: { count: 0, byRule: {} },
  };
}

function svc(namespace: string, name: string): ObjRef {
  return { context: "default", gvr: { group: "", version: "v1", resource: "services" }, namespace, name };
}

const reportFor = (ref: { name: string; namespace?: string }, container?: string): EnvReport =>
  ref.name === "orders" ? ordersReport() : otherReport({ context: "default", gvr: DEPLOY, name: ref.name, namespace: ref.namespace }, container);

/** Keys and secret keys an export of `spec` writes (the mock's export_entries). */
function exportCounts(spec: EnvSpec): { keys: number; secretKeys: number } {
  const report = reportFor(spec.workload, spec.container);
  const allowed = new Set(spec.includeSecrets ?? []);
  const keys = new Set<string>();
  let secretKeys = 0;
  for (const r of report.rows) {
    if (spec.include && !spec.include.includes(r.key)) continue;
    if (spec.exclude?.includes(r.key)) continue;
    if (r.source === "field" || r.source === "resourceField") continue;
    if (r.source === "secret") {
      if (!allowed.has(r.key)) continue;
      secretKeys++;
    }
    keys.add(r.key);
  }
  for (const o of spec.overrides ?? []) keys.add(o.key);
  return { keys: keys.size, secretKeys };
}

const exportResult = (keys: number, secretKeys: number, extra: Partial<EnvExportResult> = {}): EnvExportResult => ({ keys, secretKeys, ...extra });

// ── B2: connection strings and mounted volumes ──

/** Secrets per namespace (only key names leave "Rust"); the values feed the mock connection string. */
const MOCK_SECRETS: Record<string, { name: string; type: string; data: Record<string, string> }[]> = {
  "payments": [
    { name: "postgres", type: "Opaque", data: { DATABASE_URL: "postgres://app:s3cr3t-value@postgres.payments.svc:5432/app?sslmode=disable", PASSWORD: "s3cr3t-value", USERNAME: "app" } },
  ],
  kafka: [{ name: "kafka-user", type: "Opaque", data: { password: "s3cr3t-value", username: "orders" } }],
  shop: [
    { name: "orders", type: "Opaque", data: { DATABASE_URL: "postgres://app:s3cr3t-value@postgres.payments.svc:5432/app", API_PASSWORD: "s3cr3t-value" } },
    { name: "orders-db", type: "Opaque", data: { username: "app", password: "s3cr3t-value" } },
  ],
};
const secretsIn = (ns: string) => MOCK_SECRETS[ns] ?? [{ name: `${ns}-creds`, type: "Opaque", data: { username: "app", password: "s3cr3t-value" } }];

/** Picks kept for forwards outside an approved set, until they stop (Rust: ConnPicks). */
const connPicks = new Map<string, SecretKeyRef>();

const SCHEMES: Partial<Record<ServiceKind, string>> = { postgres: "postgres", mysql: "mysql", redis: "redis", mongodb: "mongodb", rabbitmq: "amqp", http: "http", schemaRegistry: "http" };
const localHost = (address: string) => (address === "127.0.0.1" || !address ? "localhost" : address.includes(":") ? `[${address}]` : address);
const connPlain = (kind: ServiceKind, host: string, port: number) => {
  const scheme = SCHEMES[kind];
  return scheme ? `${scheme}://${host}:${port}/` : `${host}:${port}`;
};

const PORT_KINDS: Record<number, ServiceKind> = { 5432: "postgres", 3306: "mysql", 6379: "redis", 9092: "kafka", 27017: "mongodb", 5672: "rabbitmq", 80: "http", 8080: "http" };
function forwardKind(f: Forward): ServiceKind {
  if (f.target.kind === "service") {
    return mockServiceInfo({ context: f.context, gvr: { group: "", version: "v1", resource: "services" }, namespace: f.target.namespace, name: f.target.name }).kind;
  }
  const port = f.resolvedPort ?? (typeof f.remotePort === "number" ? f.remotePort : 0);
  return PORT_KINDS[port] ?? "unknown";
}

function forwardSet(f: Forward): { set: DevSet; key: string } | null {
  const set = f.devSet ? sets.get(f.devSet) : undefined;
  const d = set?.forwards.find((x) => (x.label ?? x.key) === f.label && JSON.stringify(x.target) === JSON.stringify(f.target));
  return set && d ? { set, key: d.key } : null;
}

function rememberedPick(f: Forward, fs: { set: DevSet; key: string } | null): { pick: SecretKeyRef; memory: ConnMemory } | null {
  const inSet = fs?.set.connSecrets?.find((c) => c.forward === fs.key);
  if (inSet) return { pick: inSet.secret, memory: "set" };
  for (const id of [...connPicks.keys()]) if (!mockForwards.has(id)) connPicks.delete(id);
  const p = connPicks.get(f.id);
  return p ? { pick: p, memory: "forward" } : null;
}

/** The mock connection string: a URL secret pointed at the forward, else the password in the URL. */
function mockConnString(kind: ServiceKind, host: string, port: number, value: string, user?: string): string {
  const url = /^(jdbc:)?([a-z][a-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?[^/?#]*(.*)$/i.exec(value);
  if (url) return `${url[1] ?? ""}${url[2]}://${url[3] ? `${url[3]}@` : ""}${host}:${port}${url[4]}`;
  if (kind === "kafka") return `${host}:${port}`;
  const pw = encodeURIComponent(value);
  const u = user ? encodeURIComponent(user) : "";
  const scheme = SCHEMES[kind];
  return scheme ? `${scheme}://${u}:${pw}@${host}:${port}/` : `${u}:${pw}@${host}:${port}`;
}
/** Like Rust's addr::conn_preview: built with the mask in place (whole userinfo, password=, user=). */
function mockConnPreview(kind: ServiceKind, host: string, port: number, value: string): string {
  const url = /^(jdbc:)?([a-z][a-z0-9+.-]*):\/\/(?:([^/?#]*)@)?[^/?#@]*(.*)$/i.exec(value);
  if (url) return `${url[1] ?? ""}${url[2]}://${url[3] !== undefined ? "•••@" : ""}${host}:${port}${url[4]}`.replace(/(password=)[^&]*/gi, "$1•••");
  if (kind === "kafka") return `${host}:${port}`;
  const scheme = SCHEMES[kind];
  return scheme ? `${scheme}://•••:•••@${host}:${port}/` : `•••:•••@${host}:${port}`;
}

/** Volumes of a workload's container; deploy/orders mounts a ConfigMap and two Secrets (one unreadable). */
function mockVolumes(ref: ObjRef): VolumeInfo[] {
  if (ref.name === "orders") {
    return [
      { id: "config", source: "configMap", object: "orders", mountPath: "/config", files: ["application.yaml", "logback.xml"], readable: true },
      { id: "db", source: "secret", object: "orders-db", mountPath: "/run/secrets/db", files: ["username", "password"], readable: true },
      { id: "keys", source: "secret", object: "orders-keys", mountPath: "/run/secrets/keys", files: [], readable: false, message: "Forbidden" },
    ];
  }
  return [{ id: "config", source: "configMap", object: ref.name, mountPath: "/etc/config", files: ["config.yaml"], readable: true }];
}

/** The B2 methods of DevBackend. */
const connMock: Pick<DevBackend, "connSecretsList" | "forwardConnInfo" | "forwardConnCopy" | "volumesList" | "volumesExport"> = {
  connSecretsList: (_context, namespace) => delay(secretsIn(namespace).map((x): SecretKeys => ({ name: x.name, type: x.type, keys: Object.keys(x.data).sort() }))),
  forwardConnInfo: (id) => {
    const f = mockForwards.get(id);
    if (!f) return fail("NotFound", `forward ${id} is not running`, 404);
    const kind = forwardKind(f);
    const fs = forwardSet(f);
    const rem = rememberedPick(f, fs);
    return delay<ConnInfo>({
      forward: id,
      kind,
      plain: connPlain(kind, localHost(f.address), f.localPort),
      remembered: rem?.pick,
      memory: rem?.memory,
      devSet: fs?.set.id,
      devSetApproved: fs ? fs.set.approvedHash === fs.set.hash : undefined,
    });
  },
  forwardConnCopy: (req) => {
    const f = mockForwards.get(req.forward);
    if (!f) return fail("NotFound", `forward ${req.forward} is not running`, 404);
    if (req.secret && req.secret.namespace !== f.namespace) return fail("Invalid", `the Secret must be in the forward's namespace ${f.namespace}`);
    const kind = forwardKind(f);
    const host = localHost(f.address);
    const fs = forwardSet(f);
    let remembered: ConnMemory | undefined;
    if (req.secret && req.remember && !req.plain) {
      if (fs && fs.set.approvedHash === fs.set.hash) {
        const s = fs.set;
        const connSecrets = [...(s.connSecrets ?? []).filter((c) => c.forward !== fs.key), { forward: fs.key, secret: req.secret }];
        const { hash: _h, approvedHash: _a, approvedSnapshot: _s, ...rest } = s;
        sets.set(s.id, seal({ ...rest, connSecrets, updatedAt: nowIso() }, true));
        emitMock({ type: "devSets", context: s.context });
        remembered = "set";
      } else {
        connPicks.set(f.id, req.secret);
        remembered = "forward";
      }
    }
    const pick = req.plain ? undefined : (req.secret ?? rememberedPick(f, fs)?.pick);
    if (!pick) {
      const text = connPlain(kind, host, f.localPort);
      return delay<ConnCopyResult>({ preview: text, copied: false, text });
    }
    const secretObj = secretsIn(pick.namespace).find((x) => x.name === pick.name);
    const value = secretObj?.data[pick.key];
    if (value === undefined) return fail("NotFound", `secret ${pick.name} has no key ${pick.key}`, 404);
    const userKey = Object.keys(secretObj?.data ?? {}).find((k) => k !== pick.key && /^(user(name)?|.*_user(name)?)$/i.test(k));
    const text = mockConnString(kind, host, f.localPort, value, userKey ? secretObj?.data[userKey] : undefined);
    console.info(`[mock] Rust would write a ${text.length}-character connection string to the clipboard (the webview never gets it)`);
    const secs = req.clearSeconds ?? 60;
    return delay<ConnCopyResult>({ preview: mockConnPreview(kind, host, f.localPort, value), copied: true, secret: pick, clearSeconds: Math.min(600, Math.max(5, secs)), historyExcluded: false, remembered });
  },
  volumesList: (ref, container) => delay({ container: container ?? ref.name, containers: [container ?? ref.name], volumes: mockVolumes(ref) }, 80),
  volumesExport: async (req): Promise<VolumesExportResult> => {
    const vols = mockVolumes(req.ref);
    if (req.confirmToken) {
      // like Rust: the typed text must match what was asked
      const p = takeConfirm(req.confirmToken, req.confirmText);
      return "path" in p ? { files: 2, secretFiles: 2, path: p.path } : p.error;
    }
    if (req.volumes.length === 0) return fail("Invalid", "pick at least one volume");
    const prot = protectedConfirm(req.ref.context, req.ref.name, req.confirmText);
    if (prot) return prot;
    let files = 0;
    let secretFiles = 0;
    for (const id of req.volumes) {
      const v = vols.find((x) => x.id === id);
      if (!v) return fail("NotFound", `no mounted volume ${id}`, 404);
      if (!v.readable) return fail("Invalid", `volume ${id} (${v.object}) is not readable: ${v.message ?? "forbidden"}`);
      files += v.files.length;
      if (v.source === "secret") secretFiles += v.files.length;
    }
    const path = await mockSaveDialog("mounted");
    if (path === null) return { files: 0, secretFiles: 0, cancelled: true };
    if (inMockRepo(path)) return { files, secretFiles, confirm: askConfirm(path, req.ref.name, `${path} is inside the git work tree ${MOCK_REPO} and is not git-ignored`) };
    return { files, secretFiles, path };
  },
};

/** Rust: env::protected_confirm */
function protectedConfirm(context: string, expect: string, typed: string | undefined): Promise<never> | undefined {
  if (!mockContextFlags(context).protected || typed?.trim() === expect) return undefined;
  return fail("ConfirmText", `${context} is a protected context: type ${expect} to export`, 409);
}

// typed confirmations the mock asked for (Rust keeps them in PendingExports / PendingVolumeExports)
const pendingConfirms = new Map<string, { path: string; expect: string }>();
let confirmSeq = 0;
function askConfirm(path: string, expect: string, reason: string): ExportConfirm {
  const token = `export-${++confirmSeq}`;
  pendingConfirms.set(token, { path, expect });
  return { token, path, reason, typeToConfirm: expect };
}
function takeConfirm(token: string, typed: string | undefined): { path: string } | { error: Promise<never> } {
  const p = pendingConfirms.get(token);
  if (!p) return { error: fail("Invalid", "that export question expired; export again") };
  if (typed?.trim() !== p.expect) return { error: fail("ConfirmText", `type ${p.expect} to confirm writing there`, 409) };
  pendingConfirms.delete(token);
  return { path: p.path };
}

// autoStart failures (Rust: devset::failures); `__knsMock.autostart(id)` plays one
const failures: DevSetFailure[] = [];
export function mockRecordDevSetFailure(f: DevSetFailure): void {
  const i = failures.findIndex((x) => x.devSet === f.devSet);
  if (i >= 0) failures.splice(i, 1);
  failures.push(f);
  emitMock({ type: "devSets", context: f.context });
}

/** Like Rust after connect: brings up an approved set by itself and records a failure. */
export async function mockAutostart(id: string): Promise<void> {
  const set = sets.get(id);
  if (!set) return;
  try {
    await devMock.devSetUp(id, set.hash);
    const i = failures.findIndex((x) => x.devSet === id);
    if (i >= 0) failures.splice(i, 1);
  } catch (e) {
    mockRecordDevSetFailure({ devSet: id, name: set.name, context: set.context, message: (e as { message?: string }).message ?? String(e), at: nowIso() });
  }
}

export const devMock: DevBackend = {
  ...connMock,
  devSetFailures: (clear) => {
    for (const id of clear ?? []) {
      const i = failures.findIndex((x) => x.devSet === id);
      if (i >= 0) failures.splice(i, 1);
    }
    return delay([...failures], 20);
  },
  devSetsList: (context) => delay([...sets.values()].filter((s) => !context || s.context === context)),
  devSetSave: (draft) => {
    try {
      return delay(mockSaveDevSet(draft, { by: "user" }));
    } catch (e) {
      return Promise.reject(e);
    }
  },
  devSetDelete: (id) => {
    const s = sets.get(id);
    for (const f of [...mockForwards.values()]) if (f.devSet === id) mockForwards.delete(f.id);
    sets.delete(id);
    if (s) emitMock({ type: "devSets", context: s.context });
    emitMock({ type: "forwards" });
    return delay(undefined);
  },
  devSetUp: (id, hash) => {
    const set = sets.get(id);
    if (!set) return fail("NotFound", `dev set ${id} not found`, 404);
    if (set.hash !== hash) return fail("NeedsApproval", `dev set "${set.name}" changed since it was shown; review it again`);
    const running = [...mockForwards.values()].filter((f) => f.devSet === id);
    if (running.length > 0) return delay(running);
    const started: Forward[] = [];
    for (const f of set.forwards) {
      try {
        started.push(mockStartForward({ context: set.context, target: f.target, remotePort: f.remotePort, localPort: f.localPort, pin: f.pin, label: f.label ?? f.key, devSet: set.id }));
      } catch (e) {
        for (const s of started) mockForwards.delete(s.id);
        emitMock({ type: "forwards" });
        const err = e as { reason: string; message: string };
        return fail(err.reason, `forward ${f.key}: ${err.message}; nothing of set ${set.name} was started`);
      }
    }
    // the human started exactly this content: record the approval
    if (set.approvedHash !== set.hash) {
      const { approvedSnapshot: _s, ...snapshot } = { ...set, approvedHash: set.hash };
      sets.set(id, { ...set, approvedHash: set.hash, approvedSnapshot: snapshot });
      emitMock({ type: "devSets", context: set.context });
    }
    // like Rust: a set that comes up loses its auto-start failure row
    const failed = failures.findIndex((x) => x.devSet === id);
    if (failed >= 0) {
      failures.splice(failed, 1);
      emitMock({ type: "devSets", context: set.context });
    }
    emitMock({ type: "forwards" });
    return delay(started, 200);
  },
  devSetDown: (id) => {
    for (const f of [...mockForwards.values()]) if (f.devSet === id) mockForwards.delete(f.id);
    emitMock({ type: "forwards" });
    return delay(undefined);
  },
  envResolve: (ref, container) => delay(reportFor(ref, container), 120),
  envReveal: (_ref, _container, key) => delay(key === "DATABASE_URL" ? "postgres://app:s3cr3t-value@postgres.payments.svc:5432/app" : "s3cr3t-value"),
  envExport: async (req) => {
    const set = req.devSet ? sets.get(req.devSet) : undefined;
    const spec = req.spec ?? set?.env;
    if (!spec) return fail("Invalid", "an export needs a dev set or an env spec");
    const { keys, secretKeys } = exportCounts(spec);
    if (req.confirmToken) {
      const p = takeConfirm(req.confirmToken, req.confirmText);
      return "path" in p ? exportResult(keys, secretKeys, { path: p.path }) : p.error;
    }
    // like Rust: a human export from a protected context carries the typed workload name
    const prot = req.proposalId ? undefined : protectedConfirm(req.context ?? set?.context ?? "", spec.workload.name, req.confirmText);
    if (prot) return prot;
    if (req.destination === "clipboard") {
      if (req.proposalId) return fail("Invalid", "an agent's export goes to a file chosen in the save dialog");
      return delay(exportResult(keys, secretKeys, { clearSeconds: req.clearSeconds ?? 60, historyExcluded: false }));
    }
    const path = await mockSaveDialog(".env.kns");
    if (path !== null && inMockRepo(path)) {
      const reason = `${path} is inside the git work tree ${MOCK_REPO} and is not git-ignored`;
      if (req.proposalId) return fail("Invalid", `${reason}; an agent's export must go to a git-ignored path`);
      return exportResult(keys, secretKeys, { confirm: askConfirm(path, spec.workload.name, reason) });
    }
    return path === null ? exportResult(0, 0, { cancelled: true }) : exportResult(keys, secretKeys, { path });
  },
};
