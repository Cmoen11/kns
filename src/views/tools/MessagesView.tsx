// The messages view (`:errors`, docs/ux.md §11.9): every toast of this session, newest first.
import { useEffect, useMemo } from "react";
import type { ViewProps } from "../../foundation";
import { toasts } from "../../foundation";
import { EmptyState, GLYPH_FOR, useMessageLog } from "../../ui";
import { ListPane } from "./ListPane";
import type { ItemRow, ListRow } from "./list-model";
import { clock } from "./open";

export default function MessagesView({ pane, focused, visible }: ViewProps<"messages">) {
  const log = useMessageLog();
  // seeing the list is what clears the bottom row's `errors N`
  useEffect(() => {
    if (visible) toasts.markErrorsSeen();
  }, [visible, log]);

  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const m = log[i];
      out.push({
        type: "item",
        key: String(m.id),
        glyph: GLYPH_FOR[m.kind] as ItemRow["glyph"],
        cells: [clock(m.at), m.text],
        search: `${m.kind} ${m.text}`,
        title: m.text,
      });
    }
    return out;
  }, [log]);

  return <ListPane pane={pane} focused={focused} name="messages" rows={rows} empty={<EmptyState compact>No messages in this session</EmptyState>} />;
}
