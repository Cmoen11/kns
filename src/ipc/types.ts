// IPC CONTRACT between the React frontend and the Rust backend.
// This file is the single source of truth. Rust mirrors it in src-tauri/src/ipc.rs
// (serde, rename_all = "camelCase"; enums tagged with "type").
// Change it only together with ipc.rs, tauri.ts and mock.ts.
//
// Feature contracts (docs/plan-features.md §2.1) live in ./contract/*.ts, one owner per file,
// and are re-exported from here. `Backend` (end of file) is the composition of all of them.
import type {
  AgentsBackend,
  CatalogBackend,
  DbBackend,
  DebugBackend,
  DevBackend,
  DiagBackend,
  DiffBackend,
  EventsBackend,
  FwdBackend,
  GithubBackend,
  HealthBackend,
  LogsBackend,
  PackBackend,
  TrafficBackend,
  UpdateBackend,
} from "./contract";

export * from "./contract";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Group/version/resource. Core group is "". `resource` is the plural, e.g. "pods". */
export interface Gvr {
  group: string;
  version: string;
  resource: string;
}

export interface ObjRef {
  context: string;
  gvr: Gvr;
  /** undefined for cluster-scoped objects */
  namespace?: string;
  name: string;
}

// ───────────────────────── contexts ─────────────────────────

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  /** the AWS profile its credential plugin signs in with: `aws sso login` can renew it */
  awsProfile?: string;
}

/**
 * Whether a context's AWS profile has a usable SSO token, read from the AWS CLI's token cache:
 * - valid: the access token holds until `expiresAt`
 * - refreshable: it expired, but the CLI renews it from its refresh token
 * - expired: `aws sso login` is needed
 * - unknown: no token for the profile in the cache
 */
export type SsoState = "valid" | "refreshable" | "expired" | "unknown";

export interface SsoStatus {
  state: SsoState;
  /** RFC 3339: when the access token expires */
  expiresAt?: string;
}

export interface ContextList {
  contexts: ContextInfo[];
  current?: string;
  /** kubeconfig files that were read */
  files: string[];
}

export interface ClusterInfo {
  context: string;
  cluster: string;
  user: string;
  server: string;
  serverVersion: string;
  /** true when metrics.k8s.io is served */
  hasMetrics: boolean;
}

// ───────────────────────── discovery ─────────────────────────

export interface ApiResource {
  gvr: Gvr;
  kind: string;
  singular: string;
  namespaced: boolean;
  verbs: string[];
  shortNames: string[];
  categories: string[];
  /** e.g. ["scale","status","log","exec"] */
  subresources: string[];
}

// ───────────────────────── table subscriptions ─────────────────────────

export interface TableQuery {
  context: string;
  gvr: Gvr;
  /** undefined or "" = all namespaces (ignored for cluster-scoped) */
  namespace?: string;
  /**
   * Instead of `namespace`: one table over these namespaces (multins.rs), for a user who may
   * not list across all of them (a team's namespaces on a shared cluster).
   */
  namespaces?: string[];
  labelSelector?: string;
  fieldSelector?: string;
}

export interface Column {
  name: string;
  /** "string" | "integer" | "number" | "boolean" | "date" */
  type: string;
  format: string;
  description: string;
  /** 0 = always shown, >0 = wide view */
  priority: number;
}

export interface OwnerRef {
  kind: string;
  name: string;
  uid: string;
  apiVersion: string;
}

/** One table row. `cells[i]` belongs to `columns[i]` of the last snapshot. */
export interface Row {
  uid: string;
  name: string;
  namespace?: string;
  /** RFC3339 */
  created?: string;
  /** RFC3339, set while terminating */
  deleting?: string;
  labels?: Record<string, string>;
  owners?: OwnerRef[];
  cells: Json[];
}

export type WatchState = "syncing" | "live" | "reconnecting" | "forbidden" | "error";

export type TableEvent =
  | { type: "snapshot"; columns: Column[]; rows: Row[] }
  | { type: "delta"; upserts: Row[]; deletes: string[] }
  | { type: "state"; state: WatchState; message?: string };

// ───────────────────────── objects & mutations ─────────────────────────

export type Propagation = "Background" | "Foreground" | "Orphan";

export interface DeleteOptions {
  propagation?: Propagation;
  /** 0 = force */
  gracePeriodSeconds?: number;
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** force conflicts (server-side apply) */
  force?: boolean;
}

/** The client socket and loopback endpoint (rpc/mod.rs, rpc/tcp.rs). */
export interface SocketStatus {
  path?: string;
  listening: boolean;
  clients: number;
  error?: string;
}

export interface TcpStatus {
  enabled: boolean;
  listening: boolean;
  port?: number;
  infoFile?: string;
  error?: string;
}

/** kns in the background (background.rs). */
export interface BackgroundStatus {
  keepRunning: boolean;
  startedInBackground: boolean;
  launchAtLogin: boolean;
  windowOpen: boolean;
  socket: SocketStatus;
}

/** What of kns is set up in Herdr (herdr.rs). */
export interface HerdrStatus {
  appFound: boolean;
  modDir?: string;
  modInstalled: boolean;
  /** the installed mod is the one this kns carries */
  modCurrent: boolean;
  tuiFound: boolean;
  tuiPluginWritten: boolean;
  knsTui?: string;
  tcp: TcpStatus;
}

export interface HerdrInstallReport {
  done: string[];
  /** what could not be done or needs the person: a non-empty list is a warning */
  notes: string[];
  /** where to find things next */
  tips: string[];
  status: HerdrStatus;
}

export interface ApplyResult {
  /** resulting object as YAML (managedFields stripped) */
  yaml: string;
  warnings: string[];
}

export type PatchType = "merge" | "json";

export interface EventRow {
  type: string; // Normal | Warning
  reason: string;
  message: string;
  count: number;
  /** RFC3339 */
  lastSeen?: string;
  source: string;
  objectKind: string;
  objectName: string;
  namespace?: string;
}

export interface PodRef {
  namespace: string;
  name: string;
  containers: string[];
  initContainers: string[];
  ephemeralContainers: string[];
  phase: string;
  node?: string;
}

// ───────────────────────── metrics ─────────────────────────

export interface PodMetric {
  namespace: string;
  name: string;
  cpuMilli: number;
  memBytes: number;
}

export interface NodeMetric {
  name: string;
  cpuMilli: number;
  memBytes: number;
  cpuAllocMilli: number;
  memAllocBytes: number;
}

// logs: LogQuery, LogLine, LogEvent live in ./contract/logs.ts (re-exported below).

// ───────────────────────── exec ─────────────────────────

export interface ExecQuery {
  context: string;
  namespace: string;
  pod: string;
  container?: string;
  /** empty = auto-detect bash/sh */
  command: string[];
  tty: boolean;
  /** attach to the running process instead of exec */
  attach?: boolean;
  cols: number;
  rows: number;
}

export type ExecEvent =
  /** base64 encoded bytes */
  | { type: "data"; b64: string }
  | { type: "exit"; code?: number; message?: string }
  | { type: "error"; message: string };

// port-forward: ForwardQuery, Forward and the forward methods live in ./contract/fwd.ts (FwdBackend).

// ───────────────────────── rbac ─────────────────────────

export interface AccessQuery {
  context: string;
  verb: string;
  gvr: Gvr;
  subresource?: string;
  namespace?: string;
  name?: string;
}

/** Error shape thrown by every Backend method. */
export interface BackendError {
  /** HTTP status when the API server answered, else 0 */
  code: number;
  /** e.g. "Forbidden", "NotFound", "Conflict", "Network", "Config" */
  reason: string;
  message: string;
}

/** A running stream; call to stop it. */
export type Unsubscribe = () => void;

export interface ExecSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * The base cluster layer, before the feature contracts.
 * Implementations: tauri.ts (real), mock.ts (browser dev / tests).
 * All methods reject with BackendError.
 */
export interface BaseBackend {
  // contexts
  listContexts(): Promise<ContextList>;
  /** Builds (or reuses) the session for a context and checks connectivity. */
  connect(context: string): Promise<ClusterInfo>;
  /** Runs `aws sso login` for the context's AWS profile (the CLI opens the browser) and resolves when it is done. */
  awsSsoLogin(context: string): Promise<void>;
  /** The sign-in status of each of `contexts` that signs in with an AWS profile (no process, no network). */
  awsSsoStatus(contexts: string[]): Promise<Record<string, SsoStatus>>;
  discover(context: string): Promise<ApiResource[]>;

  // tables
  subscribeTable(query: TableQuery, onEvent: (e: TableEvent) => void): Unsubscribe;

  // objects
  getYaml(ref: ObjRef, opts?: { managedFields?: boolean }): Promise<string>;
  getJson(ref: ObjRef): Promise<Json>;
  /** getJson with a Secret's data/stringData values masked in Rust as `••• <digest>` (salted per call site, so two sides of one diff compare) and its last-applied annotation dropped */
  getJsonMasked(ref: ObjRef, salt: string): Promise<Json>;
  /** Events for one object (by involvedObject) or, with only context/namespace, all events. */
  listEvents(q: { context: string; namespace?: string; ref?: ObjRef }): Promise<EventRow[]>;
  /** Pods behind a workload/service/job/node (or the pod itself). */
  podsFor(ref: ObjRef): Promise<PodRef[]>;

  // mutations. `proposalId`: set only when the human executes an agent proposal; Rust then
  // gates the call on that proposal (docs/plan-features.md §2.6). Reconcile goes through patchObject.
  applyYaml(context: string, yaml: string, opts?: ApplyOptions, proposalId?: string): Promise<ApplyResult>;
  deleteObject(ref: ObjRef, opts?: DeleteOptions, proposalId?: string): Promise<void>;
  patchObject(ref: ObjRef, patch: Json, patchType?: PatchType, subresource?: string, proposalId?: string): Promise<void>;
  scale(ref: ObjRef, replicas: number, proposalId?: string): Promise<void>;
  restart(ref: ObjRef, proposalId?: string): Promise<void>;
  triggerCronJob(ref: ObjRef): Promise<string>;
  /** Decoded secret data: key -> utf8 string, or null when binary. */
  decodeSecret(ref: ObjRef): Promise<Record<string, string | null>>;

  // metrics
  podMetrics(context: string, namespace?: string): Promise<PodMetric[]>;
  nodeMetrics(context: string): Promise<NodeMetric[]>;

  // streams (streamLogs: LogsBackend)
  exec(query: ExecQuery, onEvent: (e: ExecEvent) => void): Promise<ExecSession>;

  // rbac
  canI(query: AccessQuery): Promise<boolean>;

  // persisted UI state (JSON files in the app config dir)
  loadState(key: string): Promise<Json>;
  saveState(key: string, value: Json): Promise<void>;

  // kns in the background and in Herdr (background.rs, herdr.rs; docs/herdr.md)
  backgroundStatus(): Promise<BackgroundStatus>;
  /** Keep running in the tray when the window closes; `launchAtLogin` (macOS) when given. */
  backgroundSet(keepRunning: boolean, launchAtLogin?: boolean): Promise<BackgroundStatus>;
  herdrStatus(): Promise<HerdrStatus>;
  /** "Add to Herdr": the Herdr app's panel (mod + loopback endpoint) and/or the herdr TUI plugin. */
  herdrInstall(): Promise<HerdrInstallReport>;
  herdrUninstall(): Promise<HerdrInstallReport>;
}

/**
 * Everything the UI can ask of the backend: the base plus every feature contract.
 * Implementations: tauri.ts (real; spreads ./tauri/<pkg>.ts), mock.ts (browser dev / tests;
 * spreads ./mock/<pkg>.ts). All methods reject with BackendError.
 */
export type Backend = BaseBackend &
  FwdBackend &
  DevBackend &
  DiagBackend &
  DiffBackend &
  LogsBackend &
  DebugBackend &
  PackBackend &
  AgentsBackend &
  EventsBackend &
  HealthBackend &
  UpdateBackend &
  CatalogBackend &
  GithubBackend &
  TrafficBackend &
  DbBackend;
