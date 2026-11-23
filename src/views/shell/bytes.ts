// Exec output plumbing (pure): base64 frames -> bytes -> one terminal write per animation frame.

/** Decodes one `ExecEvent.data` frame. Bad input gives an empty array, never a throw. */
export function decodeBase64(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array(0);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let size = total ?? 0;
  if (total === undefined) for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface BatcherOptions {
  /** receives everything queued since the last flush, as one array */
  write: (bytes: Uint8Array) => void;
  /** asks for one flush "soon" (animation frame + timer fallback); returns the canceller */
  schedule: (flush: () => void) => () => void;
  /** queued bytes that force a flush without waiting for the schedule (default 1 MiB) */
  maxPending?: number;
  /** queued bytes that force a flush even while held (default 4 MiB) */
  maxHeld?: number;
}

export interface Batcher {
  push(chunk: Uint8Array): void;
  /** writes what is queued now (ignores hold) */
  flush(): void;
  /** while held nothing is written (COPY mode keeps the screen still); releasing flushes */
  hold(on: boolean): void;
  readonly pending: number;
  /** drops what is queued and cancels the scheduled flush */
  clear(): void;
}

/** Collects output frames and writes them once per scheduled tick, however many frames arrived. */
export function createBatcher(opts: BatcherOptions): Batcher {
  const maxPending = opts.maxPending ?? 1 << 20;
  const maxHeld = opts.maxHeld ?? 4 << 20;
  let chunks: Uint8Array[] = [];
  let size = 0;
  let cancel: (() => void) | null = null;
  let held = false;

  function flush() {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (size === 0) return;
    const bytes = concatBytes(chunks, size);
    chunks = [];
    size = 0;
    opts.write(bytes);
  }

  return {
    push(chunk) {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      size += chunk.length;
      if (held) {
        if (size >= maxHeld) flush();
        return;
      }
      if (size >= maxPending) flush();
      else
        cancel ??= opts.schedule(() => {
          cancel = null;
          flush();
        });
    },
    flush,
    hold(on) {
      if (held === on) return;
      held = on;
      if (on) {
        if (cancel) {
          cancel();
          cancel = null;
        }
      } else flush();
    },
    get pending() {
      return size;
    },
    clear() {
      if (cancel) cancel();
      cancel = null;
      chunks = [];
      size = 0;
    },
  };
}

/** Trailing debounce; `cancel` drops a pending call. */
export function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
  run.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return run;
}
