// The logs view (docs/ux.md §13.3). All line data lives in the pane's LogSession; this component
// renders one frame per session version and owns only the wiring: target resolution, the stream
// configuration, header labels, the search bar and the jump control.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  backend, engine, getSelection, paneIndex, PaneSlot, PaneToolbar, patchView, replaceView, setPaneStatus, subscribeSelection, paneContext, usePaneContext, type ViewProps,
} from "../../foundation";
import { getSettings } from "../../store/settings";
import type { LogSince, PaneId } from "../../types";
import { ActionHint, EmptyState, FilterChip, Hint, Icon, keepFocus, runAction, tip, type MenuEntry, type ToolbarItem } from "../../ui";
import { LogList } from "./LogList";
import { MODE_LABEL } from "./match";
import { SearchBar } from "./SearchBar";
import { filterLabel } from "./structured";
import { LogSession } from "./session";
import { acquireLogs, releaseLogs, type PaneLogs } from "./sessions";
import { StreamManager } from "./streams";
import { streamConfig, streamKey } from "./targets";
import "./logs.css";

function createLogs(pane: PaneId): PaneLogs {
  const session = new LogSession({ cap: getSettings().logBufferLines, onState: () => engine.invalidate() });
  // structured mode starts as the setting says; `J` toggles it per pane (display only)
  session.structured = getSettings().logsStructured;
  return { pane, session, streams: new StreamManager(session, { backend, report: (status) => setPaneStatus(pane, status) }) };
}

const SINCE: readonly LogSince[] = ["1m", "5m", "15m", "30m", "1h"];
/** The rows of the toolbar's time-range menu: the same actions the keys 0-6 run. */
function sinceMenu(current: LogSince): MenuEntry[] {
  const mark = (v: LogSince, text: string) => (v === current ? `${text} (current)` : text);
  return [
    { action: "logs.tail", label: mark("tail", "tail") },
    { action: "logs.head", label: mark("head", "head") },
    // the presets are one action with a digit per preset: each row shows its own key
    ...SINCE.map((v, i): MenuEntry => ({ action: "logs.since", args: [v], label: mark(v, `since ${v}`), binding: i })),
  ];
}

const RANGE_TEXT: Record<LogSince, string> = {
  tail: "", head: "", "1m": " in the last minute", "5m": " in the last 5 minutes", "15m": " in the last 15 minutes",
  "30m": " in the last 30 minutes", "1h": " in the last hour",
};

/**
 * What to say while there is no line to show, and the one action that helps (docs/ux.md §11.10:
 * a line with the one-key fix). The actions are the ones their keys run.
 */
function Empty({ s, connected, since, previous }: { s: LogSession; connected: boolean; since: LogSince; previous: boolean }) {
  if (!connected) return <>Not connected.</>;
  const { phase, message } = s.status;
  if (phase === "error") return <>{message ?? "Could not resolve the target."}</>;
  if (phase === "empty") return <>{message ?? "No pods match this target."}</>;
  if (phase !== "streaming") return <>syncing</>;
  if (s.ring.size > 0) {
    return (
      <>
        No lines match the filter.{" "}
        {s.fieldFilters.length > 0 ? <ActionHint action="filter.clear" label="remove the last field filter" /> : <ActionHint action="logs.filterLines" label="show all lines" />}
      </>
    );
  }
  if (previous) {
    return (
      <>
        {s.ended ? "The previous instance left no log lines." : "Reading the previous instance."}{" "}
        <ActionHint action="logs.previous" label="back to the running one" />
      </>
    );
  }
  const range = RANGE_TEXT[since];
  return (
    <>
      {s.ended ? `The stream ended without log lines${range}.` : `No log lines${range} yet.`}{" "}
      {range ? <ActionHint action="logs.tail" label="tail" /> : <ActionHint action="logs.previous" label="previous instance" />}
    </>
  );
}

export default function LogsView({ pane, view, visible }: ViewProps<"logs">) {
  const context = usePaneContext(pane) || null;
  const pl = useMemo(() => acquireLogs(pane, () => createLogs(pane)), [pane]);
  const s = pl.session;
  useSyncExternalStore(s.subscribe, s.getVersion);

  // the session outlives this component by 30s (§4.6); an effect, so StrictMode's remount re-acquires
  useEffect(() => {
    acquireLogs(pane, () => pl);
    engine.invalidate();
    return () => {
      releaseLogs(pane);
      engine.invalidate();
    };
  }, [pane, pl]);

  // a saved layout names "the selection of pane N": resolved once, then pinned to that object (§4.5)
  const sourcePane = view.target.by === "paneSelection" ? view.target.pane : null;
  useEffect(() => {
    if (!sourcePane) return;
    const resolve = () => {
      // §8.3: a source pane in another context names objects of another cluster: keep waiting
      if (paneContext(sourcePane) !== paneContext(pane)) return;
      const ref = getSelection(sourcePane).focused;
      if (!ref) return;
      replaceView(pane, (v) => (v.kind === "logs" && v.target.by === "paneSelection" ? { ...v, target: { by: "object", ref } } : v));
    };
    resolve();
    return subscribeSelection(sourcePane, resolve);
  }, [pane, sourcePane]);

  // The stream set depends only on target, container, since and previous: toggling wrap,
  // timestamps or the search edits the view without restarting anything.
  const cfg = useMemo(
    () => streamConfig(view, context),
    [context, view.target, view.container, view.since, view.previous], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const key = cfg ? streamKey(cfg) : null;
  useEffect(() => {
    pl.streams.configure(cfg);
  }, [pl, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const mode = view.match?.mode;
  const text = view.match?.text;
  useEffect(() => {
    s.setApplied(mode && text ? { mode, text } : null, view.filterLines);
  }, [s, mode, text, view.filterLines]);

  useEffect(() => s.setVisible(visible), [s, visible]);

  const clearSearch = () => patchView(pane, "logs", { match: undefined, filterLines: false });

  const count = s.hiding
    ? `${s.rowCount}/${s.ring.size}`
    : s.matcher?.highlights
      ? `${s.hitIndex()}/${s.hits.length}`
      : String(s.ring.size);

  // Mouse parity (docs/frontend.md §17): every button is the action its key runs. Follow and the
  // search are session state, so the toolbar is declared here and not with the view kind.
  const follow = s.follow;
  const structured = s.structured;
  const searching = s.searchOpen || view.match !== undefined;
  const toolbar = useMemo<ToolbarItem[]>(
    () => [
      // how the list behaves: the three a narrow pane keeps before "more"
      { action: "logs.autoscroll", icon: follow ? "pause" : "play", label: follow ? "pause (stop following)" : "follow" },
      { action: "logs.wrap", active: view.wrap },
      { action: "logs.timestamps", active: view.timestamps },
      { action: "logs.structured", active: structured, label: "structured (level, message, fields)" },
      "|",
      // what is read: the time range, the instance, the container
      { menu: sinceMenu(view.since), label: "Time range: tail, head or since", text: view.since, icon: "clock" },
      { action: "logs.previous", active: view.previous, label: "previous instance" },
      "logs.containerPicker",
      "|",
      { action: "filter.open", icon: "search", label: "search", active: searching },
      // kept (disabled) without a search to step through, so the buttons after them never move
      { action: "search.previous", icon: "up", keep: true },
      { action: "search.next", icon: "caret", keep: true },
      { action: "logs.filterLines", icon: "filter", label: "filter lines", active: view.filterLines, keep: true },
      "|",
      "logs.copy",
      { action: "logs.clear", icon: "clear" },
      "|",
      { action: "logs.patterns", label: "patterns (opens beside)" },
      { action: "logs.goToPod", icon: "open", label: "go to pod of line" },
      "hub.help",
    ],
    [follow, structured, searching, view.wrap, view.timestamps, view.since, view.previous, view.filterLines],
  );

  return (
    <div className="logs">
      <PaneSlot name="chips">
        {s.searchOpen ? (
          <SearchBar session={s} />
        ) : (
          <>
            {view.match && <FilterChip mode={MODE_LABEL[view.match.mode]} value={view.match.text} onRemove={clearSearch} />}
            {s.fieldFilters.map((f, i) => (
              <FilterChip key={filterLabel(f)} mode={f.kind === "level" ? "LEVEL" : "FIELD"} value={filterLabel(f)} onRemove={() => s.removeFieldFilter(i)} />
            ))}
          </>
        )}
      </PaneSlot>
      <PaneSlot name="labels">
        <span className="logs-labels">
          {/* Only what differs from a plain followed tail of every container. Wrap and timestamps
              show in the lines themselves and as pressed buttons; "follow", "all" and "tail" are
              the defaults and said nothing. */}
          {s.ended ? (
            <span className="logs-paused">ended</span>
          ) : (
            !s.follow && (
              <span className="logs-paused">
                paused{s.unread > 0 && <span className="num"> +{s.unread}</span>}
              </span>
            )
          )}
          {s.filtering && <span>filter</span>}
          {view.previous && <span>previous</span>}
          {view.container !== "*" && <span className="logs-plain t-ui">{view.container}</span>}
          {view.since !== "tail" && <span>{view.since}</span>}
          {s.skipped > 0 && <span className="num">buffer full +{s.skipped}</span>}
        </span>
      </PaneSlot>
      <PaneSlot name="count">{count}</PaneSlot>
      <PaneToolbar items={toolbar} label="Logs" />

      <LogList session={s} wrap={view.wrap} timestamps={view.timestamps} />

      {sourcePane ? (
        <div className="logs-empty">
          <EmptyState compact>waiting for a selection in pane {paneIndex(sourcePane) || "?"}</EmptyState>
        </div>
      ) : (
        s.rowCount === 0 && (
          <div className="logs-empty">
            <EmptyState compact>
              <Empty s={s} connected={context !== null} since={view.since} previous={view.previous} />
            </EmptyState>
          </div>
        )
      )}

      {!s.follow && !s.ended && s.rowCount > 0 && (
        <button type="button" className="logs-jump" tabIndex={-1} {...tip("Jump to the latest line and follow")} onMouseDown={keepFocus} onClick={() => runAction("logs.resumeFollow", { pane })}>
          <Icon name="follow" />
          <Hint action="logs.resumeFollow" label={s.unread > 0 ? `${s.unread} new · latest` : "latest"} />
        </button>
      )}
    </div>
  );
}
