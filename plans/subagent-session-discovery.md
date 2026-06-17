# Subagent Session Discovery and Transcript Tail Plan

## Problem

Coordinators currently have to manually discover a subagent's active session by combining `agent_message({ action: "list" })`, filesystem searches under `~/.pi/agent/sessions`, and ad-hoc JSONL parsing. This is inconvenient and error-prone, especially while a subagent is still running.

The `pi-collaborating-agents` extension already knows most of the required information during launch, registration, completion collection, and session switching. This feature should persist and expose that information through first-class tools.

## Goal

Make subagent session inspection available through the existing collaboration API:

```ts
agent_message({ action: "sessions" })
agent_message({ action: "session", to: "WarmMoon" })
agent_message({ action: "tail", to: "WarmMoon", limit: 30 })
agent_message({ action: "tail", to: "latest", limit: 30 })
```

The coordinator should no longer need to scan session directories or write local scripts to inspect current subagent progress.

## Success criteria

- After spawning a subagent, the coordinator can retrieve its session id and session file path through `agent_message`.
- Launch and completion messages include enough metadata to identify the subagent run.
- `agent_message({ action: "sessions" })` lists active and recently completed subagent runs.
- `agent_message({ action: "session", ... })` resolves by exact name, unique prefix, session id prefix, run id, or `latest`.
- `agent_message({ action: "tail", ... })` returns a readable transcript tail without requiring Python or shell parsing.
- The feature works in both `process` and `cmux-pane` launch modes.
- Existing `agent_message` and `subagent` behavior remains backward-compatible.
- Tests cover run persistence, session resolution, transcript parsing, and user-facing tool output.

---

## Phase 1: Add durable run records

### Files

- `extensions/collaborating-agents/types.ts`
- `extensions/collaborating-agents/paths.ts`
- `extensions/collaborating-agents/store.ts`
- new tests in `extensions/collaborating-agents/store.test.ts` or a new run-registry test file

### Types

Add run lifecycle types:

```ts
export type SubagentRunStatus = "launching" | "running" | "completed" | "failed";

export interface SubagentRunRecord {
  runId: string;
  parentAgent: string;
  name: string;
  type: string;
  task: string;
  status: SubagentRunStatus;
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
  model?: string;
  launchMode: "process" | "cmux-pane";
  startedAt: string;
  lastSeenAt: string;
  completedAt?: string;
  exitCode?: number;
  outputPreview?: string;
}
```

### Storage

Add a durable run registry under the existing collaborating-agents storage root:

```text
~/.pi/agent/collaborating-agents/runs/
```

Store one JSON file per subagent run:

```text
runs/<runId>-<agentName>.json
```

One file per subagent is simpler than one batch file because parallel subagents can update independently.

### Store helpers

Add helper functions:

```ts
writeSubagentRunRecord(dirs, record)
updateSubagentRunRecord(dirs, runId, name, patch)
listSubagentRunRecords(dirs, options)
resolveSubagentRunRecord(dirs, selector)
```

Resolution should support:

- exact subagent name;
- unique name prefix;
- session id prefix;
- run id;
- `latest`.

The `latest` selector should mean the newest subagent run associated with the current coordinator when possible, falling back to the newest run record overall.

### Retention

Start with simple retention:

- keep recent records by default;
- list newest first;
- cap displayed results in tool output;
- defer pruning until the feature is stable.

A later config option can prune records older than N days.

---

## Phase 2: Instrument subagent spawning

### Files

- `extensions/collaborating-agents/index.ts`
- `extensions/collaborating-agents/subagent-spawn.ts`
- `extensions/collaborating-agents/subagent-spawn.test.ts`

### Make run id visible earlier

`executeSubagentParams()` currently creates its own `runId`. Move run-id ownership up to `launchSubagentsInBackground()` so the initial `subagent` tool response can mention the run immediately.

Suggested shape:

```ts
function launchSubagentsInBackground(params, ctx, options?: { runId?: string }): void
```

Immediate tool response should include:

```text
Subagent launched in background.
Run ID: abc12345
Use agent_message({ action: "sessions" }) or agent_message({ action: "tail", to: "latest" }).
```

### Record lifecycle updates

When a subagent is planned:

- create `SubagentRunRecord` with `status: "launching"`.

When `onLaunch` fires:

- update `name`, `type`, `cwd`, `model`, `launchMode`, known `sessionFile`, and `status: "running"`.

When a child registration becomes visible:

- update `sessionId` and `sessionFile` from the registration.

When `runSpawnTask()` completes:

- mark `completed` or `failed`;
- store `exitCode`;
- store a short `outputPreview`;
- fill `sessionFile` using the best available source:
  1. `SpawnResult.sessionFile`,
  2. live agent registration,
  3. completed subagent snapshot,
  4. `findSessionFileBySessionId(sessionId)` fallback.

### Process mode handling

`cmux-pane` mode already creates a known session file. `process` mode often has the session id before the session file path. For process mode:

1. rely first on child self-registration because `buildRegistration()` already includes `ctx.sessionManager.getSessionFile()`;
2. store `sessionId` as soon as it appears in JSON-mode output;
3. resolve `sessionFile` lazily via `findSessionFileBySessionId(sessionId)`;
4. optional later improvement: test whether `pi --mode json -p --session <file>` is supported, then allocate explicit process-mode session files too.

### Avoid blocking spawn completion

Run-registry updates should be best-effort and must not fail a subagent run. If a registry write fails, return the normal subagent output and include a warning in details/logging if practical.

---

## Phase 3: Add `agent_message` actions

### Files

- `extensions/collaborating-agents/index.ts`
- `extensions/collaborating-agents/types.ts`
- tests in `extensions/collaborating-agents/store.test.ts` and, where practical, an extension tool test

### Extend actions

```ts
const AGENT_MESSAGE_ACTIONS = [
  "status",
  "list",
  "send",
  "broadcast",
  "feed",
  "thread",
  "reserve",
  "release",
  "sessions",
  "session",
  "tail",
] as const;
```

Add optional params:

```ts
runId?: string;
raw?: boolean;
includeCompleted?: boolean;
```

Existing params should keep working.

### `sessions`

Example:

```ts
agent_message({ action: "sessions" })
```

Output:

```text
Subagent sessions:
- WarmMoon reviewer completed • run abc12345 • session 019ecdf4... • /Users/...jsonl
- AmberAnchor worker completed • run def67890 • session 019ecdea... • /Users/...jsonl
```

Details should return full structured records.

### `session`

Examples:

```ts
agent_message({ action: "session", to: "WarmMoon" })
agent_message({ action: "session", to: "latest" })
agent_message({ action: "session", runId: "abc12345" })
```

Output:

```text
WarmMoon
Status: completed
Run ID: abc12345
Session ID: 019ecdf4...
Session file: /Users/bli/.pi/agent/sessions/...jsonl
CWD: ...
Model: ...
```

If a record has a session id but no session file, the action should attempt lazy resolution and update the record if successful.

### `tail`

Examples:

```ts
agent_message({ action: "tail", to: "WarmMoon", limit: 30 })
agent_message({ action: "tail", to: "latest", limit: 50 })
```

Output:

```text
Tail for WarmMoon:
01:06 assistant toolUse read README.md
01:06 toolResult read: 200 lines
01:07 assistant final:
No findings
```

Details should include the resolved run record and parsed tail entries.

### Error behavior

- Unknown selector: return a helpful list of candidate agents/runs.
- Ambiguous prefix: return all matches and ask for a longer selector.
- Missing session file: return status metadata and say session file is not available yet.
- Malformed transcript lines: skip them and include a count in details.

---

## Phase 4: Add transcript tail parser

### New file

```text
extensions/collaborating-agents/session-tail.ts
```

### Responsibilities

```ts
readSessionTail(sessionFile, options)
parseSessionJsonlLine(line)
formatSessionTail(entries, options)
extractAssistantText(content)
```

### Supported entries

- session id event;
- assistant text;
- assistant final text;
- tool use name and compact arguments;
- tool result summary;
- stop reason;
- timestamp.

### Formatting rules

- Default to concise output.
- Truncate long text and tool results.
- Show tool names and file paths when obvious.
- Preserve final assistant text clearly.
- Provide `raw: true` option for JSON-ish detail if needed.

### Robustness

- Ignore malformed JSONL lines.
- Handle older/newer Pi event shapes defensively.
- Do not read unbounded huge files when only a tail is requested.
- First implementation can read a bounded suffix of the file, split on newlines, and parse complete JSONL lines from that suffix.
- If suffix parsing starts in the middle of a line, discard the first partial line unless the file is smaller than the suffix cap.

Suggested defaults:

```ts
const DEFAULT_TAIL_LIMIT = 30;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TEXT_TRUNCATE = 2000;
```

---

## Phase 5: Improve launch and completion UX

### Launch update

Current launch update should include run and inspection hints:

```text
Spawning subagent "WarmMoon".
Run ID: abc12345
Runtime subagent name: WarmMoon
Session ID: pending
Session file: pending

Inspect with:
agent_message({ action: "session", to: "WarmMoon" })
agent_message({ action: "tail", to: "WarmMoon", limit: 30 })
```

When session metadata becomes available, emit a lightweight message:

```text
Subagent session ready: WarmMoon
Session ID: 019...
Session file: /Users/...jsonl
```

This should be best-effort and should not spam repeatedly. Track whether the ready notice has already been sent for a run.

### Completion update

Append an inspection hint to final completion messages:

```text
Inspect transcript:
agent_message({ action: "tail", to: "WarmMoon", limit: 50 })
```

For parallel runs, include one hint per subagent plus a `sessions` hint.

---

## Phase 6: Tests

### Run registry tests

Cover:

- create record;
- update record;
- list records newest first;
- resolve by exact name;
- resolve by unique prefix;
- resolve by run id;
- resolve by session id prefix;
- resolve `latest`;
- ambiguous selector returns useful matches;
- corrupted run files are ignored safely.

### Transcript parser tests

Cover:

- parse session id event;
- parse assistant message text;
- parse final assistant text;
- parse tool use entries;
- parse tool result entries;
- skip malformed lines;
- truncate long outputs;
- format tail entries in stable order;
- bounded suffix reads do not fail on partial first lines.

### Spawn tests

Cover:

- `runSpawnTask()` process-mode result with session id updates record;
- cmux-mode explicit session file is recorded;
- completion fills missing session file from fallback resolver;
- registry write failures do not fail spawn results.

### Agent-message tests

Where the existing architecture permits, cover:

- `sessions` lists active and completed records;
- `session` resolves `latest`;
- `tail` returns formatted transcript;
- missing session file returns a helpful error.

If directly testing the registered tool is cumbersome, test the underlying helper functions and keep one integration-style test around action formatting.

---

## Phase 7: Documentation and skill updates

### Files

- `skills/collaborating-agents-system/SKILL.md`
- `README.md` if it documents subagent operation
- tool descriptions in `extensions/collaborating-agents/index.ts`

Add a section:

```md
## Inspecting subagent sessions

Use:

agent_message({ action: "sessions" })
agent_message({ action: "session", to: "latest" })
agent_message({ action: "tail", to: "latest", limit: 30 })

Do not scan ~/.pi/agent/sessions manually. The extension records subagent
run metadata and can resolve active or recently completed sessions by name,
run id, session id prefix, or latest.
```

Update the `agent_message` action list to include:

- `sessions` — list subagent run/session metadata;
- `session` — resolve one subagent session;
- `tail` — format recent transcript events.

---

## Phase 8: Validation

Run from the `pi-collaborating-agents` repository:

```bash
npm test
npm pack --dry-run
```

Manual smoke test:

1. Start Pi with the local extension.
2. Spawn a process-mode subagent.
3. Immediately run:

   ```ts
   agent_message({ action: "sessions" })
   ```

4. Confirm the run appears as `launching` or `running`.
5. Once session metadata is ready, run:

   ```ts
   agent_message({ action: "session", to: "latest" })
   agent_message({ action: "tail", to: "latest", limit: 20 })
   ```

6. Confirm the transcript tail includes recent assistant/tool activity.
7. Wait for completion and confirm status becomes `completed` or `failed`.
8. If cmux is installed, repeat with `subagentLaunchMode = "cmux-pane"`.

---

## Implementation order

1. Add `SubagentRunRecord` types and run-registry paths.
2. Implement store helpers and tests.
3. Add `session-tail.ts` parser/formatter and tests.
4. Wire run-record creation and updates into subagent launch/completion.
5. Add `agent_message` actions: `sessions`, `session`, `tail`.
6. Improve launch/completion messages with run/session hints.
7. Update skill docs and README.
8. Run full tests and manual smoke validation.

## Non-goals for the first iteration

- Full live streaming transcript over the tool call.
- Remote control of subagent sessions beyond existing focus/switch behavior.
- Complex retention policy or database storage.
- Changing subagent final-output collection semantics.

These can be considered after the basic run registry and transcript tail API are stable.
