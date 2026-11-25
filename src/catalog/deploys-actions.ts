// `:deploys` and the keys of the deploys view (docs/catalog.md). Small and eager: the view loads
// lazily, and its keys must work before it does.
import { registerActions } from "../actions";
import { flash, focusedPane, openView, paneView, registerViewActions } from "../foundation";
import { paneNamespace } from "../store/layout";
import { toasts } from "../ui/toast";
import { ctl } from "../views/tools/controllers";
import { gitopsOf, systemOfNamespace } from "./model";
import { compareTarget, loadImages, openCompare } from "./deploys";
import { getCatalog } from "./store";

const fail = (e: unknown) => toasts.error((e as { message?: string } | null)?.message ?? String(e));

registerActions({
  "deploys.open": (ctx) => {
    const c = getCatalog();
    if (!c) return flash("no catalog: :catalog choose", "warn");
    const name = ctx.args[0];
    const ns = paneNamespace();
    const system = name ? c.systems.find((s) => s.name === name || s.namespace === name) : systemOfNamespace(c, ns && ns !== "*" ? ns : undefined);
    if (!system) return flash(name ? `no system or namespace "${name}" in the catalog` : "this pane's namespace is no system of the catalog: :deploys <system>", "warn");
    if (!system.namespace) return flash(`${system.title} has no namespace`, "warn");
    if (!gitopsOf(system)?.gitops?.imageFile) return flash(`${system.title} has no ops repository with kns.dev/gitops-image-file in the catalog`, "warn");
    const view = { kind: "deploys" as const, system: system.name, namespace: system.namespace };
    const cur = paneView();
    if (!ctx.newPane && cur?.kind === "deploys" && cur.system === view.system) return;
    openView(view, { newPane: ctx.newPane });
  },
});

const noRow = "no row selected";
const current = () => ctl()?.current();
const target = () => compareTarget(focusedPane(), current()?.key);

registerViewActions(["deploys"], {
  "nav.down": () => ctl()?.move(1),
  "nav.up": () => ctl()?.move(-1),
  "nav.top": () => ctl()?.top(),
  "nav.bottom": () => ctl()?.bottom(),
  "nav.pageDown": () => ctl()?.page(1),
  "nav.pageUp": () => ctl()?.page(-1),
  "nav.open": {
    enabled: () => (!current() ? noRow : !!current()?.open || "no other version to compare with"),
    run: (ctx) => current()?.open?.(ctx.newPane),
  },
  "filter.open": () => ctl()?.filterOpen(),
  "filter.apply": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterApply() },
  "filter.cancel": { when: () => !!ctl()?.isFiltering(), run: () => ctl()?.filterCancel() },
  "filter.clear": { when: () => !!ctl()?.hasFilter() && !ctl()?.isFiltering(), run: () => ctl()?.filterClear() },
});

registerActions({
  "deploys.compare": {
    enabled: () => (!current() ? noRow : !!target() || "no other version to compare with"),
    run: () => {
      const t = target();
      if (t) void openCompare(t).catch(fail);
    },
  },
  "deploys.reload": () => {
    const v = paneView();
    const system = v?.kind === "deploys" ? getCatalog()?.systems.find((s) => s.name === v.system) : undefined;
    const ops = gitopsOf(system);
    if (!ops?.repo || !ops.gitops?.imageFile) return flash("no ops repository", "warn");
    loadImages(ops.repo, ops.gitops.imageFile, true);
    flash(`reading ${ops.repo}`);
  },
});
