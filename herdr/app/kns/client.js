// The connection to kns: loopback TCP (src-tauri/src/rpc/tcp.rs), newline-delimited JSON, the
// same protocol kns-tui speaks over the Unix socket.
//
//   → {"auth": token}                     (token and port from rpc-tcp.json, readable only by you)
//   ← {"hello": {app, version, protocol, methods}}
//   → {"id", "method", "params"}          ← {"id", "result"} | {"id", "error": {code, reason, message}}
//   ← {"sub": <request id>, "event"}      stream events (tables, logs, …) tagged with the request id
//   ← {"backend": BackendEvent}           what the kns window gets as kns://event
//
// One connection per view copy. It reconnects with backoff, starts kns in the background when
// nothing answers, and tells every open stream when it drops ({type: "disconnected"}) so the
// view can subscribe again once `state` is "ready".
import net from "net";
import { readTextFile, exec, checking } from "herdr";
import { Utf8Stream } from "./utf8.js";
import { knsTui, tcpInfo } from "./config.js";

export const PROTOCOL = 1;

export class Kns {
  /** `onChange(cx)` runs after each batch of messages that changed something, and on state changes. */
  constructor(onChange) {
    this.onChange = onChange;
    /** connecting | starting | ready | off (kns runs, TCP is off) | down (nothing answers) | closed */
    this.state = "connecting";
    this.error = null;
    this.hello = null;
    this.sock = null;
    this.next = 1;
    this.pending = new Map();
    this.streams = new Map();
    this.backend = new Set();
    this.closed = false;
    this.startTried = false;
    this.wake = null;
  }

  /** The connection loop, for the life of the view. */
  run(cx) {
    // `herdr-app check` runs init for real: no kns start, no sockets there
    if (checking()) return;
    cx.spawn(async (cx) => {
      let delay = 400;
      while (!this.closed) {
        const wasReady = await this.connectOnce(cx);
        if (this.closed) break;
        delay = wasReady ? 400 : Math.min(delay * 2, 8000);
        await this.sleep(cx, delay);
      }
    });
  }

  /** Waits `ms`, or until `retry()` asks for a new attempt. */
  async sleep(cx, ms) {
    let woken = false;
    this.wake = () => { woken = true; };
    for (let t = 0; t < ms && !woken && !this.closed; t += 100) await cx.sleep(100);
    this.wake = null;
  }

  /** Try again now (after "Start kns" or "Turn on"). */
  retry() {
    this.startTried = false;
    this.wake?.();
  }

  async readInfo() {
    const text = await readTextFile(tcpInfo()).catch(() => null);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async open(info) {
    if (!info?.port) return null;
    return net.connect("127.0.0.1", info.port).catch(() => null);
  }

  /** One connection, until it drops. Returns whether it got as far as the hello. */
  async connectOnce(cx) {
    let info = await this.readInfo();
    let sock = await this.open(info);
    if (!sock && !this.startTried) {
      // Nothing answers (kns not running, or a file left by a crash): start kns in the background.
      // kns-tui start returns once kns answers on its socket; TCP comes up with it when it is on.
      this.startTried = true;
      this.setState("starting", cx);
      const r = await exec(knsTui(), ["start"], { timeout: 30000 }).catch((e) => ({ code: -1, stderr: String(e) }));
      if (r.code !== 0) this.error = (r.stderr || r.stdout || "").trim() || `kns-tui start exited with ${r.code}`;
      for (let i = 0; i < 20 && !sock; i++) {
        info = await this.readInfo();
        sock = await this.open(info);
        if (!sock) await cx.sleep(150);
      }
    }
    if (!sock) {
      // kns answers its socket but wrote no TCP file: the endpoint is off
      const running = info === null ? await this.knsRunning() : false;
      this.setState(running ? "off" : "down", cx);
      return false;
    }

    this.sock = sock;
    let ready = false;
    try {
      await sock.write(JSON.stringify({ auth: info.token }) + "\n");
      const dec = new Utf8Stream();
      let buf = "";
      for (;;) {
        const chunk = await sock.read(262144);
        if (chunk === null) break;
        buf += dec.push(chunk);
        let changed = false, nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.hello) {
            this.hello = msg.hello;
            ready = true;
            this.startTried = false;
            this.error = msg.hello.protocol === PROTOCOL ? null : `kns speaks protocol ${msg.hello.protocol}, this mod ${PROTOCOL}: update kns or reinstall the mod`;
            this.state = "ready";
            changed = true;
          } else if (msg.error && msg.id === undefined) {
            this.error = msg.error.message ?? String(msg.error.reason);
            changed = true;
          } else if (this.dispatch(msg)) {
            changed = true;
          }
        }
        if (changed) this.onChange?.(cx);
      }
    } catch (e) {
      this.error = String(e);
    }
    this.sock = null;
    for (const [, p] of this.pending) p.reject({ reason: "Disconnected", message: "the connection to kns closed" });
    this.pending.clear();
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const s of streams) s({ type: "disconnected" });
    this.setState(this.closed ? "closed" : "connecting", cx);
    return ready;
  }

  async knsRunning() {
    const r = await exec(knsTui(), ["tcp", "status", "--json"], { timeout: 10000 }).catch(() => null);
    return r?.code === 0;
  }

  dispatch(msg) {
    if (msg.sub !== undefined) {
      const h = this.streams.get(msg.sub);
      if (h) h(msg.event);
      return Boolean(h);
    }
    if (msg.backend) {
      for (const f of this.backend) f(msg.backend);
      return this.backend.size > 0;
    }
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return true;
    }
    return false;
  }

  setState(state, cx) {
    if (this.state === state) return;
    this.state = state;
    this.onChange?.(cx);
  }

  get ready() {
    return this.state === "ready" && this.sock !== null;
  }

  send(id, method, params) {
    const sock = this.sock;
    return sock.write(JSON.stringify({ id, method, params }) + "\n");
  }

  /** One call. Rejects with kns's error object `{code, reason, message}`. */
  call(method, params = {}) {
    if (!this.ready) return Promise.reject({ reason: "NotConnected", message: "not connected to kns" });
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(id, method, params).catch((e) => {
        this.pending.delete(id);
        reject({ reason: "Disconnected", message: String(e) });
      });
    });
  }

  /**
   * Starts a stream (`subscribe_table`, `stream_logs`, `subscribe_ns_health`). Events go to
   * `onEvent`, ending with `{type: "disconnected"}` if the connection drops. Resolves with
   * `{ stop() }` once kns accepted it.
   */
  async stream(method, params, onEvent) {
    if (!this.ready) throw { reason: "NotConnected", message: "not connected to kns" };
    const id = this.next++;
    const sock = this.sock;
    this.streams.set(id, onEvent);
    let sid;
    try {
      sid = await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.send(id, method, params).catch((e) => {
          this.pending.delete(id);
          reject({ reason: "Disconnected", message: String(e) });
        });
      });
    } catch (e) {
      this.streams.delete(id);
      throw e;
    }
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.streams.delete(id);
        if (this.sock === sock) this.call("stop_stream", { id: sid }).catch(() => {});
      },
    };
  }

  onBackend(f) {
    this.backend.add(f);
    return () => this.backend.delete(f);
  }

  close() {
    this.closed = true;
    this.wake?.();
    try { this.sock?.close(); } catch {}
  }
}

/** kns's error object as one line. */
export function errText(e) {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e.message && e.reason && !String(e.message).startsWith(e.reason)) return `${e.reason}: ${e.message}`;
  return e.message ?? e.reason ?? String(e);
}
