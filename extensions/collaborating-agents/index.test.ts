import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import collaboratingAgentsExtension, {
  handleAgentMessageSession,
  handleAgentMessageSessions,
  handleAgentMessageTail,
} from "./index.ts";
import { listSubagentRunRecords, registerSelf, updateSubagentRunRecord, writeSubagentRunRecord } from "./store.ts";
import type { Dirs, SubagentRunListRecord, SubagentRunRecord } from "./types.ts";

const tempDirs: string[] = [];
const ORIGINAL_COLLAB_DIR = process.env.COLLABORATING_AGENTS_DIR;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_TEST_PI_EXIT_DELAY_MS = process.env.TEST_PI_EXIT_DELAY_MS;
const ORIGINAL_TEST_PI_EXIT_CODE = process.env.TEST_PI_EXIT_CODE;
const ORIGINAL_TEST_PI_FAIL_BEFORE_MESSAGE = process.env.TEST_PI_FAIL_BEFORE_MESSAGE;
const ORIGINAL_TEST_PI_OUTPUT_TEXT = process.env.TEST_PI_OUTPUT_TEXT;
const ORIGINAL_TEST_PI_REGISTER_SELF = process.env.TEST_PI_REGISTER_SELF;
const ORIGINAL_TEST_PI_REGISTER_SESSION_FILE = process.env.TEST_PI_REGISTER_SESSION_FILE;
const ORIGINAL_TEST_PI_SKIP_SESSION_EVENT = process.env.TEST_PI_SKIP_SESSION_EVENT;
const ORIGINAL_TEST_PI_STDERR = process.env.TEST_PI_STDERR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (typeof ORIGINAL_COLLAB_DIR === "string") process.env.COLLABORATING_AGENTS_DIR = ORIGINAL_COLLAB_DIR;
  else delete process.env.COLLABORATING_AGENTS_DIR;

  if (typeof ORIGINAL_PATH === "string") process.env.PATH = ORIGINAL_PATH;
  else delete process.env.PATH;

  if (typeof ORIGINAL_HOME === "string") process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;

  if (typeof ORIGINAL_USERPROFILE === "string") process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;

  if (typeof ORIGINAL_TEST_PI_EXIT_DELAY_MS === "string") process.env.TEST_PI_EXIT_DELAY_MS = ORIGINAL_TEST_PI_EXIT_DELAY_MS;
  else delete process.env.TEST_PI_EXIT_DELAY_MS;

  if (typeof ORIGINAL_TEST_PI_EXIT_CODE === "string") process.env.TEST_PI_EXIT_CODE = ORIGINAL_TEST_PI_EXIT_CODE;
  else delete process.env.TEST_PI_EXIT_CODE;

  if (typeof ORIGINAL_TEST_PI_FAIL_BEFORE_MESSAGE === "string") process.env.TEST_PI_FAIL_BEFORE_MESSAGE = ORIGINAL_TEST_PI_FAIL_BEFORE_MESSAGE;
  else delete process.env.TEST_PI_FAIL_BEFORE_MESSAGE;

  if (typeof ORIGINAL_TEST_PI_OUTPUT_TEXT === "string") process.env.TEST_PI_OUTPUT_TEXT = ORIGINAL_TEST_PI_OUTPUT_TEXT;
  else delete process.env.TEST_PI_OUTPUT_TEXT;

  if (typeof ORIGINAL_TEST_PI_REGISTER_SELF === "string") process.env.TEST_PI_REGISTER_SELF = ORIGINAL_TEST_PI_REGISTER_SELF;
  else delete process.env.TEST_PI_REGISTER_SELF;

  if (typeof ORIGINAL_TEST_PI_REGISTER_SESSION_FILE === "string") process.env.TEST_PI_REGISTER_SESSION_FILE = ORIGINAL_TEST_PI_REGISTER_SESSION_FILE;
  else delete process.env.TEST_PI_REGISTER_SESSION_FILE;

  if (typeof ORIGINAL_TEST_PI_SKIP_SESSION_EVENT === "string") process.env.TEST_PI_SKIP_SESSION_EVENT = ORIGINAL_TEST_PI_SKIP_SESSION_EVENT;
  else delete process.env.TEST_PI_SKIP_SESSION_EVENT;

  if (typeof ORIGINAL_TEST_PI_STDERR === "string") process.env.TEST_PI_STDERR = ORIGINAL_TEST_PI_STDERR;
  else delete process.env.TEST_PI_STDERR;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFakePiBinary(dir: string): void {
  const binPath = path.join(dir, "pi");
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const sessionId = process.env.TEST_PI_SESSION_ID || "fake-session";
const outputText = process.env.TEST_PI_OUTPUT_TEXT || "fake-ok";
const exitDelayMs = Number(process.env.TEST_PI_EXIT_DELAY_MS || "0");
const exitCode = Number(process.env.TEST_PI_EXIT_CODE || "0");

if (process.env.TEST_PI_REGISTER_SELF === "1" && process.env.COLLABORATING_AGENTS_DIR && process.env.PI_AGENT_NAME) {
  const registryDir = path.join(process.env.COLLABORATING_AGENTS_DIR, "registry");
  fs.mkdirSync(registryDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(registryDir, process.env.PI_AGENT_NAME + ".json"), JSON.stringify({
    name: process.env.PI_AGENT_NAME,
    pid: process.pid,
    sessionId,
    sessionFile: process.env.TEST_PI_REGISTER_SESSION_FILE,
    cwd: process.cwd(),
    model: "fake/model",
    startedAt: now,
    lastSeenAt: now,
    role: "subagent",
  }), "utf-8");
}

const finish = () => setTimeout(() => process.exit(exitCode), Math.max(0, exitDelayMs));

if (process.env.TEST_PI_FAIL_BEFORE_MESSAGE === "1") {
  process.stderr.write(process.env.TEST_PI_STDERR || "subagent crashed");
  finish();
} else {
  if (process.env.TEST_PI_SKIP_SESSION_EVENT !== "1") {
    process.stdout.write(JSON.stringify({ type: "session", id: sessionId }) + "\\n");
  }

  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: outputText }] }
  }) + "\\n");
  finish();
}
`,
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);
}

function makeDirs(stateDir: string): Dirs {
  return {
    base: stateDir,
    registry: path.join(stateDir, "registry"),
    inbox: path.join(stateDir, "inbox"),
    messageLog: path.join(stateDir, "messages.jsonl"),
    runs: path.join(stateDir, "runs"),
  };
}

function makeRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    recordId: "run-1",
    batchRunId: "batch-1",
    taskIndex: 0,
    parentAgent: "Coordinator",
    parentSessionId: "parent-session",
    parentPid: 123,
    type: "worker",
    taskPreview: "Inspect the repository",
    cwd: "/work",
    status: "running",
    launchMode: "process",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function listRecords(stateDir: string): SubagentRunListRecord[] {
  return listSubagentRunRecords(makeDirs(stateDir));
}

function writeSessionJsonl(filePath: string, events: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n")}\n`,
    "utf-8",
  );
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForRunRecord(
  stateDir: string,
  recordId: string,
  predicate: (record: SubagentRunListRecord) => boolean,
): Promise<SubagentRunListRecord> {
  return await waitFor(() => {
    const record = listRecords(stateDir).find((candidate) => candidate.recordId === recordId);
    return record && predicate(record) ? record : undefined;
  });
}

async function waitForCompletionMessage(harness: { sentMessages: unknown[] }): Promise<Record<string, unknown>> {
  return await waitFor(() => {
    return harness.sentMessages.find((message): message is Record<string, unknown> => {
      if (!message || typeof message !== "object") return false;
      const details = (message as { details?: unknown }).details;
      return !!details && typeof details === "object" && (details as { mode?: unknown }).mode === "subagent";
    });
  });
}

function makeHarness(): {
  pi: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  handlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
  sentMessages: unknown[];
} {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
  const sentMessages: unknown[] = [];

  const pi = {
    on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      commands.set(name, options);
    },
    registerShortcut(): void {},
    registerFlag(): void {},
    getFlag(): undefined {
      return undefined;
    },
    registerMessageRenderer(): void {},
    sendMessage(message: unknown): void {
      sentMessages.push(message);
    },
    sendUserMessage(): void {},
    appendEntry(): void {},
    setSessionName(): void {},
    getSessionName(): undefined {
      return undefined;
    },
    setLabel(): void {},
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools(): void {},
    getCommands: () => [],
    getThinkingLevel: () => undefined,
    setThinkingLevel(): void {},
    setModel(): void {},
  } as unknown as ExtensionAPI;

  return { pi, tools, commands, handlers, sentMessages };
}

function makeContext(cwd: string): ExtensionContext {
  return {
    hasUI: true,
    cwd,
    ui: {
      theme: {
        fg: (_name: string, text: string) => text,
        bold: (text: string) => text,
      },
      notify(): void {},
      setStatus(): void {},
      setWidget(): void {},
      clearWidget(): void {},
      showDialog: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => path.join(cwd, "parent-session.jsonl"),
    },
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort(): void {},
    hasPendingMessages: () => false,
    shutdown(): void {},
    getContextUsage: () => undefined,
    compact(): void {},
    getSystemPrompt: () => "system prompt",
  } as ExtensionContext;
}

describe("agent_message subagent sessions", () => {
  test("sessions lists scoped runs newest first with completed filtering, stale markers, and truncation", () => {
    const stateDir = makeTempDir("collab-index-sessions-list");
    const dirs = makeDirs(stateDir);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-stale",
      batchRunId: "batch-stale",
      name: "worker-stale",
      displayName: "Worker Stale",
      status: "running",
      lastSeenAt: "2026-01-04T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-done",
      batchRunId: "batch-done",
      name: "worker-done",
      displayName: "Worker Done",
      status: "completed",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
      completedAt: "2026-01-03T00:05:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-failed",
      batchRunId: "batch-failed",
      name: "worker-failed",
      displayName: "Worker Failed",
      status: "failed",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T00:05:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "other-parent",
      batchRunId: "batch-other",
      parentSessionId: "other-session",
      parentPid: 456,
      lastSeenAt: "2026-01-05T00:00:00.000Z",
    }))).toBe(true);

    const activeOnly = handleAgentMessageSessions(dirs, { limit: 10 }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:05.000Z",
      staleAfterMs: 1000,
    });
    expect(activeOnly.details).toMatchObject({
      action: "sessions",
      includeCompleted: false,
      total: 1,
      truncated: false,
    });
    expect((activeOnly.details as { records: SubagentRunListRecord[] }).records.map((record) => record.recordId)).toEqual(["run-stale"]);

    const withCompleted = handleAgentMessageSessions(dirs, { limit: 2, includeCompleted: true }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:05.000Z",
      staleAfterMs: 1000,
    });

    expect(withCompleted.content[0]?.text).toContain("Subagent sessions (2 of 3)");
    expect(withCompleted.content[0]?.text).toContain("[stale]");
    expect(withCompleted.content[0]?.text).toContain("1 more not shown");
    expect(withCompleted.details).toMatchObject({
      action: "sessions",
      includeCompleted: true,
      total: 3,
      displayed: 2,
      truncated: true,
    });
    expect((withCompleted.details as { records: SubagentRunListRecord[] }).records.map((record) => record.recordId)).toEqual([
      "run-stale",
      "run-done",
    ]);
  });

  test("session uses runId precedence, defaults to latest, and lazily resolves missing session files", () => {
    const tempDir = makeTempDir("collab-index-session-detail");
    const stateDir = path.join(tempDir, "state");
    const dirs = makeDirs(stateDir);
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;

    const fallbackSessionFile = path.join(tempDir, ".pi", "agent", "sessions", "nested", "local_target-session.jsonl");
    fs.mkdirSync(path.dirname(fallbackSessionFile), { recursive: true });
    fs.writeFileSync(fallbackSessionFile, "", "utf-8");

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-target",
      batchRunId: "batch-target",
      name: "worker-target",
      displayName: "Worker Target",
      sessionId: "target-session",
      sessionFileUnavailableReason: "missing for now",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-selector",
      batchRunId: "batch-selector",
      name: "selector",
      displayName: "Selector",
      sessionId: "selector-session",
      sessionFile: path.join(tempDir, "selector.jsonl"),
      lastSeenAt: "2026-01-04T00:00:00.000Z",
    }))).toBe(true);

    const byRunId = handleAgentMessageSession(dirs, { runId: "run-target", to: "selector" }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    });
    expect(byRunId.details).toMatchObject({
      action: "session",
      requestedSelector: "run-target",
      record: {
        recordId: "run-target",
        sessionFile: fallbackSessionFile,
      },
      sessionFileResolved: true,
    });
    expect(byRunId.content[0]?.text).toContain(fallbackSessionFile);
    expect(listRecords(stateDir).find((record) => record.recordId === "run-target")?.sessionFile).toBe(fallbackSessionFile);

    const latest = handleAgentMessageSession(dirs, {}, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    });
    expect(latest.details).toMatchObject({
      action: "session",
      requestedSelector: "latest",
      record: {
        recordId: "run-selector",
      },
    });
  });

  test("session runId resolution prefers record id over colliding names", () => {
    const stateDir = makeTempDir("collab-index-session-run-id-precedence");
    const dirs = makeDirs(stateDir);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "run-target",
      batchRunId: "batch-target",
      name: "worker-target",
      displayName: "Worker Target",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "actual-record",
      batchRunId: "batch-actual",
      name: "run-target",
      displayName: "Run Target",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    }))).toBe(true);

    const result = handleAgentMessageSession(dirs, { runId: "run-target" }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    });

    expect(result.details).toMatchObject({
      action: "session",
      record: {
        recordId: "run-target",
      },
    });
  });

  test("session returns helpful candidate lists for unknown and ambiguous selectors", () => {
    const stateDir = makeTempDir("collab-index-session-errors");
    const dirs = makeDirs(stateDir);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "shared-0",
      batchRunId: "batch-shared",
      taskIndex: 0,
      name: "worker-one",
      displayName: "Worker One",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "shared-1",
      batchRunId: "batch-shared",
      taskIndex: 1,
      name: "worker-two",
      displayName: "Worker Two",
    }))).toBe(true);

    const context = {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    };

    const ambiguous = handleAgentMessageSession(dirs, { to: "batch-shared" }, context);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.details).toMatchObject({
      action: "session",
      error: "ambiguous_selector",
      candidates: [{ recordId: "shared-0" }, { recordId: "shared-1" }],
    });
    expect(ambiguous.content[0]?.text).toContain("matched multiple subagent runs");
    expect(ambiguous.content[0]?.text).toContain("shared-0");

    const missing = handleAgentMessageSession(dirs, { to: "missing" }, context);
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({
      action: "session",
      error: "not_found",
      candidates: [{ recordId: "shared-0" }, { recordId: "shared-1" }],
    });
    expect(missing.content[0]?.text).toContain("No subagent run matched");
  });

  test("session selectors and candidates are scoped to the current coordinator", () => {
    const stateDir = makeTempDir("collab-index-session-scope");
    const dirs = makeDirs(stateDir);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "current-run",
      batchRunId: "batch-current",
      name: "current-worker",
      displayName: "Current Worker",
      parentSessionId: "current-session",
      parentPid: 123,
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "other-run",
      batchRunId: "batch-other",
      name: "other-worker",
      displayName: "Other Worker",
      parentSessionId: "other-session",
      parentPid: 456,
    }))).toBe(true);

    const context = {
      parentAgent: "Coordinator",
      parentSessionId: "current-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    };

    const byRunId = handleAgentMessageSession(dirs, { runId: "other-run" }, context);
    expect(byRunId.isError).toBe(true);
    expect(byRunId.details).toMatchObject({
      action: "session",
      error: "not_found",
      candidates: [{ recordId: "current-run" }],
    });
    expect(JSON.stringify((byRunId.details as { candidates?: unknown }).candidates)).not.toContain("other-run");

    const byName = handleAgentMessageSession(dirs, { to: "other-worker" }, context);
    expect(byName.isError).toBe(true);
    expect(byName.details).toMatchObject({
      action: "session",
      error: "not_found",
      candidates: [{ recordId: "current-run" }],
    });
    expect(JSON.stringify((byName.details as { candidates?: unknown }).candidates)).not.toContain("other-worker");
  });

  test("tail returns formatted output and raw details from a scoped run record", () => {
    const tempDir = makeTempDir("collab-index-tail-formatted");
    const stateDir = path.join(tempDir, "state");
    const dirs = makeDirs(stateDir);
    const sessionFile = path.join(tempDir, "worker-session.jsonl");
    writeSessionJsonl(sessionFile, [
      { type: "session", id: "tail-session", timestamp: "2026-01-04T00:00:00.000Z" },
      "{bad",
      {
        type: "message",
        timestamp: "2026-01-04T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
      },
      {
        type: "message_end",
        timestamp: "2026-01-04T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ]);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "tail-run",
      batchRunId: "tail-batch",
      name: "worker-tail",
      displayName: "Worker Tail",
      status: "completed",
      sessionId: "tail-session",
      sessionFile,
      completedAt: "2026-01-04T00:00:03.000Z",
      lastSeenAt: "2026-01-04T00:00:03.000Z",
    }))).toBe(true);

    const result = handleAgentMessageTail(dirs, { runId: "tail-run", raw: true, limit: 10 }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:04.000Z",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Subagent tail tail-run");
    expect(result.content[0]?.text).toContain("assistant: I will inspect the file");
    expect(result.content[0]?.text).toContain("assistant final: done");
    expect(result.content[0]?.text).not.toContain("assistant final: I will inspect the file");
    expect(result.details).toMatchObject({
      action: "tail",
      raw: true,
      limit: 10,
      malformedLineCount: 1,
      truncatedStart: false,
      record: { recordId: "tail-run" },
      sessionFile,
      entries: [
        { kind: "session", sessionId: "tail-session" },
        { kind: "assistant_text", text: "I will inspect the file" },
        { kind: "assistant_tool_call", toolName: "read" },
        { kind: "stop", stopReason: "toolUse" },
        { kind: "assistant_text", text: "done" },
      ],
    });
  });

  test("tail uses runId precedence, normalizes limit, and refuses arbitrary paths", () => {
    const tempDir = makeTempDir("collab-index-tail-precedence");
    const stateDir = path.join(tempDir, "state");
    const dirs = makeDirs(stateDir);
    const targetSessionFile = path.join(tempDir, "target.jsonl");
    const selectorSessionFile = path.join(tempDir, "selector.jsonl");
    writeSessionJsonl(targetSessionFile, [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "target done" }] } },
    ]);
    writeSessionJsonl(selectorSessionFile, [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "selector done" }] } },
    ]);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "target-run",
      batchRunId: "batch-target",
      name: "target-worker",
      displayName: "Target Worker",
      status: "completed",
      sessionFile: targetSessionFile,
      lastSeenAt: "2026-01-04T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "selector-run",
      batchRunId: "batch-selector",
      name: "selector-worker",
      displayName: "Selector Worker",
      status: "completed",
      sessionFile: selectorSessionFile,
      lastSeenAt: "2026-01-05T00:00:00.000Z",
    }))).toBe(true);

    const byRunId = handleAgentMessageTail(dirs, { runId: "target-run", to: "selector-worker", limit: 1000 }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-05T00:00:00.000Z",
    });
    expect(byRunId.details).toMatchObject({
      action: "tail",
      limit: 100,
      record: { recordId: "target-run" },
    });
    expect(byRunId.content[0]?.text).toContain("target done");
    expect(byRunId.content[0]?.text).not.toContain("selector done");

    const pathAttempt = handleAgentMessageTail(dirs, { to: targetSessionFile }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-05T00:00:00.000Z",
    });
    expect(pathAttempt.isError).toBe(true);
    expect(pathAttempt.details).toMatchObject({ action: "tail", error: "invalid_selector" });
    expect(pathAttempt.content[0]?.text).toContain("does not accept file paths");
  });

  test("tail resolves session files from active registration metadata", () => {
    const tempDir = makeTempDir("collab-index-tail-registration");
    const stateDir = path.join(tempDir, "state");
    const dirs = makeDirs(stateDir);
    const sessionFile = path.join(tempDir, "registered-session.jsonl");
    writeSessionJsonl(sessionFile, [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "registered done" }] } },
    ]);

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "registered-run",
      batchRunId: "batch-registered",
      name: "worker-registered",
      displayName: "Worker Registered",
      sessionId: "registered-session",
      sessionFileUnavailableReason: "waiting for registration",
    }))).toBe(true);
    expect(registerSelf(dirs, {
      name: "worker-registered",
      pid: process.pid,
      sessionId: "registered-session",
      sessionFile,
      cwd: tempDir,
      model: "fake/model",
      startedAt: "2026-01-04T00:00:00.000Z",
      lastSeenAt: "2026-01-04T00:00:00.000Z",
      role: "subagent",
    })).toBe(true);

    const result = handleAgentMessageTail(dirs, { runId: "registered-run" }, {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("registered done");
    expect(result.details).toMatchObject({
      action: "tail",
      sessionFile,
      sessionFileResolved: true,
      sessionFileSource: "registration",
      record: { recordId: "registered-run", sessionFile },
    });
    expect(listRecords(stateDir).find((record) => record.recordId === "registered-run")?.sessionFile).toBe(sessionFile);
  });

  test("tail returns helpful errors for unavailable, deleted, and invalid session files", () => {
    const tempDir = makeTempDir("collab-index-tail-errors");
    const stateDir = path.join(tempDir, "state");
    const dirs = makeDirs(stateDir);
    const missingFile = path.join(tempDir, "missing.jsonl");
    const invalidFile = path.join(tempDir, "not-session.txt");
    fs.writeFileSync(invalidFile, "not jsonl", "utf-8");

    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "unavailable-run",
      batchRunId: "batch-unavailable",
      name: "worker-unavailable",
      sessionId: "unavailable-session",
      sessionFileUnavailableReason: "process mode has not reported a session file",
      lastSeenAt: "2026-01-04T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "missing-run",
      batchRunId: "batch-missing",
      name: "worker-missing",
      sessionId: "missing-session",
      sessionFile: missingFile,
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    }))).toBe(true);
    expect(writeSubagentRunRecord(dirs, makeRunRecord({
      recordId: "invalid-run",
      batchRunId: "batch-invalid",
      name: "worker-invalid",
      sessionId: "invalid-session",
      sessionFile: invalidFile,
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    }))).toBe(true);

    const context = {
      parentAgent: "Coordinator",
      parentSessionId: "parent-session",
      parentPid: 123,
      now: "2026-01-04T00:00:00.000Z",
    };

    const unavailable = handleAgentMessageTail(dirs, { runId: "unavailable-run" }, context);
    expect(unavailable.isError).toBe(true);
    expect(unavailable.details).toMatchObject({
      action: "tail",
      error: "session_file_unavailable",
      record: { recordId: "unavailable-run" },
    });
    expect(unavailable.content[0]?.text).toContain("process mode has not reported a session file");

    const missing = handleAgentMessageTail(dirs, { runId: "missing-run" }, context);
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({
      action: "tail",
      error: "session_file_missing",
      sessionFile: missingFile,
      record: { recordId: "missing-run" },
    });

    const invalid = handleAgentMessageTail(dirs, { runId: "invalid-run" }, context);
    expect(invalid.isError).toBe(true);
    expect(invalid.details).toMatchObject({
      action: "tail",
      error: "invalid_session_file",
      sessionFile: invalidFile,
      record: { recordId: "invalid-run" },
    });
  });

  test("agent_message accepts sessions, session, and tail actions", async () => {
    const tempDir = makeTempDir("collab-index-session-tool");
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = path.join(tempDir, "state");

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const agentMessageTool = harness.tools.get("agent_message");
    if (!agentMessageTool) throw new Error("agent_message tool was not registered");

    const ctx = makeContext(tempDir);
    const sessions = await agentMessageTool.execute("tool-call-sessions", { action: "sessions" }, undefined, undefined, ctx);
    expect(sessions.isError).toBeUndefined();
    expect(sessions.details).toMatchObject({ action: "sessions", records: [] });

    const session = await agentMessageTool.execute("tool-call-session", { action: "session" }, undefined, undefined, ctx);
    expect(session.isError).toBe(true);
    expect(session.details).toMatchObject({ action: "session", error: "not_found" });

    const tail = await agentMessageTool.execute("tool-call-tail", { action: "tail" }, undefined, undefined, ctx);
    expect(tail.isError).toBe(true);
    expect(tail.details).toMatchObject({ action: "tail", error: "not_found" });

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });
});

describe("subagent launch identity", () => {
  test("subagent tool returns batch/run ids and writes planned single-child records immediately", async () => {
    const tempDir = makeTempDir("collab-index-single");
    writeFakePiBinary(tempDir);
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = path.join(tempDir, "state");

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-1", { task: "Inspect the repo" }, undefined, undefined, ctx);

    expect(result.content[0]?.text).toContain("Batch ID:");
    expect(result.content[0]?.text).toContain("Run ID:");
    expect(result.content[0]?.text).toContain('agent_message({ action: "sessions" })');
    expect(result.details).toMatchObject({
      mode: "subagent",
      queued: true,
      background: true,
      launchMode: "single",
      taskCount: 1,
      childRunIds: [expect.any(String)],
    });

    const details = result.details as { batchRunId: string; childRunIds: string[] };
    expect(details.childRunIds).toEqual([`${details.batchRunId}-0`]);

    const records = listSubagentRunRecords({ base: process.env.COLLABORATING_AGENTS_DIR!, registry: "", inbox: "", messageLog: "", runs: path.join(process.env.COLLABORATING_AGENTS_DIR!, "runs") });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordId: details.childRunIds[0],
      batchRunId: details.batchRunId,
      taskIndex: 0,
      parentAgent: expect.any(String),
      parentSessionId: "parent-session",
      taskPreview: "Inspect the repo",
      cwd: tempDir,
      launchMode: "process",
    });
    expect(["launching", "running", "completed"]).toContain(records[0]?.status);

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("subagent tool reports all child run ids for parallel launches", async () => {
    const tempDir = makeTempDir("collab-index-parallel");
    writeFakePiBinary(tempDir);
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = path.join(tempDir, "state");

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute(
      "tool-call-2",
      { tasks: [{ task: "One" }, { task: "Two" }] },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0]?.text).toContain("Batch ID:");
    expect(result.content[0]?.text).toContain("Run IDs:");
    expect(result.details).toMatchObject({
      mode: "subagent",
      queued: true,
      background: true,
      launchMode: "parallel",
      taskCount: 2,
      childRunIds: [expect.any(String), expect.any(String)],
    });

    const details = result.details as { batchRunId: string; childRunIds: string[] };
    expect(details.childRunIds).toEqual([`${details.batchRunId}-0`, `${details.batchRunId}-1`]);

    const records = listSubagentRunRecords({ base: process.env.COLLABORATING_AGENTS_DIR!, registry: "", inbox: "", messageLog: "", runs: path.join(process.env.COLLABORATING_AGENTS_DIR!, "runs") });
    expect(records.map((record) => record.recordId).sort()).toEqual([...details.childRunIds].sort());

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("planned records use the actual fallback type when requested type is unknown", async () => {
    const tempDir = makeTempDir("collab-index-unknown-type");
    writeFakePiBinary(tempDir);
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = path.join(tempDir, "state");

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    await subagentTool.execute("tool-call-3", { task: "Inspect the repo", type: "missing-type" }, undefined, undefined, ctx);

    const records = listSubagentRunRecords({ base: process.env.COLLABORATING_AGENTS_DIR!, registry: "", inbox: "", messageLog: "", runs: path.join(process.env.COLLABORATING_AGENTS_DIR!, "runs") });
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe("worker");

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("updates subagent run record from launch through metadata and completion", async () => {
    const tempDir = makeTempDir("collab-index-lifecycle-success");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");
    const childSessionFile = path.join(tempDir, "child-session.jsonl");

    fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".pi", "agents", "worker.toml"),
      [
        'name = "worker"',
        'description = "Worker"',
        'model = "test/model"',
        'prompt = "Return concise findings."',
        "",
      ].join("\n"),
      "utf-8",
    );

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;
    process.env.TEST_PI_EXIT_DELAY_MS = "300";
    process.env.TEST_PI_REGISTER_SELF = "1";
    process.env.TEST_PI_REGISTER_SESSION_FILE = childSessionFile;

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-lifecycle", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { batchRunId: string; childRunIds: string[] };
    const recordId = details.childRunIds[0]!;

    const running = await waitForRunRecord(stateDir, recordId, (record) => record.status === "running" && !!record.name);
    expect(running).toMatchObject({
      recordId,
      batchRunId: details.batchRunId,
      status: "running",
      type: "worker",
      cwd: tempDir,
      launchMode: "process",
      model: "test/model",
    });
    expect(running.name?.startsWith("worker-")).toBe(true);
    expect(running.displayName).toBeString();

    const completed = await waitForRunRecord(stateDir, recordId, (record) => record.status === "completed");
    expect(completed).toMatchObject({
      recordId,
      status: "completed",
      sessionId: "fake-session",
      sessionFile: childSessionFile,
      exitCode: 0,
      outputPreview: "fake-ok",
      model: "test/model",
    });
    expect(completed.completedAt).toBeString();
    expect(Date.parse(completed.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(running.lastSeenAt));

    const completionMessage = await waitForCompletionMessage(harness);
    expect(String(completionMessage.content)).toContain("fake-ok");

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("marks subagent run records failed when the child process fails", async () => {
    const tempDir = makeTempDir("collab-index-lifecycle-failure");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;
    process.env.TEST_PI_FAIL_BEFORE_MESSAGE = "1";
    process.env.TEST_PI_EXIT_CODE = "2";
    process.env.TEST_PI_STDERR = "subagent exploded";

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-failure", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { childRunIds: string[] };
    const recordId = details.childRunIds[0]!;

    const failed = await waitForRunRecord(stateDir, recordId, (record) => record.status === "failed");
    expect(failed).toMatchObject({
      recordId,
      status: "failed",
      exitCode: 2,
      outputPreview: "subagent exploded",
    });
    expect(failed.completedAt).toBeString();

    const completionMessage = await waitForCompletionMessage(harness);
    expect(String(completionMessage.content)).toContain("subagent exploded");

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("records process-mode session file unavailability for downstream tail handlers", async () => {
    const tempDir = makeTempDir("collab-index-process-session-file-unavailable");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-process-unavailable", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { childRunIds: string[] };
    const recordId = details.childRunIds[0]!;

    const completed = await waitForRunRecord(stateDir, recordId, (record) => record.status === "completed");
    expect(completed).toMatchObject({
      recordId,
      sessionId: "fake-session",
      sessionFileUnavailableReason: "Process-mode session file unavailable until child registration or fallback discovery provides one.",
    });
    expect(completed.sessionFile).toBeUndefined();

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("fills missing completed run session file from session-id search without dropping concurrent metadata", async () => {
    const tempDir = makeTempDir("collab-index-lifecycle-fallback");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");
    const fallbackSessionFile = path.join(tempDir, ".pi", "agent", "sessions", "nested", "local_fake-session.jsonl");
    fs.mkdirSync(path.dirname(fallbackSessionFile), { recursive: true });
    fs.writeFileSync(fallbackSessionFile, "", "utf-8");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-fallback", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { childRunIds: string[] };
    const recordId = details.childRunIds[0]!;

    const completed = await waitForRunRecord(stateDir, recordId, (record) => record.status === "completed");
    expect(completed.sessionId).toBe("fake-session");
    expect(completed.sessionFile).toBe(fallbackSessionFile);
    const fallbackCompletionMessage = await waitForCompletionMessage(harness);
    const fallbackCompletionDetails = fallbackCompletionMessage.details as { result?: { sessionFile?: string; sessionFileUnavailableReason?: string } };
    expect(fallbackCompletionDetails.result?.sessionFile).toBe(fallbackSessionFile);
    expect(fallbackCompletionDetails.result?.sessionFileUnavailableReason).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const concurrentSessionFile = path.join(tempDir, "concurrent-session.jsonl");
    process.env.TEST_PI_SKIP_SESSION_EVENT = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "250";
    const second = await subagentTool.execute("tool-call-preserve", { task: "Inspect without session" }, undefined, undefined, ctx);
    const secondDetails = second.details as { childRunIds: string[] };
    const secondRecordId = secondDetails.childRunIds[0]!;
    await waitForRunRecord(stateDir, secondRecordId, (record) => record.status === "launching" || record.status === "running");
    expect(updateSubagentRunRecord(makeDirs(stateDir), secondRecordId, {
      sessionId: "concurrent-session",
      sessionFile: concurrentSessionFile,
    })).toBe(true);

    const preserved = await waitForRunRecord(stateDir, secondRecordId, (record) => record.status === "completed");
    expect(preserved.sessionId).toBe("concurrent-session");
    expect(preserved.sessionFile).toBe(concurrentSessionFile);

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("keeps subagent output flowing when lifecycle registry updates fail", async () => {
    const tempDir = makeTempDir("collab-index-lifecycle-write-failure");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;
    process.env.TEST_PI_EXIT_DELAY_MS = "250";

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-write-failure", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { childRunIds: string[] };
    const recordId = details.childRunIds[0]!;
    await waitForRunRecord(stateDir, recordId, (record) => record.status === "launching" || record.status === "running");

    fs.writeFileSync(path.join(stateDir, "runs", `${recordId}.json`), "{ invalid json", "utf-8");

    const completionMessage = await waitForCompletionMessage(harness);
    expect(String(completionMessage.content)).toContain("fake-ok");
    const completionDetails = completionMessage.details as {
      lifecycleWarnings?: string[];
      result?: { warnings?: string[] };
    };
    const warnings = [...(completionDetails.lifecycleWarnings ?? []), ...(completionDetails.result?.warnings ?? [])];
    expect(warnings.some((warning) => warning.includes("Failed to update subagent run record"))).toBe(true);

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });

  test("keeps subagent output flowing when lifecycle registry updates throw", async () => {
    const tempDir = makeTempDir("collab-index-lifecycle-throwing-write");
    writeFakePiBinary(tempDir);
    const stateDir = path.join(tempDir, "state");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;
    process.env.TEST_PI_EXIT_DELAY_MS = "250";

    const harness = makeHarness();
    collaboratingAgentsExtension(harness.pi);
    const subagentTool = harness.tools.get("subagent");
    if (!subagentTool) throw new Error("subagent tool was not registered");

    const ctx = makeContext(tempDir);
    const result = await subagentTool.execute("tool-call-throwing-write", { task: "Inspect the repo" }, undefined, undefined, ctx);
    const details = result.details as { childRunIds: string[] };
    const recordId = details.childRunIds[0]!;
    await waitForRunRecord(stateDir, recordId, (record) => record.status === "launching" || record.status === "running");

    fs.rmSync(path.join(stateDir, "runs"), { recursive: true, force: true });
    fs.writeFileSync(path.join(stateDir, "runs"), "not a directory", "utf-8");

    const completionMessage = await waitForCompletionMessage(harness);
    expect(String(completionMessage.content)).toContain("fake-ok");
    const completionDetails = completionMessage.details as { lifecycleWarnings?: string[] };
    expect(completionDetails.lifecycleWarnings?.some((warning) => warning.includes("Failed to update subagent run record"))).toBe(true);

    await Promise.all((harness.handlers.get("session_shutdown") ?? []).map((handler) => handler(undefined, ctx)));
  });
});
