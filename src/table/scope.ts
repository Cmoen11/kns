// Drill-down scopes (docs/ux.md §4.3). Selector and node scopes are server-side (labelSelector,
// fieldSelector). Owner scope is matched on the rows' ownerReferences; a Deployment owns its pods
// through ReplicaSets, so that case also reads the (shared, refcounted) replicasets watch.
import { useMemo, useRef } from "react";
import type { Gvr, Row, TableQuery } from "../ipc/types";
import type { Scope } from "../types";
import { kindOf, useTable } from "../foundation";

const APPS_RS: Gvr = { group: "apps", version: "v1", resource: "replicasets" };

export function scopeSelectors(scope: Scope | undefined): { labelSelector?: string; fieldSelector?: string } {
  if (scope?.by === "selector") return { labelSelector: scope.selector };
  if (scope?.by === "node") return { fieldSelector: `spec.nodeName=${scope.name}` };
  return {};
}

/** True when `row` is owned by the object: by uid, or by kind and name when the uid is unknown. */
export function ownedBy(row: Row, owner: { uid?: string; name: string; kind: string }, via?: ReadonlySet<string>): boolean {
  if (!row.owners) return false;
  for (const o of row.owners) {
    if (owner.uid ? o.uid === owner.uid : o.kind === owner.kind && o.name === owner.name) return true;
    if (via?.has(o.uid)) return true;
  }
  return false;
}

/** The client-side row test of an owner scope, or undefined when the scope needs none. */
export function useScopeTest(scope: Scope | undefined, context: string | null, live: boolean): ((row: Row) => boolean) | undefined {
  const owner = scope?.by === "owner" ? scope.ref : null;
  const viaReplicaSets = owner !== null && owner.gvr.group === "apps" && owner.gvr.resource === "deployments";
  const query = useMemo<TableQuery | null>(
    () => (viaReplicaSets && context && owner ? { context, gvr: APPS_RS, namespace: owner.namespace } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viaReplicaSets, context, owner?.namespace],
  );
  const rs = useTable(query, { live });
  const kind = owner ? kindOf(owner.gvr) : "";

  // the set only changes identity when its content does, so data frames of unrelated ReplicaSets
  // do not re-filter the table
  const last = useRef<{ sig: string; set: ReadonlySet<string> }>({ sig: "", set: new Set() });
  const via = useMemo(() => {
    if (!owner || !viaReplicaSets) return undefined;
    const ids: string[] = [];
    for (const r of rs.rows) if (ownedBy(r, { uid: owner.uid, name: owner.name, kind })) ids.push(r.uid);
    const sig = ids.join(",");
    if (sig !== last.current.sig) last.current = { sig, set: new Set(ids) };
    return last.current.set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rs.rows, owner?.uid, owner?.name, kind, viaReplicaSets]);

  return useMemo(() => {
    if (!owner) return undefined;
    const o = { uid: owner.uid, name: owner.name, kind };
    return (row: Row) => ownedBy(row, o, via);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.uid, owner?.name, kind, via]);
}
