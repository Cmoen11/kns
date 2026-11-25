// Mock of DiffBackend (contract/diff.ts). Owner D.
// Field owners match the paths of the base mock's getYaml body (src/ipc/mock.ts yamlFor), so the
// YAML gutter has a letter on real lines: Flux owns most of it, `kubectl-scale` owns spec.replicas
// (the one drift field), a controller the status. The `worker` app is not Flux-managed, and in the
// namespaces Argo CD deploys to (mock/argo.ts) `argocd-controller` owns what Flux owns elsewhere.
import type { DiffBackend, FieldOwner, Json, ObjRef, Revision } from "../types";
import { argoManaged } from "./argo";
import { delay, fail } from "./shared";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;

const C0 = "/spec/template/spec/containers/0";

function owners(ref: ObjRef): FieldOwner[] {
  const app = ref.name.split("-")[0];
  const flux = app !== "worker";
  const base: Omit<FieldOwner, "path"> = flux && argoManaged(ref.namespace)
    ? { manager: "argocd-controller", managerClass: "argo", operation: "Apply", time: ago(DAY) }
    : flux
    ? { manager: "kustomize-controller", managerClass: "flux", operation: "Apply", time: ago(DAY) }
    : { manager: "kubectl-client-side-apply", managerClass: "kubectl", operation: "Update", time: ago(3 * DAY) };
  const applied = [
    "/metadata/labels/app",
    "/metadata/annotations/kns.dev~1mock",
    "/spec/selector/matchLabels/app",
    C0,
    `${C0}/name`,
    `${C0}/image`,
    `${C0}/ports/0`,
    `${C0}/ports/0/containerPort`,
    `${C0}/resources/requests/cpu`,
    `${C0}/resources/requests/memory`,
    `${C0}/resources/limits/memory`,
  ].map((path): FieldOwner => ({ ...base, path }));
  const replicas: FieldOwner = flux
    ? { path: "/spec/replicas", manager: "kubectl-scale", managerClass: "kubectl", operation: "Update", subresource: "scale", time: ago(3_600_000) }
    : { path: "/spec/replicas", manager: "kns", managerClass: "kns", operation: "Update", subresource: "scale", time: ago(600_000) };
  const status: FieldOwner = {
    path: "/status/phase", manager: "kube-controller-manager", managerClass: "controller", operation: "Update", subresource: "status", time: ago(60_000),
  };
  return [...applied, replicas, status].sort((a, b) => a.path.localeCompare(b.path));
}

/** A pod template per revision: the image tag and one env value move between revisions. */
function template(app: string, rev: number): Json {
  return {
    metadata: { labels: { app } },
    spec: {
      containers: [
        {
          name: "main",
          image: `ghcr.io/example/${app}:1.4.${rev}`,
          env: [
            { name: "LOG_LEVEL", value: rev >= 3 ? "debug" : "info" },
            { name: "FEATURE_X", value: rev >= 2 ? "on" : "off" },
          ],
          ports: [{ containerPort: 8080, protocol: "TCP" }],
          resources: { requests: { cpu: "50m", memory: rev >= 2 ? "96Mi" : "64Mi" }, limits: { memory: "256Mi" } },
        },
      ],
    },
  };
}

function revisions(ref: ObjRef): Promise<Revision[]> {
  const app = ref.name.split("-")[0];
  const at = (rev: number) => ago((4 - rev) * DAY);
  const child = (resource: string, name: string, namespace = ref.namespace): ObjRef => ({
    context: ref.context, gvr: { group: resource === "secrets" ? "" : "apps", version: "v1", resource }, namespace, name,
  });
  switch (`${ref.gvr.group}/${ref.gvr.resource}`) {
    case "apps/deployments":
      return delay(
        [3, 2, 1].map((revision) => {
          const name = `${ref.name}-${revision}a${revision}b${revision}c`;
          return { id: name, revision, createdAt: at(revision), image: `ghcr.io/example/${app}:1.4.${revision}`, ref: child("replicasets", name), template: template(app, revision) };
        }),
      );
    case "apps/statefulsets":
    case "apps/daemonsets":
      return delay(
        [2, 1].map((revision) => {
          const name = `${ref.name}-${revision}f${revision}e`;
          return { id: name, revision, createdAt: at(revision), image: `ghcr.io/example/${app}:1.4.${revision}`, ref: child("controllerrevisions", name), template: { spec: { template: template(app, revision) } } };
        }),
      );
    case "helm.toolkit.fluxcd.io/helmreleases":
      return delay(
        [3, 2, 1].map((revision) => {
          const name = `sh.helm.release.v1.${ref.name}.v${revision}`;
          return { id: name, revision, createdAt: at(revision), ref: child("secrets", name) };
        }),
      );
    default:
      return fail("Invalid", `${ref.gvr.resource} have no revisions`, 400);
  }
}

export const diffMock: DiffBackend = {
  fieldOwners: (ref) => delay(owners(ref)),
  revisions,
};
