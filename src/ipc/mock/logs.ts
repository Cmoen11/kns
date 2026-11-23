// Mock of LogsBackend (contract/logs.ts). Owner E. Lines come from a few templates with variable
// parts (so the patterns view has something to group): plain, ANSI level words with logfmt tails,
// JSON and logfmt. With `parse` each line carries the level / msg / fields the Rust parser
// (src-tauri/src/logparse.rs) gives for that shape. The previous container run (`previous: true`)
// lacks the kafka error template, so "new since the previous run" marks exactly that one.
// One-shot reads (no follow, or previous) end with an `end` event, as the real stream does.
import type { LogLevel, LogLine, LogQuery, LogsBackend } from "../types";

type Parts = Pick<LogLine, "text" | "level" | "msg" | "fields">;
type Template = (r: () => number) => Parts;

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const hexOf = (r: () => number, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(r, 0, 15)]).join("");

/** the template only the current run has (see NEW in the patterns view) */
export const NEW_TEMPLATE = 3;

export const TEMPLATES: readonly Template[] = [
  (r) => ({ text: `GET /healthz 200 ${int(r, 1, 9)}ms` }),
  (r) => {
    const id = int(r, 1, 400), dur = int(r, 3, 90);
    return {
      text: `\u001b[32mINFO\u001b[0m  request completed path=/api/items/${id} status=200 dur=${dur}ms`,
      level: "info", msg: "request completed", fields: [["path", `/api/items/${id}`], ["status", "200"], ["dur", `${dur}ms`]],
    };
  },
  (r) => {
    const ms = int(r, 500, 2000);
    return { text: `\u001b[33mWARN\u001b[0m  slow query took ${ms}ms table=orders`, level: "warn", msg: `slow query took ${ms}ms`, fields: [["table", "orders"]] };
  },
  () => ({ text: "\u001b[31mERROR\u001b[0m failed to connect to kafka:9092: connection refused", level: "error", msg: "failed to connect to kafka:9092: connection refused" }),
  (r) => {
    const lag = int(r, 0, 40);
    return {
      text: `{"level":"info","msg":"consumer lag","topic":"orders.created","lag":${lag}}`,
      level: "info", msg: "consumer lag", fields: [["topic", "orders.created"], ["lag", String(lag)]],
    };
  },
  (r) => {
    const id = int(r, 1, 99);
    return { text: `level=debug msg="cache hit" key=user:${id} hit=true`, level: "debug", msg: "cache hit", fields: [["key", `user:${id}`], ["hit", "true"]] };
  },
  (r) => {
    const trace = hexOf(r, 16);
    return {
      text: `{"level":"error","msg":"request failed","traceId":"${trace}","status":500,"path":"/api/checkout"}`,
      level: "error", msg: "request failed", fields: [["traceId", trace], ["status", "500"], ["path", "/api/checkout"]],
    };
  },
  (r) => {
    const id = int(r, 1, 99);
    return { text: `DEBUG cache hit key=user:${id}`, level: "debug" as LogLevel, msg: "cache hit", fields: [["key", `user:${id}`]] };
  },
];

/** A few example texts (tests, docs). */
export const LOG_LINES = TEMPLATES.map((t) => t(() => 0.5).text);

/** Deterministic per stream: the same query gives the same lines. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 7;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Spacing of the backlog lines: a tail of 500 covers about two minutes. */
const STEP_MS = 250;

export const logsMock: LogsBackend = {
  streamLogs: (query: LogQuery, onEvent) => {
    const previous = query.previous === true;
    const r = rng(hash(`${query.targets.map((t) => `${t.pod}/${t.container}`).join(",")}${previous ? "|p" : ""}`));
    const templates = previous ? TEMPLATES.filter((_, i) => i !== NEW_TEMPLATE) : TEMPLATES;
    const line = (i: number, ms: number): LogLine => {
      const t = query.targets[i % query.targets.length];
      const p = templates[Math.floor(r() * templates.length)](r);
      const out: LogLine = { ts: new Date(ms).toISOString(), pod: t.pod, container: t.container, text: p.text };
      if (query.parse && p.level) {
        out.level = p.level;
        if (p.msg !== undefined) out.msg = p.msg;
        if (p.fields?.length) out.fields = p.fields;
      }
      return out;
    };
    const n = Math.min(query.tailLines ?? 200, 2000);
    // the previous run ended a while ago
    const end = Date.now() - (previous ? 10 * 60_000 : 0);
    const first = setTimeout(() => {
      onEvent({ type: "lines", lines: Array.from({ length: n }, (_, i) => line(i, end - (n - i) * STEP_MS)) });
      if (!query.follow || previous) for (const t of query.targets) onEvent({ type: "end", pod: t.pod, container: t.container });
    }, 60);
    let i = 0;
    const timer = query.follow && !previous ? setInterval(() => onEvent({ type: "lines", lines: [line(i++, Date.now())] }), 400) : undefined;
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  },
};
