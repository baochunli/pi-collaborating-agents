import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnAgentDefinition } from "./subagent-spawn.ts";
import {
  discoverSpawnAgents,
  mapWithConcurrencyLimit,
  resolveSpawnAgentDefinition,
  runSpawnTask,
} from "./subagent-spawn.ts";

const tempDirs: string[] = [];
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_ARGS_FILE = process.env.TEST_ARGS_FILE;
const ORIGINAL_TEST_CMUX_ARGS_FILE = process.env.TEST_CMUX_ARGS_FILE;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

function writeAgentMarkdown(
  dir: string,
  fileName: string,
  options: {
    name?: string;
    description?: string;
    model?: string;
    tools?: string;
    promptBody?: string;
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    options.name ? `name: ${options.name}` : undefined,
    options.description ? `description: ${options.description}` : undefined,
    options.model ? `model: ${options.model}` : undefined,
    options.tools ? `tools: ${options.tools}` : undefined,
    "---",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const content = `${frontmatter}\n\n${options.promptBody ?? "Agent prompt"}\n`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writeFakePiBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "pi");
  const argsFile = path.join(dir, "captured-args.json");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const argsFile = process.env.TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(args), "utf-8");
}

const sessionIndex = args.indexOf("--session");
const sessionPath = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;

if (args.includes("--mode") && args.includes("json")) {
  process.stdout.write(JSON.stringify({ type: "session", id: "fake-session" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "fake-ok" }],
    },
  }) + "\\n");
  process.exit(0);
}

if (sessionPath) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", id: "fake-session" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake-ok" }],
        stopReason: "stop",
      },
    }),
    "",
  ].join("\\n"), "utf-8");
}

process.stdout.write("fake-text-mode\\n");
process.exit(0);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

function writeFailingFakePiBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "pi");
  const argsFile = path.join(dir, "captured-args.json");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argsFile = process.env.TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)), "utf-8");
}

process.stderr.write("subagent crashed");
process.exit(2);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

function writeFakeCmuxBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "cmux");
  const argsFile = path.join(dir, "captured-cmux-args.jsonl");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");

const argsFile = process.env.TEST_CMUX_ARGS_FILE;
if (argsFile) {
  fs.appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + "\\n", "utf-8");
}

const args = process.argv.slice(2);
if (args[0] === "identify") {
  const surfaceIndex = args.indexOf("--surface");
  const targetSurface = surfaceIndex >= 0 ? args[surfaceIndex + 1] : "surface:2";
  const paneRef = targetSurface === "surface:99" ? "pane:99" : "pane:2";
  process.stdout.write(JSON.stringify({
    caller: {
      workspace_ref: "workspace:77",
      pane_ref: paneRef,
      surface_ref: targetSurface,
    },
  }));
  process.exit(0);
}

if (args[0] === "new-split") {
  process.stdout.write("OK surface:99 workspace:77\\n");
  process.exit(0);
}

if (args[0] === "send") {
  const command = args[args.length - 1] || "";
  const result = cp.spawnSync("/bin/bash", ["-lc", command], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(String(result.error));
    process.exit(1);
  }

  process.stdout.write("OK\\n");
  process.exit(result.status ?? 0);
}

if (args[0] === "close-surface") {
  process.stdout.write("OK\\n");
  process.exit(0);
}

process.stderr.write("unsupported cmux command");
process.exit(2);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof ORIGINAL_PATH === "string") {
    process.env.PATH = ORIGINAL_PATH;
  } else {
    delete process.env.PATH;
  }

  if (typeof ORIGINAL_TEST_ARGS_FILE === "string") {
    process.env.TEST_ARGS_FILE = ORIGINAL_TEST_ARGS_FILE;
  } else {
    delete process.env.TEST_ARGS_FILE;
  }

  if (typeof ORIGINAL_TEST_CMUX_ARGS_FILE === "string") {
    process.env.TEST_CMUX_ARGS_FILE = ORIGINAL_TEST_CMUX_ARGS_FILE;
  } else {
    delete process.env.TEST_CMUX_ARGS_FILE;
  }

  if (typeof ORIGINAL_HOME === "string") {
    process.env.HOME = ORIGINAL_HOME;
  } else {
    delete process.env.HOME;
  }

  if (typeof ORIGINAL_USERPROFILE === "string") {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  } else {
    delete process.env.USERPROFILE;
  }
});

describe("subagent spawn", () => {
  test("passes type prompt via --append-system-prompt and redacts it in launch details", async () => {
    const tempDir = makeTempDir("collab-subagent-spawn");
    const { binPath, argsFile } = writeFakePiBinary(tempDir);

    expect(fs.existsSync(binPath)).toBe(true);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const typePrompt = "You are a scout. Return concise findings.";
    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: typePrompt,
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun1",
        recursionDepth: 0,
        enableSessionControl: false,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    const appendFlagIndex = capturedArgs.indexOf("--append-system-prompt");
    expect(appendFlagIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[appendFlagIndex + 1]).toBe(typePrompt);

    const runtimeTaskPrompt = capturedArgs[capturedArgs.length - 1];
    expect(runtimeTaskPrompt).toBe("Find all TypeScript files");
    expect(runtimeTaskPrompt).not.toContain("Do not send a mandatory final summary message");

    const launchAppendFlagIndex = result.launchArgs.indexOf("--append-system-prompt");
    expect(launchAppendFlagIndex).toBeGreaterThanOrEqual(0);
    expect(result.launchArgs[launchAppendFlagIndex + 1]).toBe(`<subagent-type-prompt:${typePrompt.length} chars>`);

    expect(result.launchCommand).toContain("--append-system-prompt");
    expect(result.launchCommand).toContain(`<subagent-type-prompt:${typePrompt.length} chars>`);
    expect(result.launchCommand).not.toContain(typePrompt);

    expect(result.launchSystemPromptSource).toBe("/tmp/scout.toml");
    expect(result.launchSystemPromptLength).toBe(typePrompt.length);
  });

  test("omits append-system-prompt for blank type prompt and wraps task with parent context", async () => {
    const tempDir = makeTempDir("collab-subagent-parent-context");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "doc-helper",
      description: "Doc helper",
      systemPrompt: "   \n\t",
      source: "user",
      filePath: "/tmp/doc-helper.md",
      tools: ["agent_message"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "doc-helper",
        task: "Write docs",
      },
      agentDef,
      {
        index: 1,
        runId: "testrun2",
        recursionDepth: 2,
        parentAgentName: "RapidRiver",
      },
    );

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs.includes("--append-system-prompt")).toBe(false);
    expect(capturedArgs.includes("--tools")).toBe(false);

    const expectedPrompt = "Parent agent: RapidRiver\n\nWrite docs";
    expect(capturedArgs[capturedArgs.length - 1]).toBe(expectedPrompt);
    expect(result.launchPrompt).toBe(expectedPrompt);
    expect(result.coordinator).toBe("RapidRiver");

    expect(result.launchSystemPromptSource).toBeUndefined();
    expect(result.launchSystemPromptLength).toBeUndefined();
  });

  test("returns stderr as output and sets error on non-zero exit when no assistant message is emitted", async () => {
    const tempDir = makeTempDir("collab-subagent-stderr-fallback");
    writeFailingFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;

    const agentDef: SpawnAgentDefinition = {
      name: "broken",
      description: "Broken",
      systemPrompt: "Return status",
      source: "bundled",
      filePath: "/tmp/broken.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "broken",
        task: "Run",
      },
      agentDef,
      {
        index: 2,
        runId: "testrun3",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toBe("subagent crashed");
    expect(result.error).toBe("subagent crashed");
  });

  test("can launch a subagent in a visible cmux pane and still collect final session output", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.launchMode).toBe("cmux-pane");
    expect(result.cmuxWorkspaceRef).toBe("workspace:77");
    expect(result.cmuxPaneRef).toBe("pane:99");
    expect(result.cmuxSurfaceRef).toBe("surface:99");

    const capturedCmuxArgs = fs
      .readFileSync(cmuxArgsFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(capturedCmuxArgs.map((entry) => entry[0])).toEqual(["identify", "new-split", "identify", "send"]);

    const splitArgs = capturedCmuxArgs[1]!;
    expect(splitArgs[1]).toBe("right");
    expect(splitArgs).toContain("--workspace");
    expect(splitArgs).toContain("--surface");

    const sendArgs = capturedCmuxArgs[3]!;
    expect(sendArgs).toContain("--workspace");
    expect(sendArgs).toContain("workspace:77");
    expect(sendArgs).toContain("--surface");
    expect(sendArgs).toContain("surface:99");
    expect(sendArgs[sendArgs.length - 1]).toContain("pi --session");
    expect(sendArgs[sendArgs.length - 1]).not.toContain("--mode json -p");

    const capturedPiArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedPiArgs).toContain("--session");
    expect(capturedPiArgs[capturedPiArgs.length - 1]).toBe("Inspect the repository");
  });
});

describe("spawn agent discovery", () => {
  test("project agents override user agents and malformed files are ignored", () => {
    const homeDir = makeTempDir("collab-spawn-agents-home");
    setHome(homeDir);

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "reviewer.md", {
      name: "reviewer",
      description: "User reviewer",
      model: "gpt-5",
      tools: "read, bash",
      promptBody: "User reviewer prompt",
    });

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "invalid.md", {
      name: "invalid",
      promptBody: "Missing description",
    });

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "skip.chain.md", {
      name: "skip",
      description: "Should be skipped",
    });

    const projectRoot = makeTempDir("collab-spawn-agents-project");
    writeAgentMarkdown(path.join(projectRoot, ".pi", "agents"), "reviewer.md", {
      name: "reviewer",
      description: "Project reviewer",
      tools: "read,write",
      promptBody: "Project reviewer prompt",
    });

    writeAgentMarkdown(path.join(projectRoot, ".pi", "agents"), "writer.md", {
      name: "writer",
      description: "Project writer",
      model: "gpt-4.1",
      tools: "read, bash ,edit",
      promptBody: "Writer prompt",
    });

    const nestedCwd = path.join(projectRoot, "packages", "api");
    fs.mkdirSync(nestedCwd, { recursive: true });

    const discovered = discoverSpawnAgents(nestedCwd);

    expect(discovered.map((a) => a.name)).toEqual(["reviewer", "writer"]);

    const reviewer = discovered.find((a) => a.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.source).toBe("project");
    expect(reviewer?.description).toBe("Project reviewer");
    expect(reviewer?.tools).toEqual(["read", "write"]);

    const writer = discovered.find((a) => a.name === "writer");
    expect(writer).toBeDefined();
    expect(writer?.source).toBe("project");
    expect(writer?.model).toBe("gpt-4.1");
    expect(writer?.tools).toEqual(["read", "bash", "edit"]);
  });
});

describe("spawn agent resolution", () => {
  test("returns ambiguous suggestions when requested suffix matches multiple agent names", () => {
    const available: SpawnAgentDefinition[] = [
      {
        name: "frontend-reviewer",
        description: "Frontend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/frontend.md",
      },
      {
        name: "backend-reviewer",
        description: "Backend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/backend.md",
      },
      {
        name: "security-auditor",
        description: "Security auditor",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/security.md",
      },
    ];

    const resolved = resolveSpawnAgentDefinition("reviewer", available);

    expect(resolved.definition).toBeUndefined();
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.suggestions).toEqual(["frontend-reviewer", "backend-reviewer"]);
  });

  test("normalizes underscores and spaces for exact-name resolution", () => {
    const available: SpawnAgentDefinition[] = [
      {
        name: "backend-reviewer",
        description: "Backend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/backend.md",
      },
    ];

    const resolved = resolveSpawnAgentDefinition(" backend_reviewer ", available);

    expect(resolved.definition?.name).toBe("backend-reviewer");
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.suggestions).toEqual(["backend-reviewer"]);
  });
});

describe("concurrency-limited mapping", () => {
  test("preserves output order even when work completes out of order", async () => {
    const values = [10, 40, 5, 25];

    const outputs = await mapWithConcurrencyLimit(values, 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return `done-${value}`;
    });

    expect(outputs).toEqual(["done-10", "done-40", "done-5", "done-25"]);
  });
});
