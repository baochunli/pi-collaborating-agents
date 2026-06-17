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
import { listSubagentRunRecords } from "./store.ts";

const tempDirs: string[] = [];
const ORIGINAL_COLLAB_DIR = process.env.COLLABORATING_AGENTS_DIR;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

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
process.stdout.write(JSON.stringify({ type: "session", id: "fake-session" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "fake-ok" }] }
}) + "\\n");
`,
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);
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
      status: "launching",
      launchMode: "process",
    });
    expect(records[0]?.name).toBeUndefined();
    expect(records[0]?.displayName).toBeUndefined();

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
});
