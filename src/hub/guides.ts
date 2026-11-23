// Getting-started paths of the Tools hub (docs/plan-features.md §3 I, final pass): "local
// development against a service" and "connect an agent", as ordered steps a new user follows from
// the hub. They live on existing entries (env, mcp), so no new ToolId; each step names its keys and
// command and has a "Do it" button that runs the step's action through the same Try resolution
// (current object, the pane that holds it). Steps that would change something only open their
// action's own dialog. docs/tools.md#start-local-dev and #start-agent hold the same text.
import type { ActionId } from "../actions";
import type { ToolEntry, ToolId, TryNeeds } from "./catalog";

/** A live check that a step is done, computed by the view from stores (src/hub/GuideSteps). */
export type GuideCheck = "connected" | "forward" | "envOpen" | "devSetUp" | "mcpOn" | "client";

export interface GuideStep {
  title: string;
  /** one or two sentences; `code` spans allowed */
  body: string;
  /** the button: runs `action` like a Try (needs decides where) */
  run?: { action: ActionId; needs: TryNeeds; label: string; writes?: boolean };
  /** a `:` line that does the same, typed where `run` would run */
  command?: string;
  done?: GuideCheck;
  optional?: boolean;
}

export interface Guide {
  id: "start-local-dev" | "start-agent";
  /** the hub entry that shows it */
  tool: ToolId;
  title: string;
  summary: string;
  steps: readonly GuideStep[];
}

export const GUIDES: readonly Guide[] = [
  {
    id: "start-local-dev",
    tool: "env",
    title: "Local development against a service",
    summary: "Reach a service from your machine, or run its workload locally with its env",
    steps: [
      {
        title: "Find the service",
        body: "Connect to the context and open the Services or Deployments of its namespace: `Ctrl+K` and type `svc` or `deploy`, or `:svc <namespace>`. Put the cursor on the row.",
        run: { action: "palette.open", needs: "none", label: "Open the palette" },
        done: "connected",
      },
      {
        title: "Just talk to it: forward a port",
        body: "`F` on the Service forwards a local port to a ready pod; it follows restarts and rollouts on the same port. In `:pf`, `C` copies a connection string (postgres://, redis://, …) and `o` opens HTTP in the browser.",
        run: { action: "pf.start", needs: "row", label: "Forward the cursor row" },
        done: "forward",
      },
      {
        title: "HTTP by name (optional)",
        body: "`:dev names on` routes `http://<name>.<namespace>.localhost:7080` to your forwards, so you need not remember ports.",
        command: ":dev names on",
        optional: true,
      },
      {
        title: "Run it locally: read its env",
        body: "`E` on the workload (Deployment, StatefulSet, pod …) lists its env, where each value comes from and what it talks to, with in-cluster addresses rewritten to forwards and warnings for consumer groups and migrations.",
        run: { action: "dev.fromWorkload", needs: "workload", label: "Env of the cursor workload" },
        command: ":env",
        done: "envOpen",
      },
      {
        title: "Save it as a dev set",
        body: "In the env view, `Space` leaves keys out and `s` saves the forwards and the env config as a dev set you start and stop in one go.",
        run: { action: "env.saveSet", needs: "envPane", label: "Save as dev set", writes: true },
      },
      {
        title: "Start the set and export the env",
        body: "`leader e` opens the dev sets: `Enter` starts one, `Mod+Shift+Backspace` stops it. `Mod+S` in the env view writes a `.env` file; secret values stay out unless you tick them.",
        run: { action: "dev.picker", needs: "none", label: "Open the dev sets" },
        command: ":dev up <name>",
        done: "devSetUp",
      },
    ],
  },
  {
    id: "start-agent",
    tool: "mcp",
    title: "Connect an agent",
    summary: "Let Claude Code read the cluster through kns and ask you before it changes anything",
    steps: [
      {
        title: "Turn on the server and get the command",
        body: "Connect an agent… (or `:mcp setup`) turns on the local MCP server, names the agent, sets what it may do in this context (`read`, or `propose` to ask for changes) and copies the command that registers kns with the agent. The token is shown nowhere else.",
        run: { action: "agents.connect", needs: "none", label: "Connect an agent…", writes: true },
        command: ":mcp setup",
        done: "mcpOn",
      },
      {
        title: "Register kns with the agent",
        body: "Paste the copied command in a terminal (for Claude Code it runs `claude mcp add … kns http://127.0.0.1:7099/mcp …`), then run `/mcp` in Claude Code: kns shows as connected and the agent appears under `:agents`.",
        done: "client",
      },
      {
        title: "Ask about what you look at",
        body: "Put the cursor on an object and ask the agent, for example \"why is this pod broken?\": it reads your selection (`get_selection`) and kns's findings (`explain_why`), redacted.",
      },
      {
        title: "Review what it asks to do",
        body: "Forwards, dev sets, env exports and changes arrive as requests: `leader y` (or the `agent 1` item in the bottom row) opens one dialog with everything that would happen. Approve, reject with a reason, or `Esc` for later.",
        run: { action: "proposals.next", needs: "none", label: "Review a request" },
        command: ":proposals",
      },
      {
        title: "See and revoke",
        body: "`:agents` lists clients, policies and every call; `x` revokes an agent (its open requests end, its forwards stop), `X` stops the server.",
        run: { action: "agents.open", needs: "none", label: "Open the agents view" },
        command: ":agents",
      },
    ],
  },
];

export const guideForTool = (id: ToolId): Guide | undefined => GUIDES.find((g) => g.tool === id);
export const guideById = (id: string): Guide | undefined => GUIDES.find((g) => g.id === id);

/** A step as a tool entry, so its button resolves and runs like "Try it" (src/hub/model resolveTry). */
export function stepAsTool(tool: ToolEntry, step: GuideStep): ToolEntry | null {
  if (!step.run) return null;
  return { ...tool, try: { action: step.run.action, needs: step.run.needs, writes: step.run.writes, label: step.run.label }, built: () => true };
}
