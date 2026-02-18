# Collaborating Agents: An Extension for the Pi Coding Agent

This is an extension for Pi for spawning subagents, and for them to reserve/receive files and send/receive messages to one another.

All sessions auto-register immediately when they start; so when a new Pi session is started, it is already part of the collaborating agents system.

## Quick Start

To install this extension and its included skill:

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
pi remove https://github.com/baochunli/pi-collaborating-agents
```

## Opening the _Agents and Messages_ Overlay with the `/agents` Command

The `/agents` slash command opens an integrated _agents and messages_ overlay, which includes the following tabs:

  - `Agents` tab contains a list of all active and recently completed agents, and it allows the user to switch to the selected active session and tracks the target session in real time.
  - `File reservations` tab shows active reservation patterns and which agent currently owns each one.
  - One tab for each agent to show the messages sent to and from this agent.
  - `All messages` tab to show all recent messages since the last time subagents have been spawned by an orchestrator agent.

Newly-started agents show up immediately; if their transcript file is not persisted yet they are marked `session pending`. Completed subagents remain visible in the `Agents` tab as `completed` until the next time an orchestrator agent spawns new subagents, which clears prior historical subagent states and their messages.

The overlay also allows a user to send a message directly to an agent using `@AgentName message` (in a tab for an individual agent or in the `All messages` tab), or `@all message` to broadcast to all agents. Prefix the message body with `!!` to mark it urgent. Sending a message in the `Agents` or `File reservations` tab broadcasts it to all agents by default.

## Spawning a subagent via the `/subagent` command

The user can spawn a single subagent manually in the background using the `/subagent <task>` slash command. It uses a built-in collaborating subagent prompt from this extension, and the subagent defaults to the same model as the spawning session. All agents use a readable two-word callsigns (for example: `SilverHarbor`). An immediate `Spawning subagent ...` status message with runtime name and prompt will be shown immediately.

The parent (orchestrator agent) sessions automatically collect final subagent outputs on completion (single and parallel), without requiring subagents to send a separate final direct message summary. All direct subagent→parent status messages are optional, but are useful for blockers/questions only. Inbox delivery uses Pi's message routing: normal messages are queued with `followUp`, and `urgent: true` messages interrupt immediately with `steer`.

## Autonomous Tool API for Agents

The following tool is provided for agents to call autonomously. Users should use the slash commands above.

### The `agent_message` Tool

The extension provides a dedicated **`agent_message`** tool for autonomous agent-to-agent messaging.

Actions:

- `status` – current identity, focus mode, peer count, and your reservation count
- `list` – list active agents (includes reservation counts when present)
- `send` – send direct message (`to` + `message`, optional `urgent`)
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
