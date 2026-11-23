// The Tools hub (docs/plan-features.md §3 I): every tool in groups, with its keys from the live
// keymap and its live status; a detail column (wide panes, or `i`) with the structured help, how to
// start it (keys, `:` commands, mouse paths derived from the pointer registries), "Try it" on the
// current object and "Learn more". Keys arrive as registry actions through the hub controller;
// pointer controls run the same actions (docs/frontend.md §17).
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { currentView, engine, isTauri, focusedPane, focusPane, LAYERS, PaneSlot, registry, replaceView, runAction, useCluster, useScopeLayer, useWorkspace, type ActionId, type ViewProps } from "../foundation";
import { useEngineValue } from "../keys";
import type { Binding } from "../types";
import { BarInput, Button, EmptyState, FilterChip, Icon, KeyChip, keepFocus, tip } from "../ui";
import { cleanUntrusted } from "../ui/untrusted";
import { subscribeToolBuilt, toolById, TOOLS, type ToolEntry, type ToolId, type ToolStatusHook } from "./catalog";
import { setHubController } from "./controller";
import { hubRows, rowIndex, stepRow, toolIcon, type HubRow } from "./model";
import { refreshMcpStatus, statusHookOf, useMcpStatus } from "./status";
import { runToolTry, toolMousePaths, tryPlan } from "./actions";
import { TOOL_EXTRAS, whereLabel } from "./extras";
import { GUIDES, guideForTool, stepAsTool, type Guide, type GuideCheck } from "./guides";
import { useForwards } from "../views/shell/forwards";
import "./hub.css";

const DEV_ONLY_COMMANDS: ReadonlySet<string> = new Set([":mcp demo"]);
const SHOW_DEV_COMMANDS = import.meta.env.DEV && !isTauri;

/** Panes at least this wide show the detail column next to the list (§3 I). */
const WIDE_PX = 640;

// ── catalog version: registry changes, setToolBuilt, registerTool, registerToolStatus ──
let catalogVersion = 0;
const subscribeCatalog = (fn: () => void) => {
  const bump = () => {
    catalogVersion++;
    fn();
  };
  const a = registry.subscribe(bump);
  const b = subscribeToolBuilt(bump);
  return () => {
    a();
    b();
  };
};
const useCatalogVersion = () => useSyncExternalStore(subscribeCatalog, () => catalogVersion);

/** Joins bindings into one string for a store selector; "|" is itself a key (favourites). */
const SEP = "\u0001";

/**
 * The first key of a tool's first built action that has one. Keys that only work inside the tool's
 * own view (the agents view's `a`) do not start it, so they are not its row chip.
 */
function firstBinding(t: ToolEntry, bindingsFor: (id: ActionId) => Binding[]): Binding | undefined {
  for (const id of t.actions) {
    const def = registry.get(id);
    if (!def?.built) continue;
    if (t.kinds?.length && def.scopes.length > 0 && def.scopes.every((s) => (t.kinds as readonly string[]).includes(s))) continue;
    const b = bindingsFor(id)[0];
    if (b) return b;
  }
  return undefined;
}

/** Inline `code` spans of catalog help text as DOM (no markup beyond that). */
function inline(text: string): ReactNode[] {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>));
}

// a hook's identity → a key, so a status registered while the hub is open remounts its cell
const hookKeys = new WeakMap<ToolStatusHook, number>();
let hookSeq = 0;
const hookKey = (h: ToolStatusHook) => {
  let k = hookKeys.get(h);
  if (k === undefined) hookKeys.set(h, (k = ++hookSeq));
  return k;
};

function StatusText({ use }: { use: ToolStatusHook }) {
  const s = use();
  if (!s) return null;
  return (
    <span className="hub-status" data-state={s.state}>
      {cleanUntrusted(s.text, 120)}
    </span>
  );
}
/** The live status of a tool, or "coming" while it is not built. */
function Status({ tool }: { tool: ToolEntry }) {
  if (!tool.built()) return <span className="hub-status" data-state="coming">coming</span>;
  const use = statusHookOf(tool.id);
  return use ? <StatusText key={hookKey(use)} use={use} /> : null;
}

const Row = memo(function Row({ row, index, focus, binding }: { row: HubRow; index: number; focus: boolean; binding?: Binding; version: number }) {
  if (row.type === "group") {
    return (
      <div className="hub-row hub-group t-label" data-index={index} role="presentation">
        {row.label}
      </div>
    );
  }
  const t = row.tool;
  const built = t.built();
  return (
    <div className="hub-row row t-cell" data-index={index} data-focus={focus || undefined} data-coming={!built || undefined} role="option" aria-selected={focus} {...tip(t.summary, { plain: true, delay: 900 })}>
      <Icon name={toolIcon(t)} />
      <span className="hub-title">{t.title}</span>
      <span className="hub-summary muted">{t.summary}</span>
      {binding && <KeyChip binding={binding} disabled={!built} />}
      <Status tool={t} />
    </div>
  );
});

function FilterBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // the input owns its keys through this layer: Enter applies, Esc cancels (filter.apply / filter.cancel)
  useScopeLayer(LAYERS.filterInput);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <BarInput ref={ref} label="FILTER" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Filter tools" />;
}

function ActionKeys({ id }: { id: ActionId }) {
  const bindings = useEngineValue((e) => e.bindingsFor(id).map((b) => b.join(" ")).join(SEP));
  const def = registry.get(id);
  if (!def?.built) return null;
  const list = bindings ? bindings.split(SEP).map((b) => b.split(" ")) : [];
  const where = whereLabel(def.scopes);
  return (
    <li className="hub-how-row">
      <span className="hub-how-label">{def.label}</span>
      {list.slice(0, 2).map((b, i) => (
        <KeyChip key={i} binding={b} />
      ))}
      {list.length === 0 && def.command && <code>:{def.command}</code>}
      {where && <span className="hub-where muted">{where}</span>}
    </li>
  );
}

/** The MCP entry: the server's live tool list (from mcp_status, never copied into TS) and "Connect an agent…". */
function McpDetail({ pane }: { pane: string }) {
  const status = useMcpStatus();
  useEffect(refreshMcpStatus, []);
  const connect = registry.get("agents.connect")?.built;
  return (
    <section className="hub-sec">
      <h3 className="hub-h t-label">Agents</h3>
      {connect ? (
        <Button
          className="hub-btn"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={() => {
            if (focusedPane() !== pane) focusPane(pane);
            engine.run("agents.connect", { source: "pointer" });
          }}
        >
          Connect an agent…
        </Button>
      ) : (
        <p className="muted">
          Connecting an agent arrives with the MCP server (<code>:mcp setup</code>).
        </p>
      )}
      <h3 className="hub-h t-label">MCP tools {status ? `(${status.tools.length})` : ""}</h3>
      {status && status.tools.length > 0 ? (
        <ul className="hub-mcp">
          {status.tools.map((t) => (
            <li key={t.name}>
              <code>{cleanUntrusted(t.name, 80)}</code> <span className="muted">{cleanUntrusted(t.description, 400)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{status ? "The server lists its tools once it is built and running." : "asking the server…"}</p>
      )}
    </section>
  );
}

/** Live "done" marks of guide steps: cheap selectors on stores the hub already reads. */
function useGuideChecks(): Record<GuideCheck, boolean> {
  const connected = useCluster((s) => s.status === "connected");
  const forward = useForwards((s) => s.list.length > 0);
  const devSetUp = useForwards((s) => s.list.some((f) => !!f.devSet));
  const envOpen = useWorkspace((ws) => !!ws && Object.values(ws.panes).some((p) => currentView(p).kind === "env"));
  const mcp = useMcpStatus();
  // a client counts once its token was used (a token alone means only that the wizard ran)
  const client = !!mcp?.clients.some((c) => c.calls > 0 || !!c.lastUsedAt);
  return { connected, forward, devSetUp, envOpen, mcpOn: !!mcp?.on, client };
}

/**
 * Whether a step button shows its action's key: not when that key works only inside another view
 * the step does not need (the agents view's `a` for "Connect an agent…" from the hub).
 */
const VIEW_ONLY = new Set(["agents", "devsets", "traps", "hub"]);
function chipWorks(id: ActionId, needs: string): boolean {
  const scopes = registry.get(id)?.scopes ?? [];
  return !(needs === "none" && scopes.length > 0 && scopes.every((s) => VIEW_ONLY.has(s)));
}

/** One getting-started path (src/hub/guides.ts): numbered steps, keys, a live done mark, a "Do it" button. */
function GuideSteps({ guide, tool }: { guide: Guide; tool: ToolEntry }) {
  const checks = useGuideChecks();
  // plans follow focus and cursors like Try: re-read on engine notifications
  const plans = useEngineValue(
    () => guide.steps.map((s) => { const t = stepAsTool(tool, s); return t ? tryPlan(t) : null; }),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  return (
    <section className="hub-sec hub-guide" aria-label={guide.title}>
      <h3 className="hub-h t-label">Getting started: {guide.title}</h3>
      <ol className="hub-steps">
        {guide.steps.map((s, i) => {
          const done = s.done ? checks[s.done] : false;
          const plan = plans[i];
          const t = stepAsTool(tool, s);
          return (
            <li key={s.title} className="hub-step" data-done={done || undefined}>
              <div className="hub-step-head">
                <span className="hub-step-n">{done ? <Icon name="check" /> : i + 1}</span>
                <span className="hub-step-title">{s.title}</span>
                {s.optional && <span className="muted">optional</span>}
              </div>
              <p className="hub-step-body">{inline(s.body)}</p>
              {(t || s.command) && (
                <div className="hub-step-do">
                  {t && plan && s.run && (
                    <Button
                      action={chipWorks(s.run.action, s.run.needs) ? s.run.action : undefined}
                      className="hub-btn"
                      tabIndex={-1}
                      aria-disabled={!plan.ok || undefined}
                      {...tip(plan.ok ? (s.run.writes ? "Opens its dialog; nothing changes until you confirm there" : s.run.label) : plan.reason, { reason: plan.ok ? "Ctrl+click opens beside" : undefined })}
                      onMouseDown={keepFocus}
                      onClick={(e: MouseEvent) => void runToolTry(t, e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null)}
                    >
                      {plan.ok ? plan.label.replace(/^Try: /, "") : s.run.label}
                    </Button>
                  )}
                  {s.command && <code>{s.command}</code>}
                  {plan && !plan.ok && <span className="hub-reason muted">{plan.reason}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The getting-started paths at the top of the list: each opens the entry that shows it. */
function StartHere({ pane, onOpen }: { pane: string; onOpen: () => void }) {
  return (
    <div className="hub-start" role="group" aria-label="Start here">
      <span className="hub-start-label t-label">Start here</span>
      {GUIDES.map((g) => (
        <Button
          key={g.id}
          variant="tertiary"
          className="hub-btn"
          tabIndex={-1}
          {...tip(g.summary, { reason: `:tools ${g.id}` })}
          onMouseDown={keepFocus}
          onClick={() => {
            if (focusedPane() !== pane) focusPane(pane);
            engine.run("hub.open", { source: "pointer", args: [g.tool] });
            onOpen();
          }}
        >
          {g.title}
        </Button>
      ))}
    </div>
  );
}

function Detail({ tool, pane, onClose }: { tool: ToolEntry; pane: string; onClose?: () => void }) {
  const built = tool.built();
  const extra = TOOL_EXTRAS[tool.id];
  const guide = guideForTool(tool.id);
  // `:mcp demo` exists only in the browser dev build (docs/plan-features.md §2.11)
  // an action without a key already shows its `:command` in its own row: not twice
  const shownAsRow = new Set(
    tool.actions.flatMap((id) => {
      const def = registry.get(id);
      return def?.built && def.command && engine.bindingsFor(id).length === 0 ? [`:${def.command}`] : [];
    }),
  );
  const commands = tool.commands.filter((c) => (SHOW_DEV_COMMANDS || !DEV_ONLY_COMMANDS.has(c)) && !shownAsRow.has(c));
  // the plan follows the focus, the cursor rows and the registry: re-read on engine notifications
  const plan = useEngineValue(() => tryPlan(tool), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const mouse = useMemo(() => (built ? [...toolMousePaths(tool), ...(extra?.mouse ?? [])] : []), [tool, built, extra]);
  const runTryClick = (e: MouseEvent) => runAction("nav.open", { pane, newPane: e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null });
  return (
    <div className="hub-detail t-ui-multi" aria-label={`${tool.title} details`}>
      <div className="hub-dhead">
        <Icon name={toolIcon(tool)} />
        <span className="hub-dtitle t-ui">{tool.title}</span>
        <span className="muted">{tool.group}</span>
        <Status tool={tool} />
        {onClose && (
          <button type="button" className="k-abtn" tabIndex={-1} aria-label="Back to the list" {...tip("Back to the list", { reason: "i" })} onMouseDown={keepFocus} onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <p className="hub-answers">{inline(tool.help.answers)}</p>
      {tool.help.notFor && (
        <p>
          <span className="hub-k">Not for</span> {inline(tool.help.notFor)}
        </p>
      )}
      {tool.help.safety && (
        <p>
          <span className="hub-k">Safety</span> {inline(tool.help.safety)}
        </p>
      )}
      {tool.help.example && (
        <p>
          <span className="hub-k">Example</span> {inline(tool.help.example)}
        </p>
      )}
      {!built && <p className="hub-coming">Not built yet: this tool is coming in a later version of kns.</p>}
      {built && guide && <GuideSteps guide={guide} tool={tool} />}

      <section className="hub-sec">
        <h3 className="hub-h t-label">How to start</h3>
        {extra?.how && <p>{inline(extra.how)}</p>}
        <ul className="hub-how">
          {tool.actions.map((id) => (
            <ActionKeys key={id} id={id} />
          ))}
        </ul>
        {commands.length > 0 && (
          <p className="hub-cmds">
            {commands.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </p>
        )}
        {mouse.length > 0 && (
          <>
            <h4 className="hub-sub t-label">With the mouse</h4>
            <ul className="hub-mouse">
              {mouse.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </>
        )}
        {built && <p className="muted">Every action is also in the palette (Ctrl+K) under its name.</p>}
      </section>

      {built && tool.try && (
        <section className="hub-sec">
          <h3 className="hub-h t-label">Try it</h3>
          <Button
            variant="primary"
            action="nav.open"
            className="hub-btn hub-try"
            tabIndex={-1}
            aria-disabled={!plan.ok || undefined}
            {...tip(plan.ok ? "Enter, or double-click the row" : plan.reason, { reason: plan.ok ? "Ctrl+click opens beside" : undefined })}
            onMouseDown={keepFocus}
            onClick={runTryClick}
          >
            {plan.label}
          </Button>
          {!plan.ok && <span className="hub-reason muted">{plan.reason}</span>}
          {plan.ok && plan.writes && <span className="hub-reason muted">opens its dialog; nothing changes until you confirm there</span>}
        </section>
      )}

      {built && !tool.try && extra?.noTry && (
        <section className="hub-sec">
          <h3 className="hub-h t-label">Try it</h3>
          <p className="muted">No try here: {extra.noTry}.</p>
        </section>
      )}

      {tool.id === "mcp" && <McpDetail pane={pane} />}

      <section className="hub-sec">
        <Button variant="tertiary" className="hub-btn" tabIndex={-1} {...tip("Opens the section of docs/tools.md", { reason: ":tools help" })} onMouseDown={keepFocus} onClick={() => runAction("hub.help", { pane })}>
          Learn more
        </Button>
      </section>
    </div>
  );
}

export default function HubView({ pane, view, focused }: ViewProps<"hub">) {
  const version = useCatalogVersion();
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [detail, setDetail] = useState<boolean | null>(null);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const beforeFilter = useRef("");

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wide = width >= WIDE_PX;
  const showDetail = detail ?? wide;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => hubRows(TOOLS, filter), [filter, version]);
  const index = rowIndex(rows, view.tool);
  const current = index >= 0 ? (rows[index] as Extract<HubRow, { type: "item" }>).tool : undefined;

  // one subscription for every row's key chip
  const keySig = useEngineValue((e) => TOOLS.map((t) => firstBinding(t, (id) => e.bindingsFor(id))?.join(" ") ?? "").join(SEP));
  const bindings = useMemo(() => {
    const parts = keySig.split(SEP);
    return new Map<ToolId, Binding | undefined>(TOOLS.map((t, i) => [t.id, parts[i] ? (parts[i].split(" ") as Binding) : undefined]));
  }, [keySig]);

  const live = useRef({ rows, index, current, filtering, filter, showDetail });
  live.current = { rows, index, current, filtering, filter, showDetail };

  const goTo = useCallback(
    (i: number) => {
      const row = live.current.rows[i];
      if (!row || row.type !== "item") return;
      live.current = { ...live.current, index: i, current: row.tool };
      // the cursor is the entry's `tool`: back / forward come back to it, hub.open changes it
      replaceView(pane, (v) => (v.kind === "hub" ? { kind: "hub", tool: row.tool.id } : v));
    },
    [pane],
  );

  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, showDetail, wide]);

  useEffect(() => {
    const closeFilter = () => {
      setFiltering(false);
      list.current?.focus();
    };
    return setHubController(pane, {
      move: (d) => goTo(stepRow(live.current.rows, live.current.index, d)),
      page: (dir) => {
        const h = list.current?.clientHeight ?? 200;
        const rowH = (list.current?.querySelector<HTMLElement>(".hub-row")?.offsetHeight ?? 20) || 20;
        goTo(stepRow(live.current.rows, live.current.index, dir * Math.max(1, Math.floor(h / rowH) - 1)));
      },
      top: () => goTo(stepRow(live.current.rows, -1, 0)),
      bottom: () => goTo(stepRow(live.current.rows, -1, live.current.rows.length)),
      current: () => live.current.current?.id,
      filterOpen: () => {
        beforeFilter.current = live.current.filter;
        setFiltering(true);
      },
      filterApply: closeFilter,
      filterCancel: () => {
        setFilter(beforeFilter.current);
        closeFilter();
      },
      isFiltering: () => live.current.filtering,
      hasFilter: () => live.current.filter !== "",
      filterClear: () => setFilter(""),
      toggleDetail: () => setDetail(!live.current.showDetail),
    });
  }, [pane, goTo]);

  // hints and `enabled` (Try's reason) depend on the cursor tool and the filter state
  useEffect(() => engine.invalidate(), [current, filtering, filter, showDetail]);

  const rowAt = (e: MouseEvent): number => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return el ? Number(el.dataset.index) : -1;
  };
  const focusMe = () => {
    if (focusedPane() !== pane) focusPane(pane);
  };
  const onClick = (e: MouseEvent) => {
    focusMe();
    goTo(rowAt(e));
  };
  // double-click tries (Enter); Ctrl+double-click beside
  const onDoubleClick = (e: MouseEvent) => {
    const i = rowAt(e);
    if (rows[i]?.type !== "item") return;
    goTo(i);
    runAction("nav.open", { pane, newPane: e.ctrlKey || e.metaKey ? (e.shiftKey ? "down" : "right") : null });
  };

  const total = TOOLS.length;
  const matched = rows.filter((r) => r.type === "item").length;
  const narrowDetail = showDetail && !wide;

  return (
    <div ref={root} className="hub" data-wide={wide || undefined} data-detail={showDetail || undefined} data-active={focused || undefined}>
      <PaneSlot name="count">{filter ? `${matched}/${total}` : total}</PaneSlot>
      {(filtering || filter) && (
        <PaneSlot name="chips">{filtering ? <FilterBar value={filter} onChange={setFilter} /> : <FilterChip mode="FILTER" value={filter} onRemove={() => setFilter("")} />}</PaneSlot>
      )}
      {!narrowDetail && (
        <div className="hub-side">
          {!filter && !filtering && <StartHere pane={pane} onOpen={() => !wide && setDetail(true)} />}
          <div ref={list} className="hub-list" tabIndex={-1} role="listbox" aria-label="Tools" onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={(e) => goTo(rowAt(e))}>
            {matched === 0 ? (
              <EmptyState compact>Nothing matches “{filter}”</EmptyState>
            ) : (
              rows.map((r, i) => <Row key={r.key} row={r} index={i} focus={i === index} binding={r.type === "item" ? bindings.get(r.key) : undefined} version={version} />)
            )}
          </div>
        </div>
      )}
      {showDetail && current && <Detail key={current.id} tool={toolById(current.id) ?? current} pane={pane} onClose={narrowDetail ? () => setDetail(false) : undefined} />}
    </div>
  );
}
