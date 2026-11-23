// The size line and redaction legend of the `text` view (docs/plan-features.md §3 G): bytes,
// ~tokens and "redacted N values (…)" over the kept sections. Pure; tested in text-model.test.ts.
import type { RedactionReport } from "../../ipc/types";

/** Sum of reports (the kept sections' counts). */
export function sumReports(reports: readonly (RedactionReport | undefined)[]): RedactionReport {
  const byRule: Record<string, number> = {};
  let count = 0;
  for (const r of reports) {
    if (!r) continue;
    count += r.count;
    for (const [k, v] of Object.entries(r.byRule)) byRule[k] = (byRule[k] ?? 0) + v;
  }
  return { count, byRule };
}

const encoder = new TextEncoder();
export const utf8Bytes = (s: string): number => encoder.encode(s).length;
/** Same estimate as Rust `pack::approx_tokens`: a token per 4 characters. */
export const approxTokens = (s: string): number => Math.ceil([...s].length / 4);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${n < 10 * 1024 ? (n / 1024).toFixed(1) : Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `~${n} tokens`;
  return `~${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k tokens`;
}

/** "redacted 7 values (4 key, 2 url, 1 jwt)"; never "safe". */
export function redactionText(r: RedactionReport): string {
  if (r.count === 0) return "redacted 0 values";
  const parts = Object.entries(r.byRule)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, n]) => `${n} ${rule}`);
  return `redacted ${r.count} value${r.count === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** "14 KB · ~3.6k tokens · redacted 7 values (4 key, 2 url, 1 jwt)" for `text`. */
export function sizeLine(text: string, redactions: RedactionReport): string {
  return `${formatBytes(utf8Bytes(text))} · ${formatTokens(approxTokens(text))} · ${redactionText(redactions)}`;
}

/** What each rule id masks, for the legend. */
export const RULE_HELP: Readonly<Record<string, string>> = {
  kind: "a whole Secret or token-like object",
  annotation: "the last-applied annotation",
  key: "a value under a secret-looking key",
  url: "a password in a URL",
  pem: "a PEM key or certificate block",
  jwt: "a JWT-shaped token",
  bearer: "a Bearer / Basic credential",
  json: "a JSON secret field",
  flag: "a secret command-line flag",
  line: "a `key: value` / `key=value` line",
  pair: "a `key=value` pair inside a line",
  kubeconfig: "a kubeconfig credential",
  query: "a secret URL query parameter",
};
