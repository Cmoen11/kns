// Shell and attach view (docs/ux.md §13.4). The component is only the terminal's parking spot: the
// Terminal and its exec live in ./sessions and outlive this component.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LAYERS, paneIndex, PaneSlot, PaneToolbar, setPaneStatus, usePaneContext, useScopeLayer, useSelection, type ViewProps } from "../../foundation";
import { BarInput, EmptyState, keepFocus, Keys, runAction, usePaneId, type ToolbarItem } from "../../ui";
import { debounce } from "./bytes";
import { attach, blurSession, fitSession, focusSession } from "./sessions";
import { closeSearch, getQuery, getRuntime, isLiveStatus, setQuery, useSession, type SessionInfo } from "./state";
import "./shell.css";

const RESIZE_DEBOUNCE_MS = 60;

function SearchBar({ info }: { info: SessionInfo }) {
  useScopeLayer(LAYERS.searchInput);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <>
      <BarInput
        ref={input}
        className="term-search"
        label="SEARCH"
        aria-label="Search the scrollback"
        defaultValue={getQuery(info.id)}
        onChange={(e) => setQuery(info.id, e.target.value)}
        onBlur={() => closeSearch(info.id)}
        error={info.searchError}
      />
      {info.searchCount && <span className="t-ui term-search-count">{info.searchCount}</span>}
    </>
  );
}

function Reconnect({ label }: { label: string }) {
  const pane = usePaneId();
  return (
    <button type="button" className="k-hint t-hint term-reconnect" tabIndex={-1} onMouseDown={keepFocus} onClick={() => runAction("terminal.reconnect", { pane })}>
      <Keys action="terminal.reconnect" />
      {label}
    </button>
  );
}

/** A shell view with no session behind it: restored from a saved workspace, reopened, or never started. */
function NotConnected({ pane, view }: ViewProps<"shell" | "attach">) {
  const source = view.target.by === "paneSelection" ? view.target.pane : null;
  // §8.3: a source pane in another context never provides the target
  const sourceCtx = usePaneContext(source ?? pane);
  const ownCtx = usePaneContext(pane);
  const sel = useSelection(source ?? "");
  const waiting = source !== null && (sourceCtx !== ownCtx || sel.focused === null);
  if (waiting) return <EmptyState compact>waiting for a selection in pane {paneIndex(source) || "?"}</EmptyState>;
  return (
    <EmptyState compact>
      not connected <Reconnect label="connects" />
    </EmptyState>
  );
}

export default function ShellView(props: ViewProps<"shell" | "attach">) {
  const { pane, view, focused, visible } = props;
  const id = view.session;
  const info = useSession(id);
  const box = useRef<HTMLDivElement>(null);
  const has = info !== undefined;
  const live = has && isLiveStatus(info.status);
  const search = has && info.search;
  const copy = has && info.copy;

  // park the terminal in this pane; the cleanup only takes the element out again
  useLayoutEffect(() => {
    if (!id || !has || !box.current) return;
    return attach(id, box.current);
  }, [id, has]);

  // pane resize -> fit -> exec resize, debounced; nothing is measured while the pane is hidden
  useEffect(() => {
    const el = box.current;
    if (!id || !has || !el || !visible) return;
    const run = debounce(() => fitSession(id), RESIZE_DEBOUNCE_MS);
    const ro = new ResizeObserver(run);
    ro.observe(el);
    fitSession(id);
    return () => {
      ro.disconnect();
      run.cancel();
    };
  }, [id, has, visible]);

  // DOM focus: the terminal while live, the pane itself once the session is over (so NORMAL keys work)
  useEffect(() => {
    if (!id || !has || !focused || !visible || search) return;
    const paneEl = box.current?.closest<HTMLElement>(".pane") ?? null;
    if (!live) {
      blurSession(id);
      paneEl?.focus({ preventScroll: true });
      return;
    }
    focusSession(id);
    // a click on the pane header moves DOM focus to the pane; hand it back to the terminal
    const back = (e: FocusEvent) => {
      if (e.target === paneEl) focusSession(id);
    };
    paneEl?.addEventListener("focus", back);
    return () => paneEl?.removeEventListener("focus", back);
  }, [id, has, focused, visible, live, search]);

  // COPY is a capturing key layer: never leave it armed on a pane that lost focus or went away
  useEffect(() => {
    if (!id || !copy) return;
    if (!focused || !visible) getRuntime()?.leaveCopy(id);
    return () => getRuntime()?.leaveCopy(id);
  }, [id, copy, focused, visible]);
  useEffect(() => {
    if (id && search && (!focused || !visible)) closeSearch(id);
  }, [id, search, focused, visible]);
  useEffect(
    () => () => {
      if (id) closeSearch(id);
    },
    [id],
  );

  const status = info?.status;
  const message = info?.message;
  useEffect(() => {
    const watch = status === "live" ? "live" : status === "connecting" ? "syncing" : status === "error" ? "error" : null;
    setPaneStatus(pane, { watch, message: watch === "error" ? message : undefined });
  }, [pane, status, message]);
  useEffect(() => () => setPaneStatus(pane, { watch: null }), [pane]);

  // Mouse parity (docs/frontend.md §17). The registry decides what shows: reconnect only without a
  // live session, copy mode / search / end only with one. In COPY the mode button leaves it.
  const toolbar = useMemo<ToolbarItem[]>(
    () => [
      { action: "terminal.reconnect", icon: "refresh" },
      copy ? { action: "copy.leave", icon: "select", label: "leave copy mode", active: true } : { action: "terminal.copyMode", icon: "select" },
      { action: "terminal.copy", label: "copy the selection" },
      "terminal.paste",
      "terminal.search",
      "|",
      { action: "terminal.container", icon: "container", label: "open another container" },
      { action: "terminal.end", icon: "stop" },
      "|",
      "hub.help",
    ],
    [copy],
  );

  if (!has) {
    return (
      <>
        <PaneToolbar items={toolbar} label="Shell" />
        <NotConnected {...props} />
      </>
    );
  }

  return (
    <div className="term-view">
      <PaneToolbar items={toolbar} label="Shell" />
      {search && (
        <PaneSlot name="chips">
          <SearchBar info={info} />
        </PaneSlot>
      )}
      <PaneSlot name="labels">
        <span>{copy ? "COPY" : live ? (view.kind === "attach" ? "ATTACH" : "TERM") : "ENDED"}</span>
      </PaneSlot>
      <div className="term-box" ref={box} />
      {!live && (
        <div className="term-ended t-ui" role="status">
          <span className="term-ended-text truncate">
            {info.status === "error" ? "session failed" : "session ended"}
            {info.message ? `: ${info.message}` : ""}
          </span>
          <Reconnect label="reconnects" />
        </div>
      )}
    </div>
  );
}
