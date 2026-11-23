// Placeholder view used by the feature stubs until the real views land. It proves the plumbing:
// a table placeholder reads live rows through the shared tables store and publishes a selection.
import { useEffect, useMemo } from "react";
import { PaneSlot } from "../panes/slots";
import { usePaneContext } from "../store/layout";
import { setSelection } from "../store/selection";
import { useTable } from "../store/tables";
import type { TableQuery } from "../ipc/types";
import { EmptyState } from "../ui";
import type { ViewOf, ViewProps } from "./registry";

const SHOWN = 40;

function TablePlaceholder({ pane, view, visible }: ViewProps<"table">) {
  const context = usePaneContext(pane);
  const query = useMemo<TableQuery | null>(
    () => (context ? { context, gvr: view.gvr, namespace: view.namespace === "*" ? undefined : view.namespace } : null),
    [context, view.gvr, view.namespace],
  );
  const snap = useTable(query, { live: visible, pane });
  const first = snap.rows[0];
  useEffect(() => {
    setSelection(pane, { focused: first ? { gvr: view.gvr, namespace: first.namespace, name: first.name, uid: first.uid } : null });
  }, [pane, view.gvr, first?.uid, first?.name, first?.namespace]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setSelection(pane, null), [pane]);

  if (!snap.synced) return <EmptyState compact>syncing</EmptyState>;
  return (
    <div className="stub">
      <PaneSlot name="count">{snap.rows.length}</PaneSlot>
      <div className="stub-rows t-cell">
        {snap.rows.slice(0, SHOWN).map((r) => (
          <div className="stub-row" key={r.uid}>
            {r.cells.slice(0, 5).map((c, i) => (
              <span key={i}>{c === null ? "" : String(c)}</span>
            ))}
          </div>
        ))}
      </div>
      <div className="stub-note t-ui">Placeholder table: first {Math.min(SHOWN, snap.rows.length)} of {snap.rows.length} rows, live.</div>
    </div>
  );
}

export default function Placeholder(props: ViewProps) {
  if (props.view.kind === "table") return <TablePlaceholder {...props} view={props.view as ViewOf<"table">} />;
  return <EmptyState compact>The {props.view.kind} view is not built yet.</EmptyState>;
}
