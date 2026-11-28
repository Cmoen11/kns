// Every feature plugs in here. Each directory exports register() from its index.ts, which registers
// view kinds, overlays, shell items and (by importing its own small actions file) action handlers.
// Called once from main.tsx, before the first render. Keep register() cheap: heavy code is lazy.
import { register as ops } from "./actions/ops";
import { register as agents } from "./agents";
import { register as catalog } from "./catalog";
import { register as debug } from "./debug";
import { register as dev } from "./dev";
import { register as diag } from "./diag";
import { register as diff } from "./diff";
import { register as hub } from "./hub";
import { register as pack } from "./pack";
import { register as palette } from "./palette";
import { register as sidepanels } from "./sidepanels";
import { register as status } from "./status";
import { register as table } from "./table";
import { register as doc } from "./views/doc";
import { register as logs } from "./views/logs";
import { register as shell } from "./views/shell";
import { register as text } from "./views/text";
import { register as traffic } from "./traffic";
import { register as routes } from "./routes";
import { register as database } from "./database";
import { register as tools } from "./views/tools";
import { register as update } from "./update";
import { register as herdr } from "./herdr";

export function registerFeatures(): void {
  table();
  doc();
  logs();
  shell();
  tools();
  palette();
  ops();
  // after shell(): its bottom-row "pf" indicator is replaced by the activity count
  sidepanels();
  // status colours: namespace health, the titlebar summary, the action log's central hooks
  status();
  // organisation catalog: loaded at start when one was chosen
  catalog();
  // feature foundation (docs/plan-features.md §2.8): stub register()s with placeholder views
  text();
  dev();
  diag();
  diff();
  debug();
  pack();
  agents();
  // pod traffic: `:traffic`
  traffic();
  // HTTP routes: `:routes`
  routes();
  // database browser: right-click a Postgres/MySQL pod, `:db`
  database();
  hub();
  // auto-update: `:update` and the bottom-row `update 0.2.0` item
  update();
  // Herdr: `:herdr add|remove` (Settings → Herdr has the same)
  herdr();
}
