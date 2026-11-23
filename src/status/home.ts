// Home's "Needs attention" section: the worst namespaces of the current context, each opening its
// faults view. Rows, so home walks, filters and opens them like its own. Absent while healthy.
import { useMemo } from "react";
import type { ItemRow } from "../views/tools/list-model";
import { registerHomeSection } from "../views/tools/home-sections";
import { openFaults } from "./faults";
import { useHealth } from "./health";
import { healthText, nsCount, worst } from "./health-model";

function useAttentionRows(): readonly ItemRow[] {
  const byNs = useHealth((s) => s.byNs);
  return useMemo(
    () =>
      worst(byNs).map((h): ItemRow => ({
        type: "item",
        key: h.namespace,
        cells: [h.namespace, healthText(h)],
        value: String(nsCount(h)),
        search: `attention faults failing ${h.namespace}`,
        open: (newPane) => void openFaults(h.namespace, newPane),
      })),
    [byNs],
  );
}

export function registerAttentionHome(): void {
  registerHomeSection({ id: "attention", label: "Needs attention", order: 5, useRows: useAttentionRows });
}
