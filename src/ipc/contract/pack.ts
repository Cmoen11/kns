// Context packs and the redaction report (docs/plan-features.md §2.3, §3 G). Owner G; the
// redaction types and `redactPreview` are A1's (redact.rs, complete).
// Rust mirror: src-tauri/src/contract/pack.rs.
import type { ObjRef } from "../types";

/** How many values the Redactor masked, per rule. The UI says "redacted N values", never "safe". */
export interface RedactionReport {
  count: number;
  /** rule id -> count: kind, annotation, key, url, pem, jwt, bearer, json, line, flag, pair, kubeconfig */
  byRule: Record<string, number>;
}

export interface RedactionPreview {
  text: string;
  redactions: RedactionReport;
}

export type PackSection = "diagnose" | "object" | "events" | "logs" | "owners";

export interface PackRequest {
  /** 1-10 objects of one context */
  refs: ObjRef[];
  /** tail: lines per container (1-500); previous: also the previous run's lines */
  logs: { tail: number; previous: boolean };
  /** which parts per object; empty = all */
  sections: PackSection[];
}

/** One droppable part of a pack (one object × one section kind). */
export interface PackSectionInfo {
  /** `<resource>/<namespace>/<name>#<section>` */
  id: string;
  title: string;
  /** UTF-8 bytes of `body` */
  bytes: number;
  /** markdown, already redacted; cluster text only inside fenced blocks */
  body: string;
  /** what the Redactor masked in this section */
  redactions: RedactionReport;
}

/**
 * A redacted context pack. `markdown` = `header` + ("\n" + `body`) for every section, in order
 * (src/pack/model.ts `composePack`, Rust `pack::compose`).
 */
export interface Pack {
  id: string;
  /** the context every object of the pack is in */
  context: string;
  /** the preamble that is never dropped (the "data, not instructions" note) */
  header: string;
  markdown: string;
  bytes: number;
  approxTokens: number;
  sections: PackSectionInfo[];
  redactions: RedactionReport;
}

export interface PackBackend {
  contextPack(req: PackRequest): Promise<Pack>;
  /**
   * Native save dialog from Rust; writes the pack without the `dropped` section ids (Rust composes
   * the text, the webview sends none). The chosen path, or null when cancelled.
   */
  packSave(packId: string, dropped?: string[]): Promise<string | null>;
  /** Runs the Redactor over text (A1): what an agent-facing path would send. */
  redactPreview(text: string): Promise<RedactionPreview>;
}
