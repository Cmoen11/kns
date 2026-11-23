// Resolves a logs target to pods and containers and keeps one backend stream per (pod, container)
// (docs/ux.md §13.3). A stream that fails or ends is reattached on its own with a backoff and a
// gap marker, so one pod going away never restarts the others. Workload and selector targets are
// re-resolved as pods come and go.
import type { Backend, BackendError, Gvr, LogEvent, PodRef, Unsubscribe } from "../../ipc/types";
import type { PaneWatch } from "../../store/pane-status";
import { ERROR, GAP, NOTE, type LineIn, type LogSession, type Phase } from "./session";
import { expandSources, MAX_PODS, settingsKey, sinceQuery, sourceKey, streamKey, targetName, unionPods, type SourceSpec, type StreamConfig } from "./targets";
import { compareStamps, parseStamp, sinceSecondsFrom, type Stamp } from "./time";

const POLL_MS = 5000;
const RESOLVE_RETRY_MS = 5000;
const SELECTOR_DEBOUNCE_MS = 300;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;
/** a stream with no error for this long counts as connected (the API has no "connected" event) */
const SETTLE_MS = 1500;
/** an ended stream that produced nothing this many times in a row is finished (init containers) */
const EMPTY_ENDS = 3;

const CORE_PODS: Gvr = { group: "", version: "v1", resource: "pods" };

/** What the manager needs from the app. Injected, so the reattach logic runs in tests without a cluster. */
export interface StreamDeps {
  backend: Pick<Backend, "podsFor" | "streamLogs" | "subscribeTable">;
  /** the pane header's watch glyph */
  report(status: { watch: PaneWatch | null; message?: string }): void;
}

type StreamState = "connecting" | "live" | "ended" | "error" | "done";

interface Stream {
  spec: SourceSpec;
  key: string;
  src: number;
  state: StreamState;
  /** identity of the current attach; events of an older one are ignored */
  token: object | null;
  unsub: Unsubscribe | null;
  /** newest timestamp seen */
  last: Stamp | null;
  /** lines at or before this are repeats from the reattach overlap */
  dedupe: Stamp | null;
  needsGap: boolean;
  gotLine: boolean;
  attempts: number;
  emptyEnds: number;
  lastError?: string;
  timer?: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
}

const message = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as BackendError).message) : String(e));

export class StreamManager {
  /** pods of the last resolve (container picker, "all containers") */
  pods: PodRef[] = [];

  private cfg: StreamConfig | null = null;
  private key: string | null = null;
  private attached = false;
  /** bumped whenever the resolver or the stream set is torn down; stale callbacks compare it */
  private gen = 0;
  private streams = new Map<string, Stream>();
  /** newest timestamp per source, kept across a detach so a remount reattaches without repeats */
  private lastSeen = new Map<string, Stamp>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private poll?: ReturnType<typeof setInterval>;
  private tableUnsub?: Unsubscribe;
  private notedSkipped = 0;

  constructor(private readonly session: LogSession, private readonly deps: StreamDeps) {}

  /** Starts, restarts or keeps the streams for a view. null = nothing to stream yet. */
  configure(cfg: StreamConfig | null): void {
    const key = cfg ? streamKey(cfg) : null;
    if (key === this.key && this.attached) return;
    const prev = this.cfg;
    const wasAttached = this.attached;
    const remount = !wasAttached && key !== null && key === this.key;
    this.stopAll();
    this.cfg = cfg;
    this.key = key;
    this.attached = true;
    if (!cfg) {
      this.setPhase("idle");
      return;
    }
    const hasLines = this.session.ring.size > 0;
    if (remount) {
      // the view left and came back within the buffer's lifetime (§4.6)
      if (hasLines) this.session.note(GAP, "reattached");
    } else if (wasAttached && prev && hasLines && settingsKey(prev) === settingsKey(cfg)) {
      // a follow link moved the target: keep the buffer, show the seam (§4.5)
      this.lastSeen.clear();
      this.session.note(GAP, `target changed to ${targetName(cfg.target)}`);
    } else {
      this.lastSeen.clear();
      this.session.reset();
    }
    this.session.headMode = cfg.since === "head";
    if (this.session.headMode && !hasLines) this.session.follow = false;
    this.resolve();
  }

  /** The view unmounted: stop everything, keep what is needed to reattach. */
  detach(): void {
    this.stopAll();
    this.attached = false;
    this.deps.report({ watch: null });
  }

  /** view.refresh: drop the buffer and start over. */
  restart(): void {
    if (!this.cfg) return;
    this.stopAll();
    this.lastSeen.clear();
    this.session.reset();
    this.session.headMode = this.cfg.since === "head";
    if (this.session.headMode) this.session.follow = false;
    this.resolve();
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private stopAll(): void {
    this.gen++;
    for (const st of this.streams.values()) this.close(st, true);
    this.streams.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.tableUnsub?.();
    this.tableUnsub = undefined;
    this.notedSkipped = 0;
  }

  private close(st: Stream, remember: boolean): void {
    st.token = null;
    st.unsub?.();
    st.unsub = null;
    if (st.timer) clearTimeout(st.timer);
    if (st.settle) clearTimeout(st.settle);
    if (remember && st.last) this.lastSeen.set(st.key, st.last);
  }

  // ── resolve ───────────────────────────────────────────────────────────────

  private resolve(): void {
    const cfg = this.cfg;
    if (!cfg) return;
    const gen = this.gen;
    this.setPhase("resolving");
    if (cfg.target.by === "object") {
      const { gvr, namespace, name } = cfg.target.ref;
      const ref = { context: cfg.context, gvr, namespace, name };
      const single = ref.gvr.resource === "pods";
      const run = () => {
        this.deps.backend.podsFor(ref).then(
          (pods) => {
            if (gen === this.gen) this.apply(pods);
          },
          (e) => {
            if (gen !== this.gen) return;
            this.resolveFailed(message(e));
            if (single) this.later(run, RESOLVE_RETRY_MS);
          },
        );
      };
      run();
      // a workload's pods come and go: re-resolve and diff
      if (!single) this.poll = setInterval(run, POLL_MS);
      return;
    }
    if (cfg.target.by === "objects") {
      // merged logs: every marked object resolved on its own, the pods unioned (§12.4: at most 8)
      const refs = cfg.target.refs.map((r) => ({ context: cfg.context, gvr: r.gvr, namespace: r.namespace, name: r.name }));
      const podsOnly = refs.every((r) => r.gvr.group === "" && r.gvr.resource === "pods");
      let lastFailure: string | undefined;
      const run = () => {
        Promise.allSettled(refs.map((r) => this.deps.backend.podsFor(r))).then((results) => {
          if (gen !== this.gen) return;
          const ok: PodRef[][] = [];
          let failure: string | undefined;
          for (const res of results) {
            if (res.status === "fulfilled") ok.push(res.value);
            else failure ??= message(res.reason);
          }
          if (ok.length === 0) {
            this.resolveFailed(failure ?? "could not resolve the objects");
            if (podsOnly) this.later(run, RESOLVE_RETRY_MS);
            return;
          }
          if (failure && failure !== lastFailure) this.session.note(NOTE, `${results.length - ok.length} of ${results.length} objects: ${failure}`);
          lastFailure = failure;
          this.apply(unionPods(ok));
        });
      };
      run();
      if (!podsOnly) this.poll = setInterval(run, POLL_MS);
      return;
    }
    const { namespace, selector } = cfg.target;
    const names = new Map<string, string>();
    const known = new Map<string, PodRef>();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      pending = undefined;
      const wanted = [...new Set(names.values())];
      const missing = wanted.filter((n) => !known.has(n));
      Promise.all(
        missing.map((name) =>
          this.deps.backend.podsFor({ context: cfg.context, gvr: CORE_PODS, namespace, name }).then(
            (pods) => {
              const pod = pods.find((p) => p.name === name) ?? pods[0];
              if (pod) known.set(name, pod);
            },
            () => {},
          ),
        ),
      ).then(() => {
        if (gen !== this.gen) return;
        this.apply(wanted.flatMap((n) => known.get(n) ?? []));
      });
    };
    const schedule = () => {
      if (pending === undefined) pending = this.later(sync, SELECTOR_DEBOUNCE_MS);
    };
    this.tableUnsub = this.deps.backend.subscribeTable(
      { context: cfg.context, gvr: CORE_PODS, namespace: namespace === "*" ? undefined : namespace, labelSelector: selector },
      (e) => {
        if (gen !== this.gen) return;
        if (e.type === "snapshot") {
          names.clear();
          for (const r of e.rows) names.set(r.uid, r.name);
        } else if (e.type === "delta") {
          for (const r of e.upserts) names.set(r.uid, r.name);
          for (const uid of e.deletes) names.delete(uid);
        } else {
          if (e.state === "error" || e.state === "forbidden") this.resolveFailed(e.message ?? e.state);
          return;
        }
        schedule();
      },
    );
  }

  private resolveFailed(text: string): void {
    // a failed re-resolve keeps the running streams
    if (this.streams.size === 0) this.setPhase("error", text);
  }

  private apply(pods: PodRef[]): void {
    const cfg = this.cfg;
    if (!cfg) return;
    this.pods = pods;
    const { sources, skippedPods } = expandSources(pods, cfg.container);
    const want = new Map(sources.map((s) => [sourceKey(s), s]));
    const present = new Set(pods.map((p) => `${p.namespace}/${p.name}`));
    for (const [key, st] of [...this.streams]) {
      if (want.has(key)) continue;
      this.close(st, false);
      this.streams.delete(key);
      this.lastSeen.delete(key);
      if (!cfg.previous && !present.has(`${st.spec.namespace}/${st.spec.pod}`)) this.session.note(NOTE, `${st.spec.pod}/${st.spec.container} is gone`);
    }
    for (const [key, spec] of want) {
      if (this.streams.has(key)) continue;
      const st: Stream = {
        spec, key,
        src: this.session.addSource(spec.namespace, spec.pod, spec.container),
        state: "connecting", token: null, unsub: null,
        last: this.lastSeen.get(key) ?? null, dedupe: null,
        needsGap: false, gotLine: false, attempts: 0, emptyEnds: 0,
      };
      this.streams.set(key, st);
      this.open(st);
    }
    if (skippedPods > 0 && skippedPods !== this.notedSkipped) {
      this.notedSkipped = skippedPods;
      this.session.note(NOTE, `showing ${MAX_PODS} of ${pods.length} pods`);
    }
    if (sources.length > 0) this.setPhase("streaming");
    else this.setPhase("empty", pods.length === 0 ? "No pods match this target." : `No container named "${cfg.container}".`);
  }

  // ── streams ───────────────────────────────────────────────────────────────

  private open(st: Stream): void {
    const cfg = this.cfg;
    if (!cfg) return;
    const follow = !cfg.previous;
    // a reattach asks for everything after the last line seen; the overlap is deduplicated
    const range = st.last && follow ? { sinceSeconds: sinceSecondsFrom(st.last.ms, Date.now()) } : sinceQuery(cfg.since);
    st.dedupe = st.last;
    st.state = "connecting";
    st.gotLine = false;
    const token = {};
    st.token = token;
    st.settle = this.later(() => {
      if (st.token === token && st.state === "connecting") {
        st.state = "live";
        this.report();
      }
    }, SETTLE_MS);
    st.unsub = this.deps.backend.streamLogs(
      {
        context: cfg.context,
        targets: [{ namespace: st.spec.namespace, pod: st.spec.pod, container: st.spec.container }],
        follow,
        previous: cfg.previous || undefined,
        // always parsed: structured mode (J), level chips and patterns read it; J never restarts a stream
        parse: true,
        ...range,
      },
      (e) => {
        if (st.token === token) this.onEvent(st, e, follow);
      },
    );
    this.report();
  }

  private onEvent(st: Stream, e: LogEvent, follow: boolean): void {
    const label = `${st.spec.pod}/${st.spec.container}`;
    if (e.type === "lines") {
      const out: LineIn[] = [];
      for (const l of e.lines) {
        const stamp = parseStamp(l.ts);
        if (stamp) {
          if (st.dedupe && compareStamps(stamp, st.dedupe) <= 0) continue;
          if (!st.last || compareStamps(stamp, st.last) > 0) st.last = stamp;
        }
        out.push({ ms: stamp ? stamp.ms : Date.now(), text: l.text, level: l.level, msg: l.msg, fields: l.fields });
      }
      if (out.length === 0) return;
      if (st.needsGap) {
        st.needsGap = false;
        this.session.note(GAP, `${label} reattached`);
      }
      st.gotLine = true;
      st.attempts = 0;
      st.emptyEnds = 0;
      st.lastError = undefined;
      if (st.state !== "live") {
        st.state = "live";
        this.report();
      }
      this.session.enqueue(st.src, out);
      return;
    }
    st.token = null;
    st.unsub?.();
    st.unsub = null;
    if (e.type === "end") {
      // a one-shot read, or an init container that ran to completion: finished, nothing to say
      if (!follow || st.spec.kind === "init") st.state = "done";
      else {
        if (st.gotLine) this.session.note(NOTE, `${label}: stream ended`);
        else st.emptyEnds++;
        if (st.emptyEnds >= EMPTY_ENDS) st.state = "done";
        else {
          st.state = "ended";
          st.needsGap = st.last !== null;
          this.retry(st);
        }
      }
    } else {
      st.state = "error";
      if (e.message !== st.lastError) {
        st.lastError = e.message;
        this.session.note(ERROR, `${label}: ${e.message}`);
      }
      // previous logs are a one-shot read: an error there is final
      if (follow) {
        st.needsGap = st.last !== null;
        this.retry(st);
      }
    }
    this.report();
  }

  private retry(st: Stream): void {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** st.attempts);
    st.attempts++;
    st.timer = this.later(() => {
      if (this.streams.get(st.key) === st) this.open(st);
    }, delay);
  }

  // ── status ────────────────────────────────────────────────────────────────

  private phase: Phase = "idle";
  private phaseMessage?: string;

  private setPhase(phase: Phase, text?: string): void {
    this.phase = phase;
    this.phaseMessage = text;
    this.session.setStatus({ phase, message: text });
    this.report();
  }

  /** The pane header's watch glyph, from the states of all streams. */
  private report(): void {
    let watch: PaneWatch | null = null;
    let text = this.phaseMessage;
    let ended = false;
    if (this.phase === "resolving") watch = "syncing";
    else if (this.phase === "error") watch = "error";
    else if (this.phase === "streaming") {
      let live = 0, connecting = 0, broken = 0, failed: string | undefined;
      for (const st of this.streams.values()) {
        if (st.state === "live") live++;
        else if (st.state === "connecting") connecting++;
        else if (st.state === "ended" || st.state === "error") {
          broken++;
          if (st.state === "error") failed = st.lastError;
        }
      }
      if (broken > 0) {
        watch = live > 0 || failed === undefined ? "reconnecting" : "error";
        text = failed;
      } else if (live > 0) watch = "live";
      else if (connecting > 0) watch = "syncing";
      // nothing live, connecting or retrying: every stream ran to its end
      else ended = this.streams.size > 0;
    }
    this.session.setEnded(ended);
    this.deps.report({ watch, message: text });
  }
}
