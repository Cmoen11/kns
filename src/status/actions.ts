// Action handlers of the status package. Small and eager; keys live in keymap-data.ts.
// health.nsFaults and sidebar.problemsFirst act on the sidebar and live in sidepanels/actions.ts.
import { registerActions } from "../actions";
import { getHealth } from "./health";
import { openFaults } from "./faults";

registerActions({
  // `:faults` = every namespace, `:faults <ns>` = one
  "health.faults": {
    enabled: () => {
      const h = getHealth();
      if (!h.known) return h.snapshot ? `namespace health is ${h.snapshot.state}` : "namespace health is off (settings)";
      return true;
    },
    run: (ctx) => void openFaults(ctx.args[0] ?? "*", ctx.newPane),
  },
});
