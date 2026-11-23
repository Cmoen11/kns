// Kept apart from ./reapply so the eager actions file does not pull the yaml parser into the
// entry chunk.

/**
 * Objects for which re-apply is not offered: a recreated PVC or namespace does not bring its
 * contents back, and owned objects (pods of a ReplicaSet) are recreated by their controller.
 */
export function canReapply(resource: string, owned: boolean): boolean {
  if (owned) return false;
  return !["persistentvolumeclaims", "persistentvolumes", "namespaces", "customresourcedefinitions", "nodes", "events"].includes(resource);
}
