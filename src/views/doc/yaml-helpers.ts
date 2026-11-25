// YAML/JSON helpers for the doc view: error-to-line mapping, conflict classification, Flux owner
// detection and the secret document. Pure; no CodeMirror, no backend.
import { LineCounter, isMap, isScalar, isSeq, parseDocument, stringify, type Node } from "yaml";
import type { BackendError, Json } from "../../ipc/types";
import { argoOwner, argoOwnerText } from "../../actions/ops/argo";

export type JsonObject = { [k: string]: Json };
export const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export function isBackendError(e: unknown): e is BackendError {
  return typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string";
}
export const errorText = (e: unknown): string => (isBackendError(e) ? e.message : e instanceof Error ? e.message : String(e));

/** A copy without metadata.managedFields. */
export function stripManagedFields(obj: Json): Json {
  if (!isObj(obj) || !isObj(obj.metadata) || !("managedFields" in obj.metadata)) return obj;
  const { managedFields: _drop, ...metadata } = obj.metadata;
  return { ...obj, metadata };
}

export const toJsonText = (obj: Json, managedFields: boolean): string =>
  JSON.stringify(managedFields ? obj : stripManagedFields(obj), null, 2) + "\n";

// ── errors -> lines ────────────────────────────────────────────────────────

export interface LineError {
  /** 1-based */
  line: number;
  message: string;
}

/** The first YAML syntax error, or null when the text parses. */
export function yamlSyntaxError(text: string): LineError | null {
  const doc = parseDocument(text, { prettyErrors: true });
  const e = doc.errors[0];
  if (!e) return null;
  return { line: e.linePos?.[0].line ?? 1, message: e.message.split("\n")[0] };
}

/** Field paths named in an API error message, e.g. `spec.template.spec.containers[0].image`. */
export function fieldPaths(message: string): (string | number)[][] {
  const out: (string | number)[][] = [];
  const re = /\.?([A-Za-z_][\w-]*(?:\[\d+\]|\.[A-Za-z_][\w/-]*)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message))) {
    const path: (string | number)[] = [];
    for (const part of m[1].split(".")) {
      const seg = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
      if (!seg) continue;
      if (seg[1]) path.push(seg[1]);
      for (const idx of seg[2].matchAll(/\[(\d+)\]/g)) path.push(Number(idx[1]));
    }
    if (path.length > 0) out.push(path);
  }
  return out;
}

/**
 * 1-based lines of `text` that an API error message points at: explicit "line N" mentions and the
 * deepest existing node of every field path. Paths whose first segment is not a top-level key
 * (e.g. `Deployment.apps`) are ignored. Empty when nothing can be mapped.
 */
export function errorLines(text: string, message: string): number[] {
  const lines = new Set<number>();
  const total = text.split("\n").length;
  for (const m of message.matchAll(/\bline (\d+)\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= total) lines.add(n);
  }
  const paths = fieldPaths(message);
  if (paths.length > 0) {
    const counter = new LineCounter();
    const doc = parseDocument(text, { lineCounter: counter });
    for (const path of paths) {
      let node: Node | null | undefined = doc.contents;
      let at = -1;
      for (const seg of path) {
        if (typeof seg === "string" && isMap(node)) {
          const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
          if (!pair) break;
          at = (pair.key as Node).range?.[0] ?? at;
          node = pair.value as Node | null;
        } else if (typeof seg === "number" && isSeq(node)) {
          const item = node.items[seg] as Node | undefined;
          if (!item) break;
          at = item.range?.[0] ?? at;
          node = item;
        } else break;
      }
      if (at >= 0) lines.add(counter.linePos(at).line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

// ── conflicts ──────────────────────────────────────────────────────────────

/**
 * What kind of 409 an apply ran into: another field manager owns a field we set (resolved by
 * forcing the apply after a confirm), or the object changed since it was fetched (resolved by a
 * rebase). Assumes the Rust side forwards the API server's status message unchanged.
 */
export function classifyConflict(e: unknown): "fieldManager" | "version" | null {
  if (!isBackendError(e)) return null;
  const be = e as Partial<BackendError>;
  if (be.code !== 409 && be.reason !== "Conflict") return null;
  if (/conflicts? with "|Apply failed with \d+ conflict/i.test(be.message ?? "")) return "fieldManager";
  return "version";
}

// ── flux ───────────────────────────────────────────────────────────────────

export interface FluxOwner {
  resource: "kustomizations" | "helmreleases";
  name: string;
  namespace: string;
}

/** The Flux object that reconciles this manifest, from the labels Flux stamps on what it applies. */
export function fluxOwner(text: string): FluxOwner | null {
  let labels: unknown;
  try {
    labels = (parseDocument(text).toJS() as { metadata?: { labels?: unknown } } | null)?.metadata?.labels;
  } catch {
    return null;
  }
  if (typeof labels !== "object" || labels === null) return null;
  const l = labels as Record<string, unknown>;
  for (const [prefix, resource] of [["kustomize.toolkit.fluxcd.io", "kustomizations"], ["helm.toolkit.fluxcd.io", "helmreleases"]] as const) {
    const name = l[`${prefix}/name`];
    const namespace = l[`${prefix}/namespace`];
    if (typeof name === "string" && typeof namespace === "string") return { resource, name, namespace };
  }
  return null;
}

/**
 * The Argo CD Application that applied this manifest (`Application ns/app`), from its tracking
 * annotation or instance label; null when there is none or the text does not parse.
 */
export function argoOwnerOfText(text: string): string | null {
  try {
    const owner = argoOwner(parseDocument(text).toJS());
    return owner ? argoOwnerText(owner) : null;
  } catch {
    return null;
  }
}

// ── secrets ────────────────────────────────────────────────────────────────

export const MASK = "••••";
export type Decoded = Record<string, string | null>;

export interface SecretDoc {
  text: string;
  /** keyOfLine[i] = the key shown on line i+1, or null */
  keyOfLine: (string | null)[];
}

/**
 * The secret document: one `key: value` entry per key in YAML. Values are masked unless revealed;
 * binary values are never shown. With `edit` every UTF-8 value is plain and binary keys are
 * comments, so the editable document holds exactly the keys the user may change.
 */
export function secretDoc(decoded: Decoded, revealed: ReadonlySet<string> | "all", opts: { edit?: boolean } = {}): SecretDoc {
  const lines: string[] = [];
  const keyOfLine: (string | null)[] = [];
  const push = (chunk: string, key: string | null) => {
    for (const l of chunk.replace(/\n$/, "").split("\n")) {
      lines.push(l);
      keyOfLine.push(key);
    }
  };
  const keys = Object.keys(decoded).sort();
  if (keys.length === 0) push("# no data", null);
  for (const key of keys) {
    const v = decoded[key];
    if (v === null) push(opts.edit ? `# ${key}: binary, locked` : stringify({ [key]: "binary, locked" }), key);
    else if (opts.edit || revealed === "all" || revealed.has(key)) push(stringify({ [key]: v }, { lineWidth: 0 }), key);
    else push(stringify({ [key]: MASK }), key);
  }
  return { text: lines.join("\n") + "\n", keyOfLine };
}

/** Parses the edited secret document back to key -> string. Throws a LineError-shaped Error on bad input. */
export function parseSecretEdit(text: string): Record<string, string> {
  const syntax = yamlSyntaxError(text);
  if (syntax) throw Object.assign(new Error(syntax.message), { line: syntax.line });
  // failsafe schema: every scalar stays the string that was typed (0123, 1.0, null, long digits)
  const js = parseDocument(text, { schema: "failsafe" }).toJS() as unknown;
  if (js === null || js === undefined || js === "") return {};
  if (typeof js !== "object" || Array.isArray(js)) throw Object.assign(new Error("a secret is a map of key: value"), { line: 1 });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(js as Record<string, unknown>)) {
    if (typeof v === "object" && v !== null) {
      const at = text.split("\n").findIndex((l) => l.startsWith(`${k}:`));
      throw Object.assign(new Error(`${k}: a secret value must be a string`), { line: at < 0 ? 1 : at + 1 });
    }
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The manifest that applies an edited secret: edited values re-encoded into `data`, binary keys
 * kept as their original base64, everything else of the object identity preserved.
 */
export function secretManifest(obj: Json, values: Record<string, string>, decoded: Decoded): string {
  const o = isObj(obj) ? obj : {};
  const meta = isObj(o.metadata) ? o.metadata : {};
  const old = isObj(o.data) ? o.data : {};
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(decoded)) if (v === null && typeof old[k] === "string") data[k] = old[k] as string;
  for (const [k, v] of Object.entries(values)) data[k] = toBase64(v);
  const metadata: JsonObject = { name: meta.name ?? "" };
  if (typeof meta.namespace === "string") metadata.namespace = meta.namespace;
  if (isObj(meta.labels)) metadata.labels = meta.labels;
  if (isObj(meta.annotations)) metadata.annotations = meta.annotations;
  const out: JsonObject = { apiVersion: o.apiVersion ?? "v1", kind: o.kind ?? "Secret", metadata };
  if (typeof o.type === "string") out.type = o.type;
  out.data = data;
  return stringify(out, { lineWidth: 0 });
}

/**
 * Both sides of a secret diff with the values hidden: unchanged values show the mask, changed ones
 * `•••• (changed)`, so the diff shows which keys change without showing what to.
 */
export function maskSecretPair(before: Record<string, string>, after: Record<string, string>): { before: string; after: string } {
  const side = (mine: Record<string, string>, other: Record<string, string>, tag: string) =>
    Object.keys(mine).sort().map((k) => `${k}: ${MASK}${k in other && other[k] !== mine[k] ? ` (${tag})` : ""}`).join("\n") + "\n";
  return { before: side(before, after, "current"), after: side(after, before, "changed") };
}
