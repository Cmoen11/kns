#!/usr/bin/env node
// Retakes the README screenshots in docs/img/ from the browser dev build (mock backend, no cluster).
//
//   node scripts/screenshots.mjs                 # all shots, dark mode, 2x
//   node scripts/screenshots.mjs why env         # only these
//   node scripts/screenshots.mjs --light --scale 1 --out /tmp/shots
//
// Uses a running `pnpm dev` on http://localhost:1420 if there is one, otherwise starts it and
// stops it again at the end. Needs Playwright with Chromium (`npm i -D playwright` and
// `npx playwright install chromium` if it is not installed globally).
//
// The mock's pod statuses churn over time, so a shot that needs a specific state (a crash-looping
// pod for `why`) waits for it. Each scene drives the app only through keys and visible text, the
// way a person would, so a changed default key shows up here as a failing scene.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright not found: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

// ---- arguments ----
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const out = path.resolve(flag("--out") ?? path.join(root, "docs/img"));
const scale = Number(flag("--scale") ?? 2);
const url = flag("--url") ?? "http://localhost:1420/";
const light = args.includes("--light");
const only = args.filter((a) => !a.startsWith("--"));

// the size the README images have always had (CSS pixels; the app applies its own 1.2x zoom)
const VIEWPORT = { width: 1576, height: 868 };

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(u) {
  try {
    return (await fetch(u)).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await up(url)) return null;
  const port = new URL(url).port || "1420";
  console.log(`starting pnpm dev on ${port} …`);
  const child = spawn("pnpm", ["dev", "--port", port, "--strictPort"], { cwd: root, stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) {
    if (await up(url)) return child;
    await sleep(500);
  }
  process.kill(-child.pid);
  throw new Error(`pnpm dev did not answer on ${url}`);
}

/** Key helpers bound to one page. `Mod` is Ctrl: the browser build runs as on Windows. */
function driver(page) {
  const d = {
    page,
    wait: (ms = 500) => page.waitForTimeout(ms),
    key: async (k, ms = 300) => {
      await page.keyboard.press(k);
      await page.waitForTimeout(ms);
    },
    /** `:` command bar, e.g. cmd("pods shop"). */
    cmd: async (s) => {
      await d.key(":", 200);
      await page.keyboard.type(s);
      await d.wait(200);
      await d.key("Enter", 800);
    },
    /** leader (`Mod+.`) followed by one key. */
    leader: async (k) => {
      await d.key("Control+.", 150);
      await d.key(k, 600);
    },
    /** Moves the table cursor to the first row containing this text (clicks its name cell). */
    row: async (text) => {
      const row = page.locator('[role="row"]', { hasText: text }).first();
      const box = await row.boundingBox();
      if (!box) throw new Error(`no row with "${text}"`);
      await row.click({ position: { x: Math.min(60, box.width / 4), y: box.height / 2 } });
      await d.wait(300);
    },
    /** Polls until `text` is visible (mock data that churns); throws after `ms`. */
    until: async (text, ms = 30000) => {
      await page.getByText(text).first().waitFor({ state: "visible", timeout: ms });
    },
    /** Moves the mouse out of the way so no hover bar or tooltip lands in the shot. */
    park: () => page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2),
  };
  return d;
}

// ---- scenes: file name → steps; captions live in README.md ----
const scenes = {
  // Split panes: pods, deployments and services side by side; staging open as a second context tab
  panes: async (d) => {
    await d.cmd("ctx staging");
    await d.key("Control+Tab", 800); // back to default: staging stays open, warm
    await d.cmd("pods shop");
    await d.leader("r");
    await d.cmd("deploy shop");
    await d.leader("d");
    await d.cmd("svc payments");
    await d.wait(1500);
  },

  // :why on a crash-looping pod, opened beside the pod list
  why: async (d) => {
    await d.cmd("pods shop");
    await d.until("CrashLoopBackOff", 60000);
    await d.row("CrashLoopBackOff");
    await d.key("+", 200); // open the next view beside this one
    await d.key("Shift+W", 2500);
  },

  // Env view of a Deployment: secrets masked, addresses rewritten to local forwards, side effects
  env: async (d) => {
    await d.cmd("deploy shop");
    await d.row("orders");
    await d.key("+", 200);
    await d.key("Shift+E", 2500);
  },

  // An agent asks to start a dev set; the request waits for approval in kns
  "agent-approval": async (d) => {
    await d.cmd("deploy shop");
    await d.cmd("mcp demo");
    await d.until("agent 1", 30000);
    // let the demo agent's toasts time out so they do not cover the dialog
    await d.wait(8000);
    await d.leader("y");
    await d.wait(1500);
  },

  // Tools hub: every tool with its keys, live status and "Try it"
  "tools-hub": async (d) => {
    await d.cmd("pods shop");
    await d.cmd("tools");
    await d.wait(1500);
  },
};

// ---- run ----
const names = only.length ? only : Object.keys(scenes);
const unknown = names.filter((n) => !scenes[n]);
if (unknown.length) {
  console.error(`unknown shot(s): ${unknown.join(", ")}; known: ${Object.keys(scenes).join(", ")}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const server = await ensureServer();
const browser = await chromium.launch();
let failed = 0;
try {
  for (const name of names) {
    // a fresh context per shot: empty localStorage, so the default workspace and settings
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: scale, colorScheme: light ? "light" : "dark" });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.warn(`  [${name}] page error: ${e.message}`));
    try {
      await page.goto(url);
      await page.waitForTimeout(2000);
      const d = driver(page);
      await scenes[name](d);
      await d.park();
      await d.wait(400);
      const file = path.join(out, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`ok   ${path.relative(root, file)}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}: ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(out, `${name}.failed.png`) }).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}
process.exit(failed ? 1 : 0);
