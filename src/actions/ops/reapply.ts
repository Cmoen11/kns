// "Re-apply last known YAML" after a delete (docs/ux.md §14): strips what the server owns so the
// object can be created again. Pure apart from the yaml parser.
import { parse, stringify } from "yaml";

const SERVER_METADATA = ["uid", "resourceVersion", "creationTimestamp", "deletionTimestamp", "deletionGracePeriodSeconds", "generation", "managedFields", "selfLink", "ownerReferences"];

/** Returns YAML that can be applied to recreate the object, or null when it cannot be parsed. */
export function cleanForReapply(yaml: string): string | null {
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const o = { ...(doc as Record<string, unknown>) };
  if (typeof o.kind !== "string" || typeof o.apiVersion !== "string") return null;
  delete o.status;
  if (typeof o.metadata === "object" && o.metadata !== null) {
    const m = { ...(o.metadata as Record<string, unknown>) };
    for (const k of SERVER_METADATA) delete m[k];
    o.metadata = m;
  }
  return stringify(o);
}

export { canReapply } from "./reapply-rule";
