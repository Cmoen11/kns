// Flux facts read from plain objects (docs/research.md §5.9). Pure: no imports from the app.
// Kinds are named here only as `kind` strings; the GVR always comes from discovery (resolve.ts).

export const RECONCILE_ANNOTATION = "reconcile.fluxcd.io/requestedAt";

const OWNER_LABELS = [
  { prefix: "kustomize.toolkit.fluxcd.io", kind: "Kustomization" },
  { prefix: "helm.toolkit.fluxcd.io", kind: "HelmRelease" },
] as const;

/** A reference to a Flux object by kind; `group` narrows the discovery lookup. */
export interface FluxRef {
  kind: string;
  /** API group, e.g. "kustomize.toolkit.fluxcd.io"; undefined = any Flux group */
  group?: string;
  name: string;
  namespace?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export const labelsOf = (o: unknown): Record<string, unknown> => obj(obj(obj(o)?.metadata)?.labels) ?? {};

/**
 * The Kustomization or HelmRelease that manages an object, from its labels. A change to such an
 * object is reverted on the next reconcile. The owner's namespace comes from the companion
 * `/namespace` label; without it the owner cannot be addressed and `namespace` stays undefined.
 */
export function fluxOwner(labels: Record<string, unknown> | undefined): FluxRef | null {
  if (!labels) return null;
  for (const { prefix, kind } of OWNER_LABELS) {
    const name = str(labels[`${prefix}/name`]);
    if (name) return { kind, group: prefix, name, namespace: str(labels[`${prefix}/namespace`]) };
  }
  return null;
}

export const fluxOwnerText = (o: FluxRef): string => `${o.kind} ${o.namespace ? `${o.namespace}/` : ""}${o.name}`;

/** `spec.suspend` of a Flux object or CronJob. */
export const isSuspended = (o: unknown): boolean => obj(obj(o)?.spec)?.suspend === true;

/** `spec.unschedulable` of a Node. */
export const isCordoned = (o: unknown): boolean => obj(obj(o)?.spec)?.unschedulable === true;

/** `spec.replicas`, or null when the object has none. */
export function replicasOf(o: unknown): number | null {
  const r = obj(obj(o)?.spec)?.replicas;
  return typeof r === "number" && Number.isInteger(r) && r >= 0 ? r : null;
}

const groupOf = (apiVersion: unknown): string | undefined => {
  const v = str(apiVersion);
  return v && v.includes("/") ? v.slice(0, v.indexOf("/")) : undefined;
};

/**
 * The source a Flux object reconciles from: `spec.sourceRef` (Kustomization and others),
 * `spec.chartRef` or `spec.chart.spec.sourceRef` (HelmRelease). The namespace defaults to the
 * object's own. Null for sources themselves.
 */
export function sourceRefOf(o: unknown): FluxRef | null {
  const root = obj(o);
  const spec = obj(root?.spec);
  if (!spec) return null;
  const own = str(obj(root?.metadata)?.namespace);
  const ref = obj(spec.sourceRef) ?? obj(spec.chartRef) ?? obj(obj(obj(spec.chart)?.spec)?.sourceRef);
  const kind = str(ref?.kind);
  const name = str(ref?.name);
  if (!ref || !kind || !name) return null;
  return { kind, group: groupOf(ref.apiVersion), name, namespace: str(ref.namespace) ?? own };
}

/** Merge patch that asks a Flux controller to reconcile now. */
export const reconcilePatch = (now: Date): { metadata: { annotations: Record<string, string> } } => ({
  metadata: { annotations: { [RECONCILE_ANNOTATION]: now.toISOString() } },
});

export const suspendPatch = (suspend: boolean): { spec: { suspend: boolean } } => ({ spec: { suspend } });

/** null removes the field, which is what `kubectl uncordon` leaves behind. */
export const cordonPatch = (on: boolean): { spec: { unschedulable: boolean | null } } => ({ spec: { unschedulable: on ? true : null } });

/** The controlling owner of an object (`controller: true` first), from `metadata.ownerReferences`. */
export function ownerOf(o: unknown): { kind: string; group: string; name: string; uid?: string } | null {
  const refs = obj(obj(o)?.metadata)?.ownerReferences;
  if (!Array.isArray(refs)) return null;
  const list = refs.map(obj).filter((r): r is Obj => !!r && !!str(r.kind) && !!str(r.name));
  const pick = list.find((r) => r.controller === true) ?? list[0];
  if (!pick) return null;
  return { kind: pick.kind as string, group: groupOf(pick.apiVersion) ?? "", name: pick.name as string, uid: str(pick.uid) };
}
