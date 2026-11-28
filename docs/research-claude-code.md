# kns × Claude Code: integration research (2026-11-28)

Status: research and proposals only. Nothing here is built. Sources are the Claude Code docs at
code.claude.com/docs as read on 2026-11-28 (list at the end). Items marked `[unconfirmed]` were not
confirmed from the docs.

## Where kns stands today

- Local Streamable HTTP MCP server on `127.0.0.1:7099` (`src-tauri/src/mcp/`): 19 read tools, 13
  proposal tools, the resources `kns://selection` and `kns://bundle/<id>`, and the prompt `dev_config`.
- `kns-mcp` stdio shim and CLI (`src-tauri/src/bin/kns-mcp.rs`). `:mcp skill` writes
  `~/.claude/skills/kns/SKILL.md`.
- Agents wait for an approval by polling `wait_proposal`.
- Already installed and unused: xterm.js for pod shells. Herdr shows kns can live beside terminals.

Everything below builds on that layer. The approval model stays: nothing an agent does changes the
cluster without a dialog in the kns window.

## Claude Code surfaces and how kns could use them

| Surface | What it gives | kns use | Maturity |
|---|---|---|---|
| **Plugins and marketplaces** | Skills, slash commands, subagents, hooks, MCP servers and channels in one installable unit | Replace the loose skill with a `kns` plugin | GA |
| **Deep links** `claude-cli://open?cwd=…&repo=…&q=…` | Opens Claude Code in a terminal with a prompt filled in but not sent (q is at most 5,000 characters) | "Ask Claude about this" from any row | GA. The handler is registered only after the first interactive session |
| **Hooks** (`command`, `http`, `mcp_tool`, …) | Events for SessionStart, UserPromptSubmit, Notification (`permission_prompt`, `idle_prompt`, `agent_completed`), Stop, and more | Show "Claude is waiting or finished" in kns; inject the kns selection at session start | GA |
| **Channels** (`claude/channel`) | An MCP server pushes messages into a running interactive session, with optional permission relay | Push proposal outcomes, traps and crashes into the session; show Claude Code's own tool prompts in kns | Research preview. Custom channels need `--dangerously-load-development-channels` |
| **Interactive `claude` in a PTY** | The user's own Claude Code, their login and plan, inside a kns pane | A "Claude" pane beside the cluster views | No embedding guide `[unconfirmed details, Windows ConPTY]` |
| **Agent SDK** (TS/Python) | The agent loop as a library, `canUseTool` callback, in-process MCP, sessions, resume | A native assistant pane (the idea doc's A3) | GA. **Requires an API key, Bedrock, Vertex or Foundry.** Third-party products may not offer claude.ai login. No Rust SDK, so it needs a Node sidecar. Branding rules apply |
| **Headless `claude -p --output-format stream-json`** | One-shot or scripted runs, `--permission-prompt-tool`, `--json-schema` | `:explain` one-shot | GA. Whether kns may spawn the user's `claude` on their subscription is unaddressed: ask Anthropic, or use an API key |
| **MCP client features** | `@` mentions of resources, prompts as `/mcp__kns__…` commands, `list_changed`, elicitation, **MCP tasks** (≥ v2.1.304) | Better use of what the server already has; tasks instead of polling `wait_proposal` | GA |
| IDE protocol (`~/.claude/ide/*.lock`, ws MCP) | Selection and diagnostics from an editor | Not recommended: internal, no stability promise | — |
| Remote Control, Desktop session API | — | No public API to start or observe sessions | — |
| ACP (Zed adapter) | Editor protocol, Zed-maintained adapter | Not a fit | Beta, third party |
| MCP Apps (`ui://`) | Host-rendered UI | Whether Claude Code renders it inline is `[unconfirmed]`. Do not plan on it | — |

## Proposals, in recommended order

### C1. A kns plugin instead of a loose skill (S)

A `kns` Claude Code plugin, served from a small marketplace (a git repo, or written locally by kns):

- the current skill;
- an MCP server entry for `kns-mcp`, which reads the CLI token that kns already writes, so no token is
  pasted;
- slash commands that wrap prompts the agent already handles: `/kns:why`, `/kns:dev-config <workload>`,
  `/kns:selection`;
- a subagent `kns-investigator`, read tools only, for "why is X broken" without filling the main
  context;
- optional hooks (C4).

`:mcp setup` gets a third choice, "Install the Claude Code plugin". It writes the marketplace locally and
copies `/plugin marketplace add …` and `/plugin install kns@kns`. Updating kns rewrites the plugin, as
the Herdr mod is rewritten today. Plugin MCP tools are named `mcp__plugin_kns_kns__<tool>`, so check
that the skill text does not hard-code the tool prefix.

### C2. "Ask Claude" from kns: deep link with context (S)

A key (for example `leader a`) and a row-menu entry on any object open
`claude-cli://open?cwd=<dir>&q=<prompt>`:

- `q`: a short prompt that names the object and refers to it by resource:
  `Why is deploy/web in shop (context prod) failing? Read @kns:kns://bundle/<id> first.`
  kns builds the pack (A1) as now and keeps it as an MCP resource. The prompt carries a reference, not
  cluster text, so it stays far under 5,000 characters and no unredacted text leaves kns.
- `cwd`: the system's repository from the organisation catalog, or the directory of the `.kns.toml`
  that picked this context, else the user's chosen default. This puts Claude in the code of the broken
  service, which is the step from "why" to "fix".
- Nothing runs until the user presses Enter in Claude Code; Claude Code marks prompts that came from an
  external link.
- Fallback when the handler is not registered (Claude Code was never run interactively): copy the
  command `claude "<prompt>"` and say why.

### C3. A Claude pane inside kns: the interactive CLI in a local PTY (M)

This answers "open Claude Code inside kns" with the least new surface: kns runs the user's installed
`claude` in a pane, like a terminal app, with xterm.js (already a dependency) on a local PTY (new: for
example the `portable-pty` crate; Windows uses ConPTY).

- Started with `--mcp-config` pointing at kns (or with the plugin from C1), `--append-system-prompt`
  naming the current context and namespace, and `cwd` as in C2. The pane can follow a source pane, so
  "this" means that pane's cursor row; `kns://selection` already does this.
- It is the user's own Claude Code with their own login and plan. kns holds no Anthropic credentials
  and draws no chat UI.
- Proposals still open the normal kns dialog in the same window, so the pane and the approval sit next
  to each other.
- **Security caveat, to state plainly:** a CLI agent with Bash can run `kubectl` with the user's
  kubeconfig and bypass kns's proposal model entirely. kns can start it with deny rules
  (`--settings` with `permissions.deny: ["Bash(kubectl:*)", "Bash(helm:*)", …]`). That is a default,
  not a boundary. This is true of Claude Code in any terminal today; the pane must not suggest
  otherwise.
- `[unconfirmed]`: behaviour under ConPTY on Windows (the verified platform), resizing, and the
  `claude` TUI's key handling inside kns's keymap. The pane needs a "pass all keys" mode, with one
  escape chord back to kns.

### C4. Hooks: kns knows what Claude is doing (S)

Hooks shipped in the plugin (C1) call `kns-mcp`, which already has the token. Hooks of type `http` could
post to the loopback server directly, but whether they can send the bearer header is
`[unconfirmed]`.

- `Notification` (`permission_prompt`, `idle_prompt`, `agent_completed`) and `Stop`: a segment in the
  bottom row such as `claude: waiting`, and an OS notification when the kns window has focus and the
  terminal does not.
- `SessionStart`: `additionalContext` with `get_status` and the current selection, so a new session
  knows what the human is looking at without a tool call. It must stay small and be redacted like
  everything else.
- Hooks are skipped under `--bare`.

### C5. A kns channel: push into the session, permission relay into kns (M, preview)

`kns-mcp` already speaks stdio MCP, which is the transport channels need. Behind a setting, it declares
`experimental['claude/channel']` and pushes `notifications/claude/channel`:

- **Proposal outcomes:** "approved: forwards up on 9094, .env written to …" or "rejected: <reason>".
  This replaces the `wait_proposal` loop, and Claude can work while the human decides.
- **Events the user opted into:** a `:trap` that fired, a pod that started crash-looping in the view
  being discussed, a reconcile that finished.
- **"Send to Claude"** from kns: the pack or selection arrives in the running session as a message (by
  reference to the resource, as in C2).
- **Permission relay** (`claude/channel/permission`): Claude Code's own tool prompts ("allow Bash:
  go test ./…?") are shown and answered in kns. This only relays tool approvals; trust and MCP consent
  dialogs stay in the terminal.

Limits: research preview. A custom channel loads only with
`claude --dangerously-load-development-channels server:kns` (interactive only, with a confirmation
dialog), and only on claude.ai or Console login. Team and Enterprise organisations must enable channels.
Shipping it to others needs Anthropic's allowlist or an organisation's `allowedChannelPlugins`. Channel
text is cluster text: keep the `untrusted` framing that packs use. Note the MCP protocol-revision gotcha
in the channels reference (2026-07-28 runtime, `MCP_PROTOCOL_NEGOTIATION=legacy`).

**Cheaper GA alternative for the polling half:** MCP tasks (Claude Code ≥ v2.1.304). A proposal tool
returns `resultType: task` and Claude Code polls `tasks/get`, with no channel needed. Check that `rmcp`
3.11 supports tasks.

### C6. Small MCP improvements (S)

- Document `@kns:kns://selection` and bundles as `@` mentions in the skill and the `:mcp setup` text.
  Users can attach context without a tool call.
- Prompts already show up as `/mcp__kns__dev_config`. Add `why` and `pack` prompts.
- Send `notifications/resources/list_changed` when a new bundle is made. Interactive sessions refresh;
  `-p` and SDK sessions refresh tools only.
- Elicitation still must not be the approval step (ideas.md principle 3 stands).

### C7. Native assistant pane on the Agent SDK (L, later or never)

This is A3 with a real engine: a Node sidecar running `@anthropic-ai/claude-agent-sdk`, with
`canUseTool` mapped to kns dialogs, the kns tools as an in-process or stdio MCP server, and sessions
resumed per context. It gives the most control (kns draws the transcript, and every tool goes through
kns), but:

- an API key, Bedrock, Vertex or Foundry is required; a product may not offer claude.ai login;
- a Node runtime plus the native Claude Code binary must be bundled per platform `[unconfirmed]`;
- branding: it may not be called "Claude Code" or look like it ("… powered by Claude" is allowed);
- `canUseTool` does not reach subagents.

C3 and C5 give most of the value for the owner's own use without these costs. Revisit C7 only if kns is
meant for people who do not use Claude Code.

## Questions for Anthropic before shipping C3 or C7 widely

1. May a third-party app spawn the user's installed `claude` (interactive or `-p`) on the user's own
   claude.ai login? C3 is in effect a terminal, but the docs do not address it.
2. Channel allowlisting for a kns channel (C5).
3. Whether `http` hooks can carry an auth header.

## Sources

- Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview.md, …/user-input.md, …/mcp.md,
  …/sessions.md, …/streaming-vs-single-mode.md
- Headless: https://code.claude.com/docs/en/headless.md
- Channels: https://code.claude.com/docs/en/channels.md, https://code.claude.com/docs/en/channels-reference.md
- Plugins: https://code.claude.com/docs/en/plugins/overview.md (components, create, publish)
- Deep links: https://code.claude.com/docs/en/deep-links.md
- Hooks: https://code.claude.com/docs/en/hooks.md
- MCP in Claude Code: https://code.claude.com/docs/en/mcp.md
- IDE: https://code.claude.com/docs/en/vs-code.md
- Remote Control and Desktop: https://code.claude.com/docs/en/remote-control.md, https://code.claude.com/docs/en/desktop.md
- ACP: https://zed.dev/blog/claude-code-via-acp
