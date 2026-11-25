// Argo CD facts read from plain objects. Pure: no imports from the app. Mirror of
// src-tauri/src/argo.rs (the tracking-id grammar and the owner rule must agree).
//
// Two levels: what Argo CD stamps on the objects it applies (readable by anyone who can read the
// object, also when the Application lives in a management cluster), and the Application and
// ApplicationSet kinds themselves when they are served.

export const ARGO_GROUP = "argoproj.io";
export const TRACKING_ANNOTATION = "argocd.argoproj.io/tracking-id";
export const INSTANCE_KEY = "argocd.argoproj.io/instance";
const LEGACY_INSTANCE_LABEL = "app.kubernetes.io/instance";
/** Asks the application controller to compare the app with Git again (`normal` or `hard`). */
export const REFRESH_ANNOTATION = "argocd.argoproj.io/refresh";
/** Asks the ApplicationSet controller to regenerate its Applications. */
export const APPSET_REFRESH_ANNOTATION = "argocd.argoproj.io/application-set-refresh";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const isArgoGroup = (group: string): boolean => group === ARGO_GROUP;

/** One parsed `argocd.argoproj.io/tracking-id`. */
export interface Tracking {
  app: string;
  /** the Application's namespace, when the id names it (`ns_app`, apps in any namespace) */
  appNamespace?: string;
  group: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** `app` or `ns_app`: an object name never holds `_`, so the split is unambiguous. */
function splitApp(text: string): { app: string; namespace?: string } | null {
  if (!text) return null;
  const i = text.indexOf("_");
  if (i < 0) return { app: text };
  const ns = text.slice(0, i);
  const app = text.slice(i + 1);
  return ns && app ? { app, namespace: ns } : null;
}

/** `<app>:<group>/<kind>:<namespace>/<name>`; the group and the namespace may be empty. */
export function parseTrackingId(id: string): Tracking | null {
  const t = id.trim();
  const a = t.indexOf(":");
  const b = a < 0 ? -1 : t.indexOf(":", a + 1);
  if (a < 0 || b < 0) return null;
  const app = splitApp(t.slice(0, a));
  const gk = t.slice(a + 1, b);
  const nn = t.slice(b + 1);
  const slash1 = gk.indexOf("/");
  const slash2 = nn.indexOf("/");
  if (!app || slash1 < 0 || slash2 < 0) return null;
  const kind = gk.slice(slash1 + 1);
  const name = nn.slice(slash2 + 1);
  if (!kind || !name) return null;
  const namespace = nn.slice(0, slash2);
  return {
    app: app.app, ...(app.namespace ? { appNamespace: app.namespace } : {}),
    group: gk.slice(0, slash1), kind, ...(namespace ? { namespace } : {}), name,
  };
}

/** A field manager of Argo CD (`argocd-controller`, `argocd-application-controller`). */
export const isArgoManager = (manager: string): boolean => {
  const m = manager.toLowerCase();
  return m === "argocd" || m.startsWith("argocd-");
};

/** The Application that manages an object, as far as the object says. */
export interface ArgoRef {
  app: string;
  /** undefined: the object does not say (the Application is in Argo CD's own namespace) */
  namespace?: string;
}

/**
 * The Argo CD Application that applied an object: its tracking annotation, the
 * `argocd.argoproj.io/instance` label or annotation, or Argo's legacy `app.kubernetes.io/instance`
 * label when a field manager of Argo CD wrote the object (Helm sets that label too, so the label
 * alone says nothing).
 */
export function argoOwner(o: unknown): ArgoRef | null {
  const meta = obj(obj(o)?.metadata);
  if (!meta) return null;
  const annotations = obj(meta.annotations) ?? {};
  const labels = obj(meta.labels) ?? {};
  const t = parseTrackingId(str(annotations[TRACKING_ANNOTATION]));
  if (t) return t.appNamespace ? { app: t.app, namespace: t.appNamespace } : { app: t.app };
  const instance = (v: unknown): ArgoRef | null => {
    const a = splitApp(str(v).trim());
    return a ? (a.namespace ? { app: a.app, namespace: a.namespace } : { app: a.app }) : null;
  };
  const direct = instance(annotations[INSTANCE_KEY]) ?? instance(labels[INSTANCE_KEY]);
  if (direct) return direct;
  const managers = Array.isArray(meta.managedFields) ? meta.managedFields : [];
  if (managers.some((m) => isArgoManager(str(obj(m)?.manager)))) return instance(labels[LEGACY_INSTANCE_LABEL]);
  return null;
}

export const argoOwnerText = (o: ArgoRef): string => `Application ${o.namespace ? `${o.namespace}/` : ""}${o.app}`;

/** `spec.syncPolicy.automated` with self-heal: a manual change is put back right away. */
export function selfHeals(app: unknown): boolean {
  const automated = obj(obj(obj(obj(app)?.spec)?.syncPolicy)?.automated);
  return automated?.selfHeal === true;
}

/** Merge patch for a refresh: the controller compares with Git again (`hard` also drops its manifest cache). */
export const refreshPatch = (hard: boolean): { metadata: { annotations: Record<string, string> } } => ({
  metadata: { annotations: { [REFRESH_ANNOTATION]: hard ? "hard" : "normal" } },
});

export const appSetRefreshPatch = (): { metadata: { annotations: Record<string, string> } } => ({
  metadata: { annotations: { [APPSET_REFRESH_ANNOTATION]: "true" } },
});

/** What is running on an Application now: `Running` while a sync (or its termination) is under way. */
export const operationPhase = (app: unknown): string => str(obj(obj(obj(app)?.status)?.operationState)?.phase);

/**
 * Merge patch that starts a sync, the way `argocd app sync` does: an `operation` the application
 * controller picks up and clears. No revision: the app's target revision. Never prunes.
 */
export const syncPatch = (): { operation: { initiatedBy: { username: string }; sync: { prune: boolean } } } => ({
  operation: { initiatedBy: { username: "kns" }, sync: { prune: false } },
});

/** `Synced · Healthy` from an Application's status; "" when it has none. */
export function appStatusText(app: unknown): string {
  const st = obj(obj(app)?.status);
  return [str(obj(st?.sync)?.status), str(obj(st?.health)?.status)].filter(Boolean).join(" · ");
}
