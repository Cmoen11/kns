// `:catalog`, `:team` and `:env` (docs/catalog.md). Small and eager: the keys of a lazy chunk
// would not work before it loads.
import { registerActions } from "../actions";
import { connOf, getCluster } from "../store/cluster";
import { focusedContext, paneView, setPaneContext } from "../store/layout";
import { contextName, getSettings, setSettings } from "../store/settings";
import { flash } from "../store/status";
import { toasts } from "../ui/toast";
import { contextsFor, environments, scopeTeams, systemOfNamespace, userOf } from "./model";
import { chooseCatalog, forgetCatalog, getCatalog, reloadCatalog } from "./store";

const fail = (e: unknown) => toasts.error((e as { message?: string } | null)?.message ?? String(e));

function summary(): string {
  const c = getCatalog();
  if (!c) return "no catalog: :catalog choose";
  const s = getSettings();
  const me = userOf(c, s.catalogUser);
  const teams = scopeTeams(c, s.catalogUser, s.catalogTeams);
  const who = me ? `you: ${me.name}` : s.catalogUser ? `"${s.catalogUser}" is not in the catalog` : "who are you? :catalog me <email>";
  return `${c.source}: ${c.teams.length} teams, ${c.systems.length} systems · ${who}${teams.length ? ` · teams: ${teams.join(", ")}` : ""}`;
}

registerActions({
  "catalog.open": (ctx) => {
    const [verb, ...rest] = ctx.args ?? [];
    switch (verb ?? "choose") {
      case "choose":
        return void chooseCatalog().then((c) => c && flash(summary()), fail);
      case "reload":
        return void reloadCatalog().then((c) => flash(c ? summary() : "no catalog chosen"), fail);
      case "forget":
        return void forgetCatalog().then(() => flash("catalog forgotten"), fail);
      case "me": {
        const me = rest.join(" ").trim();
        setSettings({ catalogUser: me });
        return flash(summary());
      }
      case "show":
        return flash(summary());
      default:
        flash(`:catalog choose|reload|forget|show|me <email>, not "${verb}"`, "warn");
    }
  },
  "catalog.team": (ctx) => {
    const c = getCatalog();
    const arg = (ctx.args ?? []).join(",").trim();
    if (!c) return flash("no catalog: :catalog choose", "warn");
    if (arg === "") {
      const teams = scopeTeams(c, getSettings().catalogUser, getSettings().catalogTeams);
      return flash(teams.length ? `team scope: ${teams.join(", ")}${getSettings().catalogTeams.length ? "" : " (yours)"}` : "no team scope: :catalog me <email> or :team <team>");
    }
    if (arg === "-") {
      setSettings({ catalogTeams: [] });
      return flash("team scope: your own teams");
    }
    const names = arg.split(",").map((t) => t.trim()).filter(Boolean);
    const unknown = names.filter((n) => !c.teams.some((t) => t.name === n));
    if (unknown.length) return flash(`not in the catalog: ${unknown.join(", ")}`, "warn");
    setSettings({ catalogTeams: names });
    flash(`team scope: ${names.join(", ")}`);
  },
  "catalog.env": (ctx) => {
    const c = getCatalog();
    if (!c) return flash("no catalog: :catalog choose", "warn");
    const env = (ctx.args ?? [])[0];
    const envs = environments(c);
    if (!env) return flash(`:env ${envs.join("|")}`);
    const targets = contextsFor(c, getCluster().contexts, env);
    if (targets.length === 0) return flash(`no kube context is ${env} (catalog: ${envs.join(", ")})`, "warn");
    // the context of the same kind as the one we are in, when several are that environment
    const target = targets.find((t) => connOf(t.name).status === "connected") ?? targets[0];
    const view = paneView();
    const ns = view?.kind === "table" ? view.namespace : undefined;
    const system = systemOfNamespace(c, ns);
    if (system && system.environments.length > 0 && !system.environments.includes(env)) {
      flash(`${system.title} does not run in ${env} (catalog: ${system.environments.join(", ")})`, "warn");
      return;
    }
    if (target.name === focusedContext()) return flash(`already in ${env}`);
    if (setPaneContext(target.name)) flash(`${env}: ${contextName(target.name)}`);
  },
});
