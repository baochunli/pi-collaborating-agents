---
name: collaborating-agents-system
description: Operating guide for coordinator and spawned subagents using the collaborating-agents extension. Covers agent_message actions, subagent spawning, reservations, delivery semantics, limits, defaults, and failure handling.
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

## 2) `subagent` (spawn workers)

Modes:

- Single: `{ task }`
- Parallel: `{ tasks: [{ task, cwd? }, ...] }`

Examples:

```ts
subagent({ task: "Implement auth tags and report back via agent_message" })

subagent({
  tasks: [
    { task: "Implement backend pieces" },
    { task: "Implement frontend pieces" }
  ]
})
```

## Coordinator workflow (recommended)

1. **Discover peers**: `agent_message({ action: "list" })`
2. **Plan work split**
3. **Spawn workers** with `subagent`
4. **Track progress** using `thread`/`feed`
5. **Coordinate reservations** so only one writer owns a target path
6. **Collect worker completion output** (auto-collected by orchestrator)
7. **Release reservations** after merge/finalization

## Subagent workflow (required behavior)

Spawned workers use a built-in collaborating subagent prompt. At minimum they should:

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
- Child session control default: enabled (`--session-control`) unless explicitly disabled

## Identity and storage

Base storage directory:

- Default: `~/.pi/agent/collaborating-agents`
- Override via env: `COLLABORATING_AGENTS_DIR`

Stored state:

- `registry/` — active agent registrations + reservations
- `inbox/` — per-agent message queue files
- `messages.jsonl` — append-only global message log

Agent naming:

- `PI_AGENT_NAME` can force explicit agent name
- otherwise extension generates readable names and resolves collisions

## Config files

Loaded and merged in this order:

1. Global: `~/.pi/agent/collaborating-agents.json`
2. Project: `<cwd>/.pi/collaborating-agents.json` (overrides global)

Config keys:

- `staleAgentSeconds` (default `120`)
- `controlSocketDir` (default `~/.pi/session-control`)
- `requireSessionControl` (default `true`)
- `remoteWaitMs` (default `300000`)
- `messageHistoryLimit` (default `400`)

## Failure handling

- `send`: fails if target is inactive, self-targeted, or message is empty
- `broadcast`: fails when no active recipients or message is empty
- `thread`: requires `to`
- `reserve`: requires non-empty `paths`
- `release`: if `paths` provided, must contain valid entries
- Subagent spawn may fail on recursion depth guard or process failure; inspect returned launch/result details

## Team protocol (concise)

- Prefer **direct** messages for task traffic
- Use **broadcast** only for milestone-level announcements
- Use `urgent: true` sparingly for time-critical blockers/decisions
- Reserve early, release promptly
- Keep worker scope narrow and report with structured output
- Coordinator is responsible for conflict resolution and final synthesis
