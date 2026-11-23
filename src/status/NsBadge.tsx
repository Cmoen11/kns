// The health badge of one namespace row in the context sidebar (and the total on "all
// namespaces"): status glyph + count, quiet when healthy. A leaf with its own narrow subscription,
// so a health snapshot re-renders only the badges whose counts changed, never the row list.
// A click opens that namespace's faults view (health.nsFaults with the namespace as its arg); it
// never takes the focus and does not switch the namespace the way a row click does.
import { memo } from "react";
import { engine } from "../keys";
import { Glyph, tip } from "../ui";
import { useHealth } from "./health";
import { healthText, merged, nsCount, nsSeverity } from "./health-model";

export const NsBadge = memo(function NsBadge({ ns }: { ns: string }) {
  const one = useHealth((s) => (ns === "*" ? undefined : s.byNs.get(ns)));
  const all = useHealth((s) => (ns === "*" && s.totals.count > 0 ? s.snapshot : null));
  const h = ns === "*" ? merged(all) : one;
  const count = nsCount(h);
  const sev = nsSeverity(h);
  if (!h || count === 0 || !sev) return null;
  const what = healthText(h);
  return (
    <button
      type="button"
      className="ns-badge t-ui num"
      data-state={sev}
      tabIndex={-1}
      aria-label={`${count} faulty in ${ns === "*" ? "all namespaces" : ns}: ${what}. Show them`}
      {...tip(what, { reason: "click or ! : show only the faulty objects" })}
      onMouseDown={(e) => {
        // the row's mousedown would move the cursor and its click switch the namespace
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        engine.run("health.nsFaults", { source: "pointer", args: [ns], newPane: e.ctrlKey || e.metaKey ? "right" : e.shiftKey ? "down" : null });
      }}
    >
      <Glyph state={sev} />
      {count}
    </button>
  );
});
