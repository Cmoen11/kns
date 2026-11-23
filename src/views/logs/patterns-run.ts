// Runs the patterns miner in the module worker (one shared worker, created on first use and kept
// while a patterns view exists). If the worker cannot start (a CSP that refuses it, a test
// environment without Worker), mining runs on the UI thread instead and says so.
import { mine, templateSet, type MineLine, type MineResult } from "./patterns";
import type { MineRequest, MineResponse } from "./patterns.worker";

interface Pending {
  resolve: (r: MineResult) => void;
  progress?: (done: number, total: number) => void;
  req: MineRequest;
}

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
let users = 0;

function fallback(p: Pending): void {
  const prev = p.req.previous ? templateSet(p.req.previous) : null;
  p.resolve(mine(p.req.lines, prev));
}

function start(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL("./patterns.worker.ts", import.meta.url), { type: "module" });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<MineResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.type === "progress") p.progress?.(e.data.done, e.data.total);
    else {
      pending.delete(e.data.id);
      p.resolve(e.data.result);
    }
  };
  worker.onerror = () => {
    // a worker that fails to load (CSP, missing chunk): everything in flight runs here instead
    broken = true;
    worker?.terminate();
    worker = null;
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) fallback(p);
  };
  return worker;
}

/** true once mining fell back to the UI thread */
export const minerOnMainThread = (): boolean => broken;

/** Mines `lines` (and the previous run's texts for NEW) off the UI thread when it can. */
export function runMine(lines: MineLine[], previous: string[] | null, progress?: (done: number, total: number) => void): Promise<MineResult> {
  return new Promise((resolve) => {
    const req: MineRequest = { id: nextId++, lines, previous };
    const p: Pending = { resolve, progress, req };
    const w = start();
    if (!w) {
      fallback(p);
      return;
    }
    pending.set(req.id, p);
    w.postMessage(req);
  });
}

/** A patterns view mounted / unmounted: the worker is terminated when the last one goes. */
export function holdMiner(): () => void {
  users++;
  return () => {
    users--;
    if (users > 0 || !worker) return;
    worker.terminate();
    worker = null;
    // nobody is waiting any more: the promises are dropped unresolved
    pending.clear();
  };
}
