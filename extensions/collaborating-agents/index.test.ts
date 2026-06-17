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
import collaboratingAgentsExtension from "./index.ts";
import { listSubagentRunRecords, updateSubagentRunRecord } from "./store.ts";
import type { Dirs, SubagentRunListRecord } from "./types.ts";

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

function listRecords(stateDir: string): SubagentRunListRecord[] {
  return listSubagentRunRecords(makeDirs(stateDir));
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
