// Short, readable forms of kubeconfig cluster / user names. EKS and GKE write long generated
// names (`arn:aws:eks:eu-west-1:123456789012:cluster/pd-1`, `gke_project_zone_name`) that push
// the useful part, the cluster's own name, off the end of a sidebar row.

/** `arn:aws:eks:eu-west-1:123:cluster/pd-1` → `pd-1 · 123 · eu-west-1`; GKE → `name · project`; else as is. */
export function shortClusterName(name: string): string {
  const eks = /^arn:aws[\w-]*:eks:([^:]+):(\d+):cluster\/(.+)$/.exec(name);
  if (eks) return `${eks[3]} · ${eks[2]} · ${eks[1]}`;
  const gke = /^gke_([^_]+)_([^_]+)_(.+)$/.exec(name);
  if (gke) return `${gke[3]} · ${gke[1]}`;
  return name;
}

/**
 * The detail line of a context: `cluster / user`, shortened. The user is left out when it names the
 * same cluster (EKS and GKE kubeconfigs name the user after the cluster).
 */
export function contextDetail(cluster: string, user: string): string {
  const c = shortClusterName(cluster);
  if (!user || user === cluster) return c;
  const u = shortClusterName(user);
  return u === c ? c : `${c} / ${u}`;
}
