// The terminals (lazy chunk: xterm lives here and nowhere else). One Terminal per exec session id,
// kept outside React: a view only parks the terminal's host element in its pane and takes it out
// again, so sessions survive remounts, pane moves, zoom and fold. Disposal is decided by ./state
// (the id left every pane history).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend, engine, flash, LAYERS, toasts } from "../../foundation";
import type { BackendError, ExecEvent, ExecSession } from "../../ipc/types";
import { getSettings, settingsStore } from "../../store/settings";
import { createBatcher, decodeBase64, type Batcher } from "./bytes";
import { getSession, isLiveStatus, patchSession, setRuntime, type TermRuntime } from "./state";
import { copyRange, findMatches, moveCopyCursor, previousMatch, scrollTargetFor, type CopyCursor, type CopyMove } from "./term-search";
import { lineHeightFor, monoFamily, MONO_SIZE, readTheme } from "./theme";

interface Rt {
  id: string;
  term: Terminal;
  fit: FitAddon;
  /** the element xterm renders into; moved between pane bodies, never recreated */
  host: HTMLDivElement;
  opened: boolean;
  exec: ExecSession | null;
  /** exec generation: events of an older exec are ignored after a restart */
  gen: number;
  /** the generation that already ended */
  doneGen: number;
  /** keystrokes typed before the exec handle arrived */
  input: string[];
  batcher: Batcher;
  /** where the last search hit was, so Enter walks upwards */
  matchAt: { line: number; col: number } | null;
  matchQuery: string;
}

const runtimes = new Map<string, Rt>();

// ── appearance: one snapshot for all terminals, refreshed when <html> changes ──

let look = { theme: readTheme(), family: monoFamily(), lineHeight: 1 };
look.lineHeight = lineHeightFor(look.family);

function applyLook(rt: Rt, remeasure = false): void {
  const o = rt.term.options;
  o.theme = look.theme;
  // assigning a different family first forces xterm to measure the cell again (font just loaded)
  if (remeasure && o.fontFamily === look.family) o.fontFamily = "monospace";
  o.fontFamily = look.family;
  o.lineHeight = look.lineHeight;
  fitRt(rt);
}

function refreshLook(remeasure = false): void {
  const family = monoFamily();
  look = { theme: readTheme(), family, lineHeight: lineHeightFor(family) };
  for (const rt of runtimes.values()) applyLook(rt, remeasure);
}

function loadFont(): void {
  if (!document.fonts?.load) return;
  document.fonts.load(`${MONO_SIZE}px ${look.family}`).then(
    () => refreshLook(true),
    () => undefined,
  );
}

new MutationObserver(() => {
  refreshLook();
  loadFont();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-tema", "data-modus", "data-mono"] });
loadFont();

settingsStore.subscribe((s, p) => {
  if (s.termScrollback === p.termScrollback) return;
  for (const rt of runtimes.values()) rt.term.options.scrollback = s.termScrollback;
});

// ── exec ──

const errorText = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "message" in e) return String((e as BackendError).message);
  return String(e);
};

function scheduleFlush(flush: () => void): () => void {
  // a hidden window gets no animation frames; the timer keeps output moving there
  const raf = requestAnimationFrame(flush);
  const timer = setTimeout(flush, 250);
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

function setReadOnly(rt: Rt, on: boolean): void {
  rt.term.options.disableStdin = on;
  // a read-only textarea is not an "editable target", so single keys work again after the session ends
  if (rt.term.textarea) rt.term.textarea.readOnly = on;
}

function finish(rt: Rt, gen: number, status: "ended" | "error", message?: string): void {
  if (rt.gen !== gen || rt.doneGen === gen) return;
  rt.doneGen = gen;
  try {
    rt.exec?.close();
  } catch {
    /* already gone */
  }
  rt.exec = null;
  rt.input = [];
  if (copy?.id === rt.id) leaveCopy();
  rt.batcher.hold(false);
  rt.batcher.flush();
  setReadOnly(rt, true);
  patchSession(rt.id, { status, message, search: false, searchError: undefined, searchCount: undefined });
}

function startExec(rt: Rt): void {
  const info = getSession(rt.id);
  if (!info) return;
  const gen = ++rt.gen;
  rt.exec = null;
  rt.input = [];
  setReadOnly(rt, false);
  patchSession(rt.id, { status: "connecting", message: undefined });
  const cols = rt.term.cols;
  const rows = rt.term.rows;
  const onEvent = (e: ExecEvent) => {
    // events can arrive before the handle does, and after a restart
    if (rt.gen !== gen || rt.doneGen === gen) return;
    if (e.type === "data") rt.batcher.push(decodeBase64(e.b64));
    else if (e.type === "exit") finish(rt, gen, "ended", e.message ?? (e.code === undefined ? undefined : `exit ${e.code}`));
    else finish(rt, gen, "error", e.message);
  };
  backend
    .exec(
      {
        context: info.context, namespace: info.namespace, pod: info.pod, container: info.container,
        command: [], tty: true, attach: info.kind === "attach" ? true : undefined, cols, rows,
      },
      onEvent,
    )
    .then(
      (session) => {
        if (rt.gen !== gen || rt.doneGen === gen || !runtimes.has(rt.id)) {
          session.close();
          return;
        }
        rt.exec = session;
        patchSession(rt.id, { status: "live" });
        if (rt.term.cols !== cols || rt.term.rows !== rows) session.resize(rt.term.cols, rt.term.rows);
        for (const d of rt.input) session.write(d);
        rt.input = [];
      },
      (err: unknown) => finish(rt, gen, "error", errorText(err)),
    );
}

function send(rt: Rt, data: string): void {
  const info = getSession(rt.id);
  if (!info || !isLiveStatus(info.status)) return;
  if (rt.exec) rt.exec.write(data);
  else rt.input.push(data);
}

/** The terminal of a known session, created (and its exec started) on first use. */
function ensure(id: string): Rt | null {
  const have = runtimes.get(id);
  if (have) return have;
  if (!getSession(id)) return null;
  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({
    cols: 80,
    rows: 24,
    fontFamily: look.family,
    fontSize: MONO_SIZE,
    fontWeight: "400",
    // 500 is not shipped for the mono fonts; bold stays regular weight rather than a faux bold
    fontWeightBold: "400",
    lineHeight: look.lineHeight,
    scrollback: getSettings().termScrollback,
    macOptionIsMeta: false,
    theme: look.theme,
    cursorBlink: false,
    drawBoldTextInBrightColors: true,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const rt: Rt = {
    id, term, fit, host, opened: false, exec: null, gen: 0, doneGen: 0, input: [],
    batcher: createBatcher({ write: (bytes) => term.write(bytes), schedule: scheduleFlush }),
    matchAt: null, matchQuery: "",
  };
  term.onData((d) => send(rt, d));
  term.onBinary((d) => send(rt, d));
  term.onResize(({ cols, rows }) => rt.exec?.resize(cols, rows));
  // terminal.copy is enabled by a selection: buttons and hints must hear about it
  term.onSelectionChange(() => engine.invalidate());
  runtimes.set(id, rt);
  startExec(rt);
  return rt;
}

// ── DOM: park / unpark, size, focus ──

function fitRt(rt: Rt): void {
  const el = rt.host;
  if (!rt.opened || !el.isConnected || el.clientWidth < 16 || el.clientHeight < 16) return;
  const d = rt.fit.proposeDimensions();
  if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
  const cols = Math.max(2, d.cols);
  const rows = Math.max(1, d.rows);
  if (cols !== rt.term.cols || rows !== rt.term.rows) rt.term.resize(cols, rows);
}

/** Puts the session's terminal into `parent`. Returns the function that takes it out again (not a dispose). */
export function attach(id: string, parent: HTMLElement): () => void {
  const rt = ensure(id);
  if (!rt) return () => undefined;
  parent.appendChild(rt.host);
  if (!rt.opened) {
    rt.term.open(rt.host);
    rt.opened = true;
    const info = getSession(id);
    setReadOnly(rt, !info || !isLiveStatus(info.status));
  } else {
    rt.term.refresh(0, rt.term.rows - 1);
  }
  fitRt(rt);
  return () => {
    if (rt.host.parentElement === parent) parent.removeChild(rt.host);
  };
}

/** Fits the terminal to its pane and tells the exec. Call only while the pane is visible. */
export function fitSession(id: string): void {
  const rt = runtimes.get(id);
  if (rt) fitRt(rt);
}

export function focusSession(id: string): void {
  runtimes.get(id)?.term.focus();
}
export function blurSession(id: string): void {
  runtimes.get(id)?.term.blur();
}

// ── clipboard, scrollback ──

function writeClipboard(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => flash(what),
    () => toasts.error("Copy failed: the clipboard is not available"),
  );
}

// ── COPY mode (§13.4): a line cursor over the scrollback; the shell gets no keys, output is held ──

let copy: { id: string; cur: CopyCursor; pop: () => void } | null = null;

function renderCopy(): void {
  const rt = copy && runtimes.get(copy.id);
  if (!copy || !rt) return;
  const { start, end } = copyRange(copy.cur);
  rt.term.selectLines(start, end);
  const top = scrollTargetFor(copy.cur.line, rt.term.buffer.active.viewportY, rt.term.rows);
  if (top !== null) rt.term.scrollToLine(top);
}

function leaveCopy(id?: string): void {
  if (!copy || (id !== undefined && copy.id !== id)) return;
  const { id: was, pop } = copy;
  copy = null;
  pop();
  patchSession(was, { copy: false });
  const rt = runtimes.get(was);
  if (!rt) return;
  rt.term.clearSelection();
  rt.batcher.hold(false);
  rt.term.scrollToBottom();}

// ── the API ./state and the actions use ──

const api: TermRuntime = {
  dispose(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    if (copy?.id === id) leaveCopy();
    runtimes.delete(id);
    rt.gen++;
    try {
      rt.exec?.close();
    } catch {
      /* already gone */
    }
    rt.exec = null;
    rt.batcher.clear();
    rt.term.dispose();
    rt.host.remove();
  },
  end(id, message) {
    const rt = runtimes.get(id);
    if (rt) finish(rt, rt.gen, "ended", message);
    else patchSession(id, { status: "ended", message });
  },
  restart(id) {
    const rt = ensure(id);
    const info = getSession(id);
    if (!rt || !info || isLiveStatus(info.status)) return;
    rt.batcher.flush();
    rt.term.write("\r\n\x1b[0m\x1b[2m--- reconnecting ---\x1b[0m\r\n");
    startExec(rt);
  },
  hasSelection: (id) => runtimes.get(id)?.term.hasSelection() ?? false,
  copySelection(id) {
    const text = runtimes.get(id)?.term.getSelection();
    if (text) writeClipboard(text, "copied selection");
  },
  paste(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    navigator.clipboard.readText().then(
      (text) => {
        if (text && runtimes.get(id) === rt) rt.term.paste(text);
      },
      () => toasts.error("Paste failed: the clipboard is not readable"),
    );
  },
  scrollPages(id, pages) {
    runtimes.get(id)?.term.scrollPages(pages);
  },
  enterCopy(id) {
    const rt = runtimes.get(id);
    if (!rt || copy) return;
    const buf = rt.term.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    const line = scrollTargetFor(cursor, buf.viewportY, rt.term.rows) === null ? cursor : Math.min(buf.length - 1, buf.viewportY + rt.term.rows - 1);
    rt.batcher.flush();
    rt.batcher.hold(true);
    copy = { id, cur: { line, anchor: null }, pop: engine.pushScope(LAYERS.copy) };
    patchSession(id, { copy: true });
    renderCopy();
  },
  leaveCopy,
  copyMove(move: CopyMove) {
    const rt = copy && runtimes.get(copy.id);
    if (!copy || !rt) return;
    copy.cur = moveCopyCursor(copy.cur, move, rt.term.buffer.active.length);
    renderCopy();
  },
  copySelect() {
    if (!copy) return;
    copy.cur = { ...copy.cur, anchor: copy.cur.anchor === null ? copy.cur.line : null };
    renderCopy();
  },
  copyYank() {
    const rt = copy && runtimes.get(copy.id);
    if (!copy || !rt) return;
    const { start, end } = copyRange(copy.cur);
    const text = rt.term.getSelection();
    leaveCopy();
    if (text) writeClipboard(text, end > start ? `copied ${end - start + 1} lines` : "copied line");
  },
  search(id, query) {
    const rt = runtimes.get(id);
    if (!rt) return;
    if (query === "") {
      patchSession(id, { searchError: undefined, searchCount: undefined });
      return;
    }
    const buf = rt.term.buffer.active;
    const matches = findMatches((i) => buf.getLine(i)?.translateToString(true), buf.length, query);
    const inCopy = copy?.id === id;
    if (rt.matchQuery !== query) rt.matchAt = null;
    rt.matchQuery = query;
    const from = rt.matchAt ?? (inCopy && copy ? { line: copy.cur.line, col: 0 } : { line: buf.length, col: 0 });
    const i = previousMatch(matches, from);
    if (i < 0) {
      patchSession(id, { searchError: "no match", searchCount: undefined });
      return;
    }
    const m = matches[i];
    rt.matchAt = { line: m.line, col: m.col };
    if (inCopy && copy) {
      copy.cur = { ...copy.cur, line: m.line };
      renderCopy();
    } else {
      rt.term.select(m.col, m.line, m.length);
      rt.term.scrollToLine(Math.max(0, m.line - Math.floor(rt.term.rows / 2)));
    }
    patchSession(id, { searchError: undefined, searchCount: `${i + 1}/${matches.length}` });
  },
  searchClosed(id) {
    const rt = runtimes.get(id);
    if (rt) rt.matchAt = null;
  },
};

setRuntime(api);

export { api as terminals };
