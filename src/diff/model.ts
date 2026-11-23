// The diff model: what each side shows, as YAML text. Pure (no backend, no DOM), unit-tested.
// Lazy: imported by the DiffView chunk only (it pulls the YAML library).
import { stringify } from "yaml";
import type { Json, Revision } from "../ipc/types";
import type { ObjectRef } from "../types";
import { isSecretGvr } from "./args";

type Obj = { [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
export const MASK = "••••";

/** Metadata that differs between any two objects and says nothing about their content. */
const NOISE_META = ["managedFields", "uid", "resourceVersion", "generation", "creationTimestamp", "selfLink"];
const NOISE_ANNOTATIONS = [LAST_APPLIED, "deployment.kubernetes.io/revision"];

const clone = (v: Json): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * The object as the diff shows it. Without `full`: managedFields, status and per-object noise
 * (uid, resourceVersion, generation, creationTimestamp, last-applied) dropped. A Secret never
 * shows its last-applied annotation (it holds the values) in either mode.
 */
export function normalize(obj: Json, full: boolean, secret = false): Json {
  const out = clone(obj);
  if (!isObj(out)) return out;
  const meta = out.metadata;
  if (isObj(meta)) {
    if (!full) for (const k of NOISE_META) delete meta[k];
    const ann = meta.annotations;
    if (isObj(ann)) {
      for (const k of full ? (secret ? [LAST_APPLIED] : []) : NOISE_ANNOTATIONS) delete ann[k];
      if (Object.keys(ann).length === 0) delete meta.annotations;
    }
  }
  if (!full) delete out.status;
  return out;
}

/**
 * `live` cut down to the fields `applied` names (map keys recursively, list items by index; extra
 * live items are kept whole). This is what last-applied can disagree on; fields the server or a
 * controller defaulted are left out. Key order follows `applied`, so the two texts line up.
 */
export function project(live: Json, applied: Json): Json {
  if (isObj(live) && isObj(applied)) {
    const out: Obj = {};
    for (const k of Object.keys(applied)) if (k in live) out[k] = project(live[k], applied[k]);
    return out;
  }
  if (Array.isArray(live) && Array.isArray(applied)) return live.map((x, i) => (i < applied.length ? project(x, applied[i]) : x));
  return live;
}

/** The last-applied annotation, parsed; a string error when it is missing or not JSON. */
export function lastApplied(obj: Json): { applied: Json } | { error: string } {
  const raw = isObj(obj) && isObj(obj.metadata) && isObj(obj.metadata.annotations) ? obj.metadata.annotations[LAST_APPLIED] : undefined;
  if (typeof raw !== "string") {
    return { error: "No last-applied configuration: the object was not applied with kubectl apply (Flux and other server-side appliers keep none). Field owners (O in YAML) show who set what." };
  }
  try {
    return { applied: JSON.parse(raw) as Json };
  } catch {
    return { error: "The last-applied annotation is not valid JSON" };
  }
}

/**
 * Secret values never reach the diff: every `data` / `stringData` value becomes the mask, tagged
 * when the other side has a different value for the same key (as REVIEW does).
 */
export function maskSecrets(left: Json, right: Json): [Json, Json] {
  const a = clone(left);
  const b = clone(right);
  for (const field of ["data", "stringData"]) {
    const da = isObj(a) && isObj(a[field]) ? a[field] : null;
    const db = isObj(b) && isObj(b[field]) ? b[field] : null;
    const mask = (mine: Obj | null, other: Obj | null) => {
      if (!mine) return;
      for (const k of Object.keys(mine)) mine[k] = other !== null && k in other && other[k] !== mine[k] ? `${MASK} (differs)` : MASK;
    };
    // compare against the original values, before either side is overwritten
    const ca = da ? { ...da } : null;
    const cb = db ? { ...db } : null;
    mask(da, cb);
    mask(db, ca);
  }
  return [a, b];
}

export const toText = (v: Json): string => (v === null ? "" : stringify(v, { lineWidth: 0 }));

/** Short kind words for labels. */
const SHORT: Record<string, string> = {
  deployments: "deploy", statefulsets: "sts", daemonsets: "ds", replicasets: "rs", pods: "pod", services: "svc",
  configmaps: "cm", secrets: "secret", helmreleases: "hr", kustomizations: "ks", controllerrevisions: "rev",
};
export const refLabel = (ref: ObjectRef): string =>
  `${SHORT[ref.gvr.resource] ?? ref.gvr.resource}/${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;

export function revisionLabel(r: Revision): string {
  const tag = r.image ? ` · ${r.image.split("/").pop()}` : "";
  return `rev ${r.revision}${tag}`;
}

/** What a loaded side holds. */
export type SideData =
  | { by: "object"; ref: ObjectRef; obj: Json }
  | { by: "revision"; owner: ObjectRef; rev: Revision }
  | { by: "applied"; owner: ObjectRef; live: Json };

export interface DiffText {
  before: string;
  after: string;
  leftLabel: string;
  rightLabel: string;
  note: string | null;
}

/** The pair of texts the view shows. Throws a string message when a side cannot be shown. */
export function buildDiff(left: SideData, right: SideData, full: boolean): DiffText {
  const secret = [left, right].some((s) => isSecretGvr(s.by === "object" ? s.ref.gvr : s.owner.gvr));
  let note: string | null = null;

  const value = (s: SideData, other: SideData): Json => {
    switch (s.by) {
      case "object": {
        // the right side of `:diff applied`: only the fields last-applied names (m: everything)
        if (other.by === "applied" && !full) {
          const la = lastApplied(s.obj);
          if ("error" in la) throw la.error;
          note = "Live object cut down to the fields of last-applied; m shows every field.";
          return project(normalize(s.obj, true), normalize(la.applied, true));
        }
        return normalize(s.obj, full, secret);
      }
      case "revision":
        if (s.rev.template === undefined) {
          throw "Helm release data is not read here (it holds the chart values). Compare Helm revisions with `helm diff revision`.";
        }
        return s.rev.template;
      case "applied": {
        if (isSecretGvr(s.owner.gvr)) throw "A Secret's last-applied configuration holds its values; it is not diffed.";
        const la = lastApplied(s.live);
        if ("error" in la) throw la.error;
        return normalize(la.applied, true);
      }
    }
  };
  const label = (s: SideData): string =>
    s.by === "object" ? refLabel(s.ref) : s.by === "revision" ? `${refLabel(s.owner)} ${revisionLabel(s.rev)}` : `${refLabel(s.owner)} last-applied`;

  let a = value(left, right);
  let b = value(right, left);
  if (secret) [a, b] = maskSecrets(a, b);
  return { before: toText(a), after: toText(b), leftLabel: label(left), rightLabel: label(right), note };
}
