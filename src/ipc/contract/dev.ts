// Dev sets and env (docs/plan-features.md §2.5, §3 B-dev). Written by A1; owner B-dev.
// Rust mirror: src-tauri/src/contract/dev.rs. Drift fixtures: __fixtures__/dev.ts.
import type { Forward, Gvr, ObjRef } from "../types";
import type { ForwardTarget, PortRef, ServiceKind } from "./fwd";
import type { RedactionReport } from "./pack";

export interface DevForward {
  /** slug, unique in the set: [a-z0-9-]{1,40} */
  key: string;
  target: ForwardTarget;
  remotePort: PortRef;
  localPort: number;
  pin: boolean;
  /** [A-Za-z0-9 ._-]{1,40} */
  label?: string;
}

/** Structured: matches every spelling of the Service address inside Rust (addr.rs). No free text. */
export interface Rewrite {
  match: { service: string; namespace: string; port: number };
  /** limit to one env key; absent = every value of the set's env */
  envKey?: string;
  /** the forward in the same set it points at */
  to: { forward: string };
}

/** literal, non-secret; e.g. consumer group "-local" */
export interface EnvOverride {
  key: string;
  value: string;
}

export type EnvFormat = "dotenv" | "powershell" | "posix";

export interface EnvSpec {
  workload: { gvr: Gvr; namespace: string; name: string };
  container?: string;
  include?: string[];
  exclude?: string[];
  /** secret-sourced keys the human ticked; agents cannot set this field */
  includeSecrets?: string[];
  overrides?: EnvOverride[];
  format: EnvFormat;
}

export type DevSetOrigin = { by: "user" } | { by: "agent"; client: string; at: string };

export interface ConnSecret {
  forward: string;
  secret: SecretKeyRef;
}

export interface DevSet {
  id: string;
  name: string;
  context: string;
  forwards: DevForward[];
  rewrites: Rewrite[];
  env?: EnvSpec;
  /** human-only; forced false on agent saves */
  autoStart: boolean;
  /** human-only (B2 pf.copyUrl); stripped on agent saves */
  connSecrets?: ConnSecret[];
  origin: DevSetOrigin;
  /** sha256 of canonical JSON of the whole set except name, updatedAt, origin, approvedHash, hash, approvedSnapshot */
  hash: string;
  /** set when a human approved this exact content */
  approvedHash?: string;
  /** the content last approved, for the "changed since approval" diff */
  approvedSnapshot?: Omit<DevSet, "approvedSnapshot">;
  updatedAt: string;
}

/** What the UI sends to devSetSave: Rust sets id (when new), origin, hash, approval and updatedAt. */
export interface DevSetDraft {
  id?: string;
  name: string;
  context: string;
  forwards: DevForward[];
  rewrites: Rewrite[];
  env?: EnvSpec;
  autoStart: boolean;
  connSecrets?: ConnSecret[];
}

export interface DevSetSaved {
  set: DevSet;
  warnings: string[];
}

export interface Hit {
  service: string;
  namespace: string;
  port: number;
  /** [start, end) in the value; absent for secret-sourced values (never echoed) */
  span?: [number, number];
}

export type EnvSource = "literal" | "configMap" | "secret" | "field" | "resourceField";

export interface EnvRow {
  key: string;
  source: EnvSource;
  /** e.g. "configmap/envdemo", "secret/envdemo:PASSWORD" */
  from?: string;
  /** literal/configMap only, redacted */
  value?: string;
  masked: boolean;
  hits: Hit[];
}

export interface Dependency {
  service: ObjRef;
  port: number;
  kind: ServiceKind;
  ready: boolean;
  suggestedForward: DevForward;
  suggestedRewrite: Rewrite;
  /** cleaned untrusted text */
  notes: string[];
}

export interface EnvReport {
  /** the container the rows are of */
  container: string;
  /** every container of the pod template */
  containers: string[];
  rows: EnvRow[];
  deps: Dependency[];
  warnings: string[];
  /** suggested literal overrides for side effects (consumer groups, migrations) */
  overrides: EnvOverride[];
  redactions: RedactionReport;
}

export interface EnvExportRequest {
  devSet?: string;
  spec?: EnvSpec;
  rewrites: Rewrite[];
  destination: "file" | "clipboard";
  /** the context of `spec` when there is no dev set */
  context?: string;
  /** the forwards the rewrites point at when there is no saved set (the env view before `s`) */
  forwards?: DevForward[];
  /** clipboard: clear after this many seconds (setting clipboardClearSeconds) */
  clearSeconds?: number;
  /** a human confirmed writing to the path Rust asked about (EnvExportResult.confirm); never with a proposal */
  confirmToken?: string;
  /** the text the human typed: with confirmToken the answer to ExportConfirm.typeToConfirm; on the first
   *  request of a protected context the workload name from the export dialog. Rust compares both */
  confirmText?: string;
  proposalId?: string;
}

/** Rust holds the chosen path and the text; the human must confirm (tier 2) to write it. */
export interface ExportConfirm {
  token: string;
  path: string;
  reason: string;
  /** what the human types (the workload name); sent back as confirmText, checked in Rust */
  typeToConfirm: string;
}

export interface EnvExportResult {
  keys: number;
  secretKeys: number;
  /** file destination */
  path?: string;
  /** the human closed the save dialog */
  cancelled?: boolean;
  /** clipboard: when it clears, and whether the history / cloud exclusion was set */
  clearSeconds?: number;
  historyExcluded?: boolean;
  /** the path is not git-ignored inside a work tree: nothing was written yet */
  confirm?: ExportConfirm;
  /** e.g. the path is in a cloud-synced folder */
  warnings?: string[];
}

// ── B2: connection strings, mounted volumes ──

export interface SecretKeyRef {
  namespace: string;
  name: string;
  key: string;
}

/** A Secret's key names (never values) and type, for the connection-string picker. */
export interface SecretKeys {
  name: string;
  type: string;
  keys: string[];
}

/** Where a remembered pick lives: the dev set's `connSecrets`, or this forward until it stops. */
export type ConnMemory = "set" | "forward";

export interface ConnInfo {
  forward: string;
  kind: ServiceKind;
  /** without credentials: `postgres://localhost:15432/` */
  plain: string;
  remembered?: SecretKeyRef;
  memory?: ConnMemory;
  /** the forward belongs to this dev set; a pick is stored in it only while it is approved */
  devSet?: string;
  devSetApproved?: boolean;
}

export interface ConnCopyRequest {
  forward: string;
  /** no credentials, even when a pick is remembered */
  plain?: boolean;
  /** the Secret key picked now; absent = the remembered one (or none) */
  secret?: SecretKeyRef;
  /** keep `secret`: in the dev set when the forward is in an approved set, else for this forward */
  remember?: boolean;
  clearSeconds?: number;
}

export interface ConnCopyResult {
  /** what was copied, the secret part masked */
  preview: string;
  /** Rust wrote the clipboard (with a secret); false: `text` is plain and the UI copies it */
  copied: boolean;
  /** only without a secret */
  text?: string;
  secret?: SecretKeyRef;
  clearSeconds?: number;
  historyExcluded?: boolean;
  remembered?: ConnMemory;
}

export type VolumeSource = "configMap" | "secret";

/** A ConfigMap or Secret a container mounts (a projected volume lists one per source). */
export interface VolumeInfo {
  /** the volume name; `<volume>/<object>` for a projected source */
  id: string;
  source: VolumeSource;
  object: string;
  mountPath?: string;
  /** paths relative to the volume (`items` applied); empty when unreadable */
  files: string[];
  readable: boolean;
  message?: string;
}

export interface VolumeReport {
  container: string;
  containers: string[];
  volumes: VolumeInfo[];
}

/** Humans only (no proposalId): files go to `<folder>/<volume id>/<path>`. */
export interface VolumesExportRequest {
  ref: ObjRef;
  container?: string;
  volumes: string[];
  confirmToken?: string;
  /** the text the human typed: with confirmToken the answer to ExportConfirm.typeToConfirm; on the first
   *  request of a protected context the workload name from the export dialog. Rust compares both */
  confirmText?: string;
}

/** A dev set that failed to come up by itself (autoStart); kept in Rust until it comes up or is cleared. */
export interface DevSetFailure {
  devSet: string;
  name: string;
  context: string;
  message: string;
  at: string;
}

export interface VolumesExportResult {
  files: number;
  secretFiles: number;
  path?: string;
  cancelled?: boolean;
  /** not git-ignored inside a work tree, or files would be replaced: nothing written yet */
  confirm?: ExportConfirm;
  warnings?: string[];
}

export interface DevBackend {
  devSetsList(context?: string): Promise<DevSet[]>;
  /** `proposalId`: step "update" of an approved devSetUpdate proposal (Rust gates it) */
  devSetSave(set: DevSetDraft, proposalId?: string): Promise<DevSetSaved>;
  /** `proposalId`: step "delete" of an approved devSetDelete proposal (Rust gates it) */
  devSetDelete(id: string, proposalId?: string): Promise<void>;
  /** `hash` = the hash of the snapshot the UI displayed; refused (NeedsApproval) when it differs */
  devSetUp(id: string, hash: string, proposalId?: string): Promise<Forward[]>;
  devSetDown(id: string): Promise<void>;
  /** autoStart failures still to show; `clear` drops those set ids first */
  devSetFailures(clear?: string[]): Promise<DevSetFailure[]>;
  envResolve(ref: ObjRef, container?: string): Promise<EnvReport>;
  /** one value, on an explicit human action */
  envReveal(ref: ObjRef, container: string, key: string): Promise<string>;
  envExport(req: EnvExportRequest): Promise<EnvExportResult>;
  /** B2: Secrets of a namespace with their key names (no values) */
  connSecretsList(context: string, namespace: string): Promise<SecretKeys[]>;
  /** B2 `pf.copyUrl`: what `C` knows about a forward */
  forwardConnInfo(forward: string): Promise<ConnInfo>;
  /** B2 `pf.copyUrl`: Rust builds the string; with a secret it writes the clipboard itself */
  forwardConnCopy(req: ConnCopyRequest): Promise<ConnCopyResult>;
  /** B2: the ConfigMap / Secret volumes a workload's container mounts */
  volumesList(ref: ObjRef, container?: string): Promise<VolumeReport>;
  /** B2: humans only; a folder chosen in a dialog Rust opens */
  volumesExport(req: VolumesExportRequest): Promise<VolumesExportResult>;
}
