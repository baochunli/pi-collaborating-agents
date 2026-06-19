---
name: collaborating-agents-system
description: Operating guide for coordinator and spawned subagents using the collaborating-agents extension. Covers agent_message actions, subagent spawning, subagent session inspection, reservations, delivery semantics, limits, defaults, and failure handling.
---

# Collaborating Agents System (Coordinator + Subagent Playbook)

Use this skill when operating the `collaborating-agents` extension so coordinators and subagents follow the same protocol.

## What this system provides

The extension gives you:

1. **Agent mesh + messaging** via `agent_message`
2. **File reservation locking** for write/edit coordination
3. **Subagent spawning** via `subagent`

## Core tools

### 1) `agent_message` (coordination + reservations)

Actions:

- `status` — self identity, focus, peer count, reservations
- `list` — active agents
- `sessions` — scoped subagent run/session records; completed/failed included by default, use `includeCompleted: false` for active only
- `session` — resolve one subagent run/session record
- `tail` — read a concise transcript tail for one subagent run/session
- `send` — direct message to one peer (`to`, `message`, optional `replyTo`, optional `urgent`)
- `broadcast` — message all peers (`message`, optional `urgent`)
- `feed` — recent global message log (`limit`, default 20, max 400)
- `thread` — DM history with one peer (`to`, optional `limit`)
- `reserve` — reserve write/edit targets (`paths`, optional `reason`)
- `release` — release specific `paths`, or all if omitted

Delivery semantics (important):

- Normal messages (`urgent: false` or omitted) are delivered with Pi `followUp` (queued until the current turn completes).
- Urgent messages (`urgent: true`) are delivered with Pi `steer` (interrupt immediately).

Common calls:

```ts
agent_message({ action: "status" })
agent_message({ action: "list" })
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
agent_message({ action: "send", to: "BlueFalcon", message: "Started task X" })
agent_message({ action: "send", to: "BlueFalcon", message: "Need decision now", urgent: true })
agent_message({ action: "broadcast", message: "Wave 2 complete" })
agent_message({ action: "thread", to: "BlueFalcon", limit: 20 })
agent_message({ action: "reserve", paths: ["src/server/"], reason: "auth refactor" })
agent_message({ action: "release", paths: ["src/server/"] })
```

Notes:

- In the `/agents` overlay, prefix message text with `!!` to send urgent.
- Use urgent only for blockers/decisions that cannot wait.

### Subagent session inspection

Coordinators should inspect spawned subagents through the run registry:

```ts
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
```

Do not scan `~/.pi/agent/sessions` manually for normal subagent inspection. The `session` and `tail` actions scope lookups to the current coordinator and return helpful ambiguity or unavailable-session errors.

Supported selectors for `session` and `tail`:

- child run id / `recordId`: stable per-child id returned by `subagent`
- display name: readable launch/completion name
- canonical name: runtime subagent name stored in the registry/run record
- batch id: works only when one child matches; parallel batches are ambiguous and return candidates
- session id prefix: prefix of the Pi session id
- `latest`: newest subagent run for the current coordinator

`sessions` lists active, completed, and failed records for the current coordinator by default. Use `includeCompleted: false` to show only launching/running child runs. `tail` accepts selectors only, not raw file paths.

Process mode launches a background `pi` child without a deterministic `--session` file. The extension records the session id from child output and attaches a session file after child self-registration or fallback discovery by session id. Until that happens, tailing may report: `Process-mode session file unavailable until child registration or fallback discovery provides one.` In `cmux-pane` mode, the extension creates an explicit session file under `~/.pi/agent/sessions/collaborating-agents-subagents/`.

## 2) `subagent` (spawn workers)

Modes:

- Single: `{ task }` or `{ type, task }`
- Parallel: `{ tasks: [{ task, cwd? }, ...] }` or `{ type, tasks: [...] }`

### Subagent Types (agent-type design)

Subagents are driven by **type configs** (TOML files). A type controls:

- system prompt
- optional model override
- optional reasoning level (`low | medium | high | xhigh`)

You can use built-in types (from `examples/subagents`) or override/add your own.

Common built-ins include:

- `worker` — general-purpose implementation (default)
- `scout` — fast discovery / codebase exploration
- `documenter` — docs and writeups
- `reviewer` — review / risk analysis
- plus many additional bundled specialists in `examples/subagents/*.toml`

#### Type discovery precedence

Later sources override earlier ones when `name` matches:

1. Bundled defaults: `examples/subagents/*.toml`
2. User overrides:
   - Legacy: `~/.pi/agent/subagents/*.toml`
   - Also supported: `~/.pi/subagents/*.toml`
   - Preferred: `~/.pi/agents/*.toml`
3. Project overrides (nearest ancestor from current cwd):
   - Legacy: `.pi/subagents/*.toml`
   - Preferred: `.pi/agents/*.toml`

So by default, bundled `examples/subagents` are used. Any matching config in the user/project override directories takes priority.

#### Default type resolution

When no `type` is passed:

1. use the highest-precedence non-bundled `worker.toml` override if present
2. else use the highest-precedence non-bundled `default.toml` override if present
3. else use bundled `worker` from `examples/subagents/*.toml`
4. else fallback to bundled `examples/subagents/worker.toml`
5. else use emergency inline worker prompt (rare)

#### TOML shape

```toml
name = "scout"
description = "Exploration specialist"
model = "openai/gpt-4o-mini"   # optional
reasoning = "low"               # optional
prompt = """...required system prompt..."""
```

### Examples

```ts
// Default subagent type
subagent({ task: "Implement auth tags and report back via agent_message" })

// With specific subagent type
subagent({ 
  type: "scout",
  task: "Find all TypeScript files in src/" 
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

### Slash command

Users can also spawn subagents via the `/subagent` command:

```
/subagent "Implement user authentication"
/subagent scout "Find all API endpoints"
/subagent documenter "Write README for auth module"
```

## Coordinator workflow (recommended)

1. **Discover peers**: `agent_message({ action: "list" })`
2. **Plan work split**
3. **Spawn workers** with `subagent`
4. **Track progress** using `sessions`, `session`, and `tail`; use `thread`/`feed` for explicit messages
5. **Coordinate reservations** so only one writer owns a target path
6. **Collect worker completion output** (auto-collected by orchestrator)
7. **Release reservations** after merge/finalization

## Subagent workflow (required behavior)

Spawned workers use a subagent prompt based on their configured `type` (defaulting to a built-in prompt if no type is specified). At minimum they should:

1. At startup call:
   - `agent_message({ action: "status" })`
   - `agent_message({ action: "list" })`
2. Send direct updates to coordinator only when useful:
   - startup acknowledgement
   - blockers/questions needing input
3. Do **not** send a mandatory final DM summary; coordinator collects final output automatically.
4. Avoid broadcast progress unless explicitly requested.
5. Read before edit, keep changes scoped, run validation when possible.

Expected final report structure from workers:

- `## Summary`
- `## Files Changed`
- `## Validation`
- `## Notes`

## Reservation semantics (important)

- Reservation path ending with `/` means **directory prefix match**.
  - Example: `src/server/` blocks writes/edits under that directory.
- Reservation path without trailing `/` means **exact file match**.
- Conflicts block `write`/`edit` calls by other agents.
- Reads are still allowed.

Best practice:

- Reserve **before** first edit/write.
- Release as soon as ownership is no longer needed.
- Include a `reason` for auditability.

## Limits and defaults

- Parallel task count max: **8**
- Parallel runtime concurrency: `min(taskCount, 4)`
- One active `subagent` run at a time per orchestrator session
- Child recursion guard: blocked when depth >= max depth
  - Depth env: `PI_COLLAB_SUBAGENT_DEPTH`
  - Max env: `PI_COLLAB_SUBAGENT_MAX_DEPTH` (default 2)
- Spawned worker default tools:
  - `read`, `write`, `edit`, `bash`, `agent_message`

## Identity and storage

Base storage directory:

- Default: `~/.pi/agent/collaborating-agents`
- Override via env: `COLLABORATING_AGENTS_DIR`

Stored state:

- `registry/` — active agent registrations + reservations
- `inbox/` — per-agent message queue files
- `runs/` — durable subagent run/session records
- `messages.jsonl` — append-only global message log

Agent naming:

- `PI_AGENT_NAME` can force explicit agent name
- otherwise extension generates readable names and resolves collisions

## Failure handling

- `send`: fails if target is inactive, self-targeted, or message is empty
- `broadcast`: fails when no active recipients or message is empty
- `thread`: requires `to`
- `reserve`: requires non-empty `paths`
- `release`: if `paths` provided, must contain valid entries
- `session`/`tail`: return explicit errors for unknown selectors, ambiguous batch/display-name matches, missing session files, unavailable process-mode session files, unreadable files, and invalid non-JSONL files
- Subagent spawn may fail on recursion depth guard or process failure; inspect returned launch/result details

## Validation

Prefer `bun test` for validation. Useful focused checks:

```bash
bun test extensions/collaborating-agents/docs.test.ts
bun test extensions/collaborating-agents/index.test.ts --test-name-pattern "tool documentation metadata|agent_message subagent sessions|subagent launch identity"
bun test extensions/collaborating-agents/session-tail.test.ts
npm pack --dry-run
```

Keep `npm pack --dry-run` as the packaging check.

## Team protocol (concise)

- Prefer **direct** messages for task traffic
- Use **broadcast** only for milestone-level announcements
- Use `urgent: true` sparingly for time-critical blockers/decisions
- Reserve early, release promptly
- Keep worker scope narrow and report with structured output
- Coordinator is responsible for conflict resolution and final synthesis
