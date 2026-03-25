# Collaborating Agents: An Extension for the Pi Coding Agent

This is an extension for Pi for spawning subagents, and for them to reserve files and send/receive messages to one another.

All sessions auto-register immediately when they start; so when a new Pi session is started, it is already part of the collaborating agents system.

## Quick Start

Install this extension and its included skill using **either** npm (recommended) or the git URL.

### Option 1: Install from npm

```bash
pi install npm:@baochunli/pi-collaborating-agents
```

### Option 2: Install from git URL

```bash
pi install https://github.com/baochunli/pi-collaborating-agents
```

Use the command:

```bash
pi config
```

To confirm that the `collaborating-agents` extension and the `collaborating-agents-system` skill have been activated. Use `Esc` to leave the configuration session.

To uninstall this extension:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
```

or (if you installed using git URL):

```bash
pi remove https://github.com/baochunli/pi-collaborating-agents
```

## Opening the _Agents and Messages_ Overlay with the `/agents` Command

The `/agents` slash command opens an integrated _agents and messages_ overlay with four tabs:

  - `Agents` tab contains a list of all active and recently completed agents, and it allows the user to switch to the selected active session and tracks the target session in real time.
  - `Feed` tab shows recent message activity across agents.
  - `File reservations` tab shows active reservation patterns and which agent currently owns each one.
  - `Chat` tab provides a shared chat stream and input box for `@all` broadcasts and direct `@AgentName` messages.

Newly-started agents show up immediately; if their transcript file is not persisted yet they are marked `session pending`. Completed subagents remain visible in the `Agents` tab as `completed` until the next time an orchestrator agent spawns new subagents, which clears prior historical completed-subagent entries from that list.

Messaging input is available in the `Chat` tab. Use `@AgentName message` for direct messages or `@all message` for broadcast. Prefix the message body with `!!` to mark it urgent.

Examples:

- Direct: `@BlueFalcon Status update: parsing complete.`
- Direct + urgent: `@BlueFalcon !! Need your decision now.`
- Broadcast: `@all Wave 2 complete.`
- Broadcast + urgent: `@all !! Stop edits in src/server/ until migration finishes.`

## Spawning a subagent via the `/subagent` command

The user can spawn a single subagent manually using the `/subagent [type] <task>` slash command. By default it runs as a background child process, but you can switch it to a visible cmux pane with `subagentLaunchMode`. When no type is specified, the extension resolves the default subagent type (`worker`/`default`) using the normal override order described below. In slash-command usage, the first token is treated as a type only if it matches a known subagent type; otherwise the full input is treated as the task. All agents use readable two-word callsigns (for example: `SilverHarbor`). An immediate `Spawning subagent ...` status message with runtime name and prompt will be shown immediately.

If you want spawned agents to appear in a visible cmux pane instead of only running as background child processes, set `subagentLaunchMode` to `"cmux-pane"` in your collaborating-agents config. That mode uses `cmux new-split` plus `cmux send`, then launches a real `pi` session directly in the new pane so you see Pi's own terminal output there while the orchestrator still collects the final subagent response automatically. The extension now applies a two-phase layout strategy: it first chooses a balanced split target from the current managed pane tree, then runs a best-effort reconciliation pass with `cmux list-panes`, `cmux list-pane-surfaces`, `cmux move-surface`, and `cmux reorder-surface` so existing managed surfaces are moved back into the intended panes if the workspace drifted. This mode must be invoked from a Pi session that is already running inside a cmux terminal surface; otherwise subagent launch fails.

### Usage

```bash
# Use default subagent type
/subagent "Implement user authentication"

# Use a specific subagent type
/subagent scout "Find all TypeScript files in the project"
/subagent documenter "Write API documentation for the auth module"
/subagent reviewer "Check for security issues in src/auth/"
```

The parent (orchestrator agent) sessions automatically collect final subagent outputs on completion (single and parallel), without requiring subagents to send a separate final direct message summary. All direct subagent → parent status messages are optional, but are useful for blockers/questions only. Inbox delivery uses Pi's message routing: normal messages are queued with `followUp`, and `urgent: true` messages interrupt immediately with `steer`.

## Autonomous Tool API for Agents

The following tools are provided for agents to call autonomously. Users should use the slash commands above.

### The `agent_message` Tool

The extension provides a dedicated **`agent_message`** tool for autonomous agent-to-agent messaging.

Actions:

- `status` – current identity, focus mode, peer count, and your reservation count
- `list` – list active agents (includes reservation counts when present)
- `send` – send direct message (`to` + `message`, optional `replyTo`, optional `urgent`)
- `broadcast` – send to all active peers (`message`, optional `urgent`)
- `feed` – recent global message log (`limit` optional)
- `thread` – direct-message thread with one peer (`to`, `limit` optional)
- `reserve` – reserve files/directories for write/edit coordination (`paths`, optional `reason`)
- `release` – release reservations (`paths` optional; omit to release all)

Reservation patterns are validated. Empty patterns are rejected, and broad patterns (for example `.`, `/`, `./`, `../`, or a top-level directory like `src/`) are allowed but return warnings.

Examples:

```ts
agent_message({ action: "list" })
agent_message({ action: "send", to: "BlueFalcon", message: "I finished parsing" })
agent_message({ action: "send", to: "BlueFalcon", message: "Following up on your last note", replyTo: "msg-123" })
agent_message({ action: "send", to: "BlueFalcon", message: "Need your decision now", urgent: true })
agent_message({ action: "broadcast", message: "Wave 2 complete" })
agent_message({ action: "thread", to: "BlueFalcon", limit: 10 })
agent_message({ action: "reserve", paths: ["src/server/", "src/routes/account.tsx"], reason: "auth refactor" })
agent_message({ action: "release", paths: ["src/server/"] })
agent_message({ action: "release" })
```

### The `subagent` Tool

The extension also provides a lightweight **`subagent`** tool for agents to call when they need to spawn subagents.

Modes:

- Single: `{ task }` or `{ type, task }`
- Parallel: `{ tasks: [{ task, cwd? }, ...] }` or `{ type, tasks: [...] }`

Parameters:

- `task` (string, optional) – Task prompt for single-mode
- `tasks` (array, optional) – Array of task objects for parallel-mode
- `type` (string, optional) – Subagent type to use (e.g., "scout", "documenter", "reviewer")
- `cwd` (string, optional) – Working directory for spawned subagents
- `sessionControl` (boolean, optional) – Spawn with `--session-control` (default: true)

Examples:

```ts
// Default subagent type
subagent({ task: "Implement auth tags and report back via agent_message" })

// With specific subagent type
subagent({ 
  type: "scout",
  task: "Find all TypeScript files in the project" 
})

// Parallel subagents
subagent({
  tasks: [
    { task: "Implement backend pieces" },
    { task: "Implement frontend pieces" }
  ]
})

// Parallel with specific type (applies to all tasks)
subagent({
  type: "documenter",
  tasks: [
    { task: "Document backend API" },
    { task: "Document frontend components" }
  ]
})
```

## Subagent Type Configuration

You can define custom subagent types using TOML configuration files. These allow you to create specialized subagents with different prompts, models, and reasoning levels.

### Configuration locations

Subagent type configurations are loaded in precedence order (later entries override earlier ones when names match):

1. **Bundled defaults**: `examples/subagents/*.toml` (included with this extension)
2. **User overrides**:
   - Legacy: `~/.pi/agent/subagents/*.toml`
   - Also supported: `~/.pi/subagents/*.toml`
   - Preferred: `~/.pi/agents/*.toml`
3. **Project overrides** (nearest ancestor from current cwd):
   - Legacy: `.pi/subagents/*.toml`
   - Preferred: `.pi/agents/*.toml`

If no override directory contains a matching type, the extension falls back to the included `examples/subagents` configuration files.

### TOML format

Each `.toml` file defines one subagent type:

```toml
name = "scout"
description = "Exploration specialist for finding files and patterns"

# Optional: Override the model (defaults to parent session's model)
model = "openai/gpt-4o-mini"

# Optional: Set reasoning level (low, medium, high, xhigh)
reasoning = "low"

# Required: The system prompt for this subagent type
prompt = """You are a Scout subagent specialized in exploration...

## Guidelines
- Be quick and focused
- Use bash, find, grep efficiently
- Report findings in structured format
"""
```

### Default subagent type

When no type is specified, the extension resolves the default in this order:

1. the highest-precedence non-bundled `worker.toml` override found in user/project directories
2. otherwise the highest-precedence non-bundled `default.toml` override found in user/project directories
3. bundled discovered `worker`
4. bundled `examples/subagents/worker.toml`
5. Emergency inline fallback (only if bundled files are unavailable)

To customize the default behavior, create `worker.toml` in one of the supported user or project override directories.

### Example subagent types

The extension includes example configurations for common use cases:

| Type | Purpose | Reasoning |
|------|---------|-----------|
| `worker` | General-purpose development tasks | medium |
| `scout` | Exploration and discovery | low |
| `documenter` | Documentation writing | medium |
| `reviewer` | Code review and analysis | high |

See the `examples/subagents/` directory for complete example configurations.

### Using subagent types

**Via slash command:**
```bash
/subagent scout "Find all API endpoints in src/"
/subagent documenter "Write README for the auth module"
/subagent reviewer "Check src/auth.ts for security issues"
```

**Via the `subagent` tool:**
```ts
// Single subagent with type
subagent({ 
  type: "scout", 
  task: "Find all TypeScript files" 
})

// Parallel subagents with types
subagent({
  tasks: [
    { task: "Document auth module" },  // uses default/worker type
    { task: "Review auth module" }     // uses default/worker type
  ],
  type: "documenter"  // applies to all tasks
})
```

## Configuration

This extension supports both **JSON config files** and **environment variables**.

### Configuration file locations and precedence

The extension loads and merges configuration in this order:

1. Built-in defaults
2. Global config: `~/.pi/agent/collaborating-agents.json`
3. Project config: `<cwd>/.pi/collaborating-agents.json` (overrides global)

Invalid config values fall back to defaults. Numeric fields such as `messageHistoryLimit` must be positive.

### Config keys

#### `messageHistoryLimit` (number, default: `400`)

Default history depth used by the overlay feed/chat loader.

- Larger values allow more history at once but increase read/format work.
- Smaller values keep UI snappier in very high-message sessions.

This is a default baseline; runtime calls may still request larger limits.

#### `subagentLaunchMode` (`"process" | "cmux-pane"`, default: `"process"`)

Controls how spawned subagents are launched.

- `"process"` keeps the current behavior: spawn a background `pi` child process directly.
- `"cmux-pane"` launches the subagent in a new visible cmux split pane in the current workspace by calling `cmux new-split` and then sending a real `pi` launch command into that pane.
- In `"cmux-pane"` mode, the extension tracks the orchestrator pane plus visible subagent panes in the workspace and picks the shallowest managed pane for the next split (preferring subagent panes over the orchestrator on ties). That keeps the overall pane tree balanced instead of repeatedly shrinking the orchestrator pane.
- After each new pane is created, the extension also snapshots live cmux panes/surfaces and performs a best-effort rebalance pass. If managed surfaces drifted because of manual pane moves or closes, it uses `move-surface`/`reorder-surface` to restore the planned arrangement before continuing.

Use `"cmux-pane"` when you want every spawned agent to have a real visible terminal in cmux while still preserving automatic result collection in the parent session. The pane shows Pi's native terminal session output instead of a custom JSON renderer.

By default, successfully completed `"cmux-pane"` subagents are auto-closed after the orchestrator has collected their final output and the pane has stayed idle for a short grace period. If the pane reports a non-zero post-output exit during that grace period, or if close/idle detection fails, the pane is left open so you can inspect diagnostics.

`"cmux-pane"` requires the orchestrator itself to be running inside cmux so the extension can split the current workspace.

Example:

```json
{
  "subagentLaunchMode": "cmux-pane",
  "closeCompletedCmuxPanes": true
}
```

#### `closeCompletedCmuxPanes` (boolean, default: `true`)

Controls whether successfully completed `"cmux-pane"` subagents automatically close their terminal surface after the parent orchestrator has collected the final output and the pane has remained idle for a short grace period.

- `true` closes successful completed panes by calling `cmux close-surface --surface <ref>` after turn-finished output plus a short idle grace.
- `false` keeps completed panes open for manual inspection.

This setting only affects `"cmux-pane"` launch mode. Failures or non-zero exits detected during the idle grace leave panes open so logs remain visible.

### Environment variables

#### `COLLABORATING_AGENTS_DIR`

Overrides the storage root used by the extension. Default:

- `~/.pi/agent/collaborating-agents`

This affects:

- `registry/` (active agent registrations)
- `inbox/` (per-agent inbound queue)
- `messages.jsonl` (global append-only message log)

Use this to isolate per-project state or relocate agent data.

#### `PI_AGENT_NAME`

Forces an explicit runtime agent name instead of auto-generated names.

Useful for deterministic scripts/tests or named coordinator sessions.

#### `PI_COLLAB_SUBAGENT_DEPTH` and `PI_COLLAB_SUBAGENT_MAX_DEPTH`

Recursion guard for nested subagent spawning.

- `PI_COLLAB_SUBAGENT_DEPTH` tracks current depth.
- `PI_COLLAB_SUBAGENT_MAX_DEPTH` sets max allowed depth (default max is `2`).

If `depth >= max`, subagent spawn is blocked.

## How It Works

Messages use Pi's delivery system: normal messages queue until the recipient finishes their current turn, urgent ones interrupt immediately. No polling is needed.

Reservations are enforced by hooking Pi's edit and write tools. When an agent tries to edit a reserved file, the tool call gets blocked and the agent sees who reserved it, why, and a suggestion to coordinate via the `agent_message({ action: "send", ... })` tool. Write and edit calls are blocked when another active agent has a matching reservation. Reads remain allowed.

States in this extension are stored at `~/.pi/agent/collaborating-agents/`:

```
.pi/agent/collaborating-agents/
├── registry/          # One JSON file per agent
├── inbox/{name}/      # Inbound messages as JSON files, watched with fs.watch, one directory for each agent
└── messages.jsonl     # Append-only log of all messages in the system
```

To run all tests:

```bash
bun test
```
