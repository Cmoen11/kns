// The context sidebar (left): every kube context, the namespaces of the window's context and the
// saved favourites, one click or j/k + Enter away. It only calls what the pickers call:
// switchContext (with its live-session confirm), setNamespace + noteNamespaceUsed, recallFavourite
// and recallLayout. Lazy chunk: mounted only while the panel is open.
import { useEffect, useMemo, useRef } from "react";
import { favouriteSummary, treeSummary } from "../palette/favourites/model";
import { nsSlotOf } from "../palette/favourites/slots";
import { noteNamespaceUsed, recallFavourite, recallLayout, useFav } from "../palette/favourites/store";
import { contextDetail } from "../store/context-label";
import { awsSsoLogin, clusterStore, needsSsoLogin, refreshContexts, resourceFor, switchContext, useCluster, useNamespaces, watchSso } from "../store/cluster";
import { focusedPane, paneView, setNamespace, useWorkspace } from "../store/layout";
import { useSettings } from "../store/settings";
import { flash } from "../store/status";
import { viewOf } from "../store/workspace";
import { useHealth } from "../status/health";
import { problemsFirst } from "../status/health-model";
import { Keys, toasts } from "../ui";
import { PanelHeader, Rows } from "./Frame";
import { headerKey, matches, type PanelRow } from "./model";
import { setFilter, usePrefs, useRuntime } from "./store";

const STATUS_WORD = { idle: "idle", connecting: "connecting", connected: "connected", offline: "offline" } as const;

/** Why the focused pane cannot take a namespace (the same rule as the namespace picker), or null. */
function namespaceBlocker(): string | null {
  const v = paneView();
  if (v?.kind !== "table") return "this view has no namespace";
  if (resourceFor(v.gvr)?.namespaced === false) return `${v.gvr.resource} are cluster-scoped`;
  return null;
}

/** false when nothing changed (the focus then stays in the sidebar). */
function applyNamespace(ns: string): boolean {
  const blocker = namespaceBlocker();
  if (blocker) {
    flash(blocker, "warn");
    return false;
  }
  setNamespace(ns, focusedPane() ?? undefined);
  noteNamespaceUsed(ns);
  return true;
}

function FilterInput() {
  const text = useRuntime((s) => s.filter);
  const tick = useRuntime((s) => s.filterTick);
  const input = useRef<HTMLInputElement>(null);
  const handled = useRef(tick);
  useEffect(() => {
    if (tick === handled.current) return;
    handled.current = tick;
    input.current?.focus();
    input.current?.select();
  }, [tick]);
  return (
    <div className="side-filter">
      <label className="t-label" htmlFor="side-filter-input">
        FILTER
      </label>
      <input
        id="side-filter-input"
        ref={input}
        className="t-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        value={text}
        onChange={(e) => setFilter(e.target.value)}
      />
      {text === "" && <Keys action="sidebar.filter" />}
    </div>
  );
}

/** The sign-in button's tip: what runs, and why it is offered. */
function ssoHint(context: string, profile: string): string {
  const st = clusterStore.getState().sso?.[context];
  const why =
    st?.state === "expired" && st.expiresAt ? `signed out ${new Date(st.expiresAt).toLocaleString()}` : st?.state === "unknown" ? "not signed in" : st ? "the cluster refused the credentials" : "";
  return `aws sso login (${profile})${why ? ` · ${why}` : ""}`;
}

export default function ContextSidebar() {
  const contexts = useCluster((s) => s.contexts);
  const active = useCluster((s) => s.context);
  const status = useCluster((s) => s.status);
  const signingIn = useCluster((s) => s.signingIn);
  // which contexts offer a sign-in: a string, so the rows rebuild only when that set changes
  const loginNeeded = useCluster((s) => s.contexts.filter((c) => needsSsoLogin(c, s)).map((c) => c.name).join("\n"));
  const flags = useSettings((s) => s.contexts);
  const { names, synced, forbidden } = useNamespaces();
  // the focused pane's namespace, or null when it has none
  const namespace = useWorkspace((ws) => {
    const v = ws ? viewOf(ws, ws.focused) : undefined;
    return v?.kind === "table" ? v.namespace : null;
  });
  const slots = useFav((s) => s.nsSlots[active ?? ""]);
  const favourites = useFav((s) => s.favorites);
  const layouts = useFav((s) => s.layouts);
  const collapsed = usePrefs((s) => s.left.collapsed);
  const filter = useRuntime((s) => s.filter);
  // namespace health: the badges are leaves (NsBadge); the row list only follows the health when it
  // sorts by it, or when the health turns unknown (the header says so)
  const healthOn = useSettings((s) => s.nsHealth);
  const sortByHealth = useSettings((s) => s.nsProblemsFirst) && healthOn;
  const byNs = useHealth((s) => (sortByHealth ? s.byNs : null));
  const healthState = useHealth((s) => s.snapshot?.state ?? null);
  const healthMessage = useHealth((s) => s.snapshot?.message);

  // the kubeconfig may have changed since startup (the context picker does the same)
  useEffect(() => {
    refreshContexts().catch((e: unknown) => toasts.error(`Reading contexts failed: ${String(e)}`));
  }, []);
  // the sign-in buttons follow the AWS token cache while the sidebar is open
  useEffect(() => watchSso(), []);
  // the filter belongs to this visit
  useEffect(() => () => setFilter(""), []);

  const rows = useMemo(() => {
    const out: PanelRow[] = [];
    const needLogin = new Set(loginNeeded.split("\n"));
    const filtering = filter.trim() !== "";
    const section = (id: string, label: string, items: PanelRow[], extra?: Partial<PanelRow>) => {
      // a filter looks into folded sections too
      const folded = !filtering && (collapsed[id] ?? false);
      out.push({ key: headerKey(id), section: id, header: true, collapsed: folded, label, count: items.length, ...extra });
      if (!folded) out.push(...items);
    };

    section(
      "contexts",
      "Contexts",
      contexts
        .filter((c) => matches(filter, c.name, c.cluster, c.user))
        .map((c): PanelRow => {
          const f = flags[c.name];
          const labels = [f?.protected ? "PROTECTED" : "", f?.readOnly ? "READ ONLY" : ""].filter(Boolean);
          const current = c.name === active;
          return {
            key: `ctx:${c.name}`,
            section: "contexts",
            label: c.name,
            detail: contextDetail(c.cluster, c.user),
            current,
            labels: labels.length > 0 ? labels : undefined,
            trailing: current ? STATUS_WORD[status] : undefined,
            // signed in: no button; it returns when the token expires or the cluster refuses it
            login:
              c.awsProfile && (signingIn === c.name || needLogin.has(c.name))
                ? { run: () => awsSsoLogin(c.name), busy: signingIn === c.name, hint: ssoHint(c.name, c.awsProfile) }
                : undefined,
            // the same call as the context picker: it confirms live sessions that would end
            // resolves false when the confirm was answered "Stay": the focus then stays here
            activate: () => switchContext(c.name).catch((e: unknown) => (toasts.error(String(e)), false)),
          };
        }),
    );

    const blocked = namespace === null;
    const nsRow = (ns: string): PanelRow => {
      const slot = ns === "*" ? 0 : nsSlotOf(slots ?? [], ns);
      return {
        key: `ns:${ns}`,
        section: "namespaces",
        label: ns === "*" ? "all namespaces" : ns,
        current: ns === namespace,
        trailing: ns === "*" ? "0" : slot > 0 ? String(slot) : undefined,
        health: healthOn ? ns : undefined,
        disabled: blocked ? "the focused pane has no namespace" : undefined,
        activate: () => applyNamespace(ns),
      };
    };
    const ordered = byNs ? problemsFirst(names, byNs) : names;
    const nsItems = ["*", ...ordered].filter((ns) => matches(filter, ns === "*" ? "all namespaces" : ns)).map(nsRow);
    section("namespaces", "Namespaces", nsItems, {
      count: names.length,
      trailing: forbidden ? "forbidden" : !synced ? "syncing" : healthOn && (healthState === "forbidden" || healthState === "error") ? "health unknown" : undefined,
      trailingTip: healthOn && (healthState === "forbidden" || healthState === "error") ? `Namespace health: ${healthState}${healthMessage ? ` (${healthMessage})` : ""}` : undefined,
    });

    const bySlot = <T extends { slot?: number }>(list: readonly T[]) => [...list].sort((a, b) => (a.slot ?? 10) - (b.slot ?? 10));
    const favItems: PanelRow[] = [
      ...bySlot(favourites)
        .filter((f) => matches(filter, f.name, favouriteSummary(f.view)))
        .map((f): PanelRow => ({
          key: `fav:${f.id}`,
          section: "favourites",
          label: f.name,
          detail: favouriteSummary(f.view),
          trailing: f.slot ? String(f.slot) : undefined,
          activate: () => recallFavourite(f),
        })),
      ...bySlot(layouts)
        .filter((l) => matches(filter, l.name, "layout"))
        .map((l): PanelRow => ({
          key: `layout:${l.id}`,
          section: "favourites",
          label: l.name,
          detail: `layout: ${treeSummary(l.root, l.views)}`,
          trailing: l.slot ? String(l.slot) : undefined,
          labels: ["LAYOUT"],
          activate: () => recallLayout(l),
        })),
    ];
    section("favourites", "Favourites", favItems);
    return out;
  }, [contexts, active, status, flags, names, synced, forbidden, namespace, slots, favourites, layouts, collapsed, filter, healthOn, byNs, healthState, healthMessage, sortByHealth, signingIn, loginNeeded]);

  return (
    <>
      <PanelHeader side="left" title="Switch" toggle="sidebar.toggle" />
      <FilterInput />
      <Rows side="left" rows={rows} label="Contexts, namespaces and favourites" />
    </>
  );
}
