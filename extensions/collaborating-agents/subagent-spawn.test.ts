import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnAgentDefinition } from "./subagent-spawn.ts";
import {
  discoverSpawnAgents,
  mapWithConcurrencyLimit,
  resetCmuxLayoutStateForTests,
  resolveSpawnAgentDefinition,
  runSpawnTask,
} from "./subagent-spawn.ts";

const tempDirs: string[] = [];
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_ARGS_FILE = process.env.TEST_ARGS_FILE;
const ORIGINAL_TEST_CMUX_ARGS_FILE = process.env.TEST_CMUX_ARGS_FILE;
const ORIGINAL_TEST_CMUX_SEND_ASYNC = process.env.TEST_CMUX_SEND_ASYNC;
const ORIGINAL_TEST_CMUX_SEND_TRUNCATE_AT = process.env.TEST_CMUX_SEND_TRUNCATE_AT;
const ORIGINAL_TEST_PI_EXIT_DELAY_MS = process.env.TEST_PI_EXIT_DELAY_MS;
const ORIGINAL_TEST_CMUX_CLOSE_FAIL = process.env.TEST_CMUX_CLOSE_FAIL;
const ORIGINAL_TEST_PI_EXIT_CODE = process.env.TEST_PI_EXIT_CODE;
const ORIGINAL_TEST_PI_MULTI_TURN = process.env.TEST_PI_MULTI_TURN;
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
  fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "fake-session" }) + "\\n", "utf-8");

  if (process.env.TEST_PI_MULTI_TURN === "1") {
    setTimeout(() => {
      fs.appendFileSync(sessionPath, JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fake-intermediate" }],
          stopReason: "stop",
        },
      }) + "\\n", "utf-8");
    }, 20);

    setTimeout(() => {
      fs.appendFileSync(sessionPath, JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }],
          stopReason: "toolUse",
        },
      }) + "\\n", "utf-8");
    }, 220);

    setTimeout(() => {
      fs.appendFileSync(sessionPath, JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
        },
      }) + "\\n", "utf-8");
    }, 420);

    setTimeout(() => {
      fs.appendFileSync(sessionPath, JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fake-final" }],
          stopReason: "stop",
        },
      }) + "\\n", "utf-8");
    }, 620);
  } else {
    fs.appendFileSync(sessionPath, JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake-ok" }],
        stopReason: "stop",
      },
    }) + "\\n", "utf-8");
  }
}

const delayMs = Number(process.env.TEST_PI_EXIT_DELAY_MS || "0");
const exitCode = Number(process.env.TEST_PI_EXIT_CODE || "0");
const finish = () => {
  process.stdout.write("fake-text-mode\\n");
  process.exit(exitCode);
};

if (delayMs > 0) {
  setTimeout(finish, delayMs);
} else {
  finish();
}
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
const stateFile = argsFile ? argsFile + ".state.json" : null;
if (argsFile) {
  fs.appendFileSync(argsFile, JSON.stringify(process.argv.slice(2)) + "\\n", "utf-8");
}

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) {
    return {
      nextRef: 99,
      panes: {
        "pane:2": ["surface:2"],
      },
      surfaceToPane: { "surface:2": "pane:2" },
    };
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return {
      nextRef: 99,
      panes: {
        "pane:2": ["surface:2"],
      },
      surfaceToPane: { "surface:2": "pane:2" },
    };
  }
}

function writeState(state) {
  if (!stateFile) return;
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");
}

function removeSurfaceFromPane(state, paneRef, surfaceRef) {
  const pane = state.panes[paneRef];
  if (!Array.isArray(pane)) return;
  state.panes[paneRef] = pane.filter((value) => value !== surfaceRef);
  if (state.panes[paneRef].length === 0) delete state.panes[paneRef];
}

function addSurfaceToPane(state, paneRef, surfaceRef) {
  const pane = Array.isArray(state.panes[paneRef]) ? state.panes[paneRef] : [];
  state.panes[paneRef] = pane.filter((value) => value !== surfaceRef);
  state.panes[paneRef].push(surfaceRef);
  state.surfaceToPane[surfaceRef] = paneRef;
}

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--json" ? rawArgs.slice(1) : rawArgs;
if (args[0] === "identify") {
  const state = readState();
  const surfaceIndex = args.indexOf("--surface");
  const targetSurface = surfaceIndex >= 0 ? args[surfaceIndex + 1] : "surface:2";
  const paneRef = state.surfaceToPane[targetSurface] || "pane:2";
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
  const state = readState();
  const paneIndex = args.indexOf("--panel");
  const paneRef = paneIndex >= 0 ? args[paneIndex + 1] : null;
  const surfaceIndex = args.indexOf("--surface");
  const surfaceRefFromArgs = surfaceIndex >= 0 ? args[surfaceIndex + 1] : null;
  if (paneRef && !state.panes[paneRef]) {
    process.stderr.write("unknown pane\\n");
    process.exit(1);
  }
  if (surfaceRefFromArgs && !state.surfaceToPane[surfaceRefFromArgs]) {
    process.stderr.write("unknown surface\\n");
    process.exit(1);
  }
  const ref = state.nextRef || 99;
  const paneRefOut = "pane:" + ref;
  const surfaceRef = "surface:" + ref;
  state.nextRef = ref + 1;
  state.panes[paneRefOut] = [surfaceRef];
  state.surfaceToPane[surfaceRef] = paneRefOut;
  writeState(state);
  process.stdout.write("OK " + surfaceRef + " workspace:77\\n");
  process.exit(0);
}

if (args[0] === "list-panes") {
  const state = readState();
  const paneRefs = Object.keys(state.panes).sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
  process.stdout.write(JSON.stringify({ panes: paneRefs.map((paneRef) => ({ pane_ref: paneRef })) }));
  process.exit(0);
}

if (args[0] === "list-pane-surfaces") {
  const state = readState();
  const paneIndex = args.indexOf("--pane");
  const paneRef = paneIndex >= 0 ? args[paneIndex + 1] : "pane:2";
  const surfaceRefs = Array.isArray(state.panes[paneRef]) ? state.panes[paneRef] : [];
  process.stdout.write(JSON.stringify({ surfaces: surfaceRefs.map((surfaceRef) => ({ surface_ref: surfaceRef })) }));
  process.exit(0);
}

if (args[0] === "move-surface") {
  const state = readState();
  const surfaceIndex = args.indexOf("--surface");
  const targetSurface = surfaceIndex >= 0 ? args[surfaceIndex + 1] : null;
  const paneIndex = args.indexOf("--pane");
  const targetPane = paneIndex >= 0 ? args[paneIndex + 1] : null;

  if (!targetSurface || !targetPane) {
    process.stderr.write("missing move target\\n");
    process.exit(1);
  }

  const currentPane = state.surfaceToPane[targetSurface];
  if (currentPane) removeSurfaceFromPane(state, currentPane, targetSurface);
  addSurfaceToPane(state, targetPane, targetSurface);
  writeState(state);
  process.stdout.write("OK\\n");
  process.exit(0);
}

if (args[0] === "reorder-surface") {
  const state = readState();
  const surfaceIndex = args.indexOf("--surface");
  const targetSurface = surfaceIndex >= 0 ? args[surfaceIndex + 1] : null;
  const beforeIndex = args.indexOf("--before");
  const beforeSurface = beforeIndex >= 0 ? args[beforeIndex + 1] : null;

  if (!targetSurface || !beforeSurface) {
    process.stderr.write("missing reorder target\\n");
    process.exit(1);
  }

  const paneRef = state.surfaceToPane[targetSurface];
  const beforePaneRef = state.surfaceToPane[beforeSurface];
  if (!paneRef || !beforePaneRef || paneRef !== beforePaneRef) {
    process.stderr.write("surfaces not colocated\\n");
    process.exit(1);
  }

  const pane = Array.isArray(state.panes[paneRef]) ? state.panes[paneRef].filter((value) => value !== targetSurface) : [];
  const beforePos = pane.indexOf(beforeSurface);
  if (beforePos < 0) {
    pane.push(targetSurface);
  } else {
    pane.splice(beforePos, 0, targetSurface);
  }
  state.panes[paneRef] = pane;
  writeState(state);
  process.stdout.write("OK\\n");
  process.exit(0);
}

if (args[0] === "send") {
  let command = args[args.length - 1] || "";
  const truncateAt = Number(process.env.TEST_CMUX_SEND_TRUNCATE_AT || "0");
  if (Number.isFinite(truncateAt) && truncateAt > 0 && command.length > truncateAt) {
    command = command.slice(0, truncateAt);
  }
  if (process.env.TEST_CMUX_SEND_ASYNC === "1") {
    const child = cp.spawn("/bin/bash", ["-lc", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    process.stdout.write("OK\\n");
    process.exit(0);
  }

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
  const state = readState();
  const surfaceIndex = args.indexOf("--surface");
  const targetSurface = surfaceIndex >= 0 ? args[surfaceIndex + 1] : null;
  if (process.env.TEST_CMUX_CLOSE_FAIL === "1") {
    process.stderr.write("close failed\\n");
    process.exit(1);
  }
  if (targetSurface) {
    const paneRef = state.surfaceToPane[targetSurface];
    if (paneRef) removeSurfaceFromPane(state, paneRef, targetSurface);
    delete state.surfaceToPane[targetSurface];
  }
  writeState(state);
  process.stdout.write("OK\\n");
  process.exit(0);
}

process.stderr.write("unsupported cmux command");
process.exit(2);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

function readFakeCmuxState(argsFile: string): {
  nextRef: number;
  panes: Record<string, string[]>;
  surfaceToPane: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(`${argsFile}.state.json`, "utf-8"));
}

function writeFakeCmuxState(
  argsFile: string,
  state: {
    nextRef: number;
    panes: Record<string, string[]>;
    surfaceToPane: Record<string, string>;
  },
): void {
  fs.writeFileSync(`${argsFile}.state.json`, JSON.stringify(state), "utf-8");
}

function getCapturedCmuxArgs(argsFile: string): string[][] {
  return fs
    .readFileSync(argsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function getCmuxCommandName(entry: string[]): string {
  return entry[0] === "--json" ? entry[1] ?? "--json" : entry[0] ?? "";
}

function getCmuxCommandNames(entries: string[][]): string[] {
  return entries.map(getCmuxCommandName);
}

afterEach(() => {
  resetCmuxLayoutStateForTests();

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

  if (typeof ORIGINAL_TEST_CMUX_SEND_ASYNC === "string") {
    process.env.TEST_CMUX_SEND_ASYNC = ORIGINAL_TEST_CMUX_SEND_ASYNC;
  } else {
    delete process.env.TEST_CMUX_SEND_ASYNC;
  }

  if (typeof ORIGINAL_TEST_CMUX_SEND_TRUNCATE_AT === "string") {
    process.env.TEST_CMUX_SEND_TRUNCATE_AT = ORIGINAL_TEST_CMUX_SEND_TRUNCATE_AT;
  } else {
    delete process.env.TEST_CMUX_SEND_TRUNCATE_AT;
  }

  if (typeof ORIGINAL_TEST_PI_EXIT_DELAY_MS === "string") {
    process.env.TEST_PI_EXIT_DELAY_MS = ORIGINAL_TEST_PI_EXIT_DELAY_MS;
  } else {
    delete process.env.TEST_PI_EXIT_DELAY_MS;
  }

  if (typeof ORIGINAL_TEST_CMUX_CLOSE_FAIL === "string") {
    process.env.TEST_CMUX_CLOSE_FAIL = ORIGINAL_TEST_CMUX_CLOSE_FAIL;
  } else {
    delete process.env.TEST_CMUX_CLOSE_FAIL;
  }

  if (typeof ORIGINAL_TEST_PI_EXIT_CODE === "string") {
    process.env.TEST_PI_EXIT_CODE = ORIGINAL_TEST_PI_EXIT_CODE;
  } else {
    delete process.env.TEST_PI_EXIT_CODE;
  }

  if (typeof ORIGINAL_TEST_PI_MULTI_TURN === "string") {
    process.env.TEST_PI_MULTI_TURN = ORIGINAL_TEST_PI_MULTI_TURN;
  } else {
    delete process.env.TEST_PI_MULTI_TURN;
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
    expect(result.cmuxPaneClosed).toBe(true);
    expect(result.cmuxCloseError).toBeUndefined();

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
      "close-surface",
    ]);

    const splitArgs = capturedCmuxArgs[3]!;
    expect(splitArgs[1]).toBe("right");
    expect(splitArgs).toContain("--workspace");
    expect(splitArgs).toContain("--panel");
    expect(splitArgs).toContain("pane:2");

    const sendArgs = capturedCmuxArgs[5]!;
    expect(sendArgs).toContain("--workspace");
    expect(sendArgs).toContain("workspace:77");
    expect(sendArgs).toContain("--surface");
    expect(sendArgs).toContain("surface:99");
    expect(sendArgs[sendArgs.length - 1]).toContain("bash ");
    expect(sendArgs[sendArgs.length - 1]).not.toContain("--mode json -p");

    const capturedPiArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedPiArgs).toContain("--session");
    expect(capturedPiArgs[capturedPiArgs.length - 1]).toBe("Inspect the repository");

    const closeArgs = capturedCmuxArgs[10]!;
    expect(closeArgs).toEqual(["close-surface", "--surface", "surface:99"]);
  });

  test("waits for the latest settled assistant message before closing a cmux pane", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-settled-output");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_SEND_ASYNC = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";
    process.env.TEST_PI_MULTI_TURN = "1";

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
        runId: "testrun4-settled",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-final");
    expect(result.cmuxPaneClosed).toBe(true);

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
      "close-surface",
    ]);
  });

  test("can keep completed cmux panes open when auto-close is disabled", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-no-close");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_SEND_ASYNC = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const startedAt = Date.now();
    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun5",
        recursionDepth: 0,
        launchMode: "cmux-pane",
        closeCompletedCmuxPane: false,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(2400);
    expect(result.exitCode).toBe(0);
    expect(result.cmuxPaneClosed).toBeUndefined();
    expect(result.cmuxCloseError).toBeUndefined();

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
    ]);
  });

  test("uses a short script-backed cmux send command so long prompts survive send truncation", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-script-send");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_SEND_TRUNCATE_AT = "120";

    const longTask = [
      "Read this filler but ultimately reply with exactly: script-ok",
      "",
      "FILLER START",
      ...new Array(40).fill("Repeat: 1234567890 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ."),
      "FILLER END",
    ].join("\n");

    const agentDef: SpawnAgentDefinition = {
      name: "reviewer",
      description: "Reviewer",
      systemPrompt: "Return concise findings and finish with the requested exact text.",
      source: "bundled",
      filePath: "/tmp/reviewer.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "reviewer",
        task: longTask,
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-script-send",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    const sendArgs = capturedCmuxArgs.find((entry) => getCmuxCommandName(entry) === "send");
    expect(sendArgs).toBeDefined();
    expect((sendArgs![sendArgs!.length - 1] ?? "").length).toBeLessThan(120);

    const capturedPiArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedPiArgs).toContain("--session");
    expect(capturedPiArgs[capturedPiArgs.length - 1]).toBe(longTask);
  });

  test("rebalances sequential cmux-pane spawns and alternates split directions toward a grid", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-layout");
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

    for (let index = 0; index < 3; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        {
          agent: "worker",
          task: `Inspect repository ${index}`,
        },
        agentDef,
        {
          index,
          runId: `testrun-layout-${index}`,
          recursionDepth: 0,
          launchMode: "cmux-pane",
          closeCompletedCmuxPane: false,
        },
      );

      expect(result.exitCode).toBe(0);
    }

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);

    const splitCommands = capturedCmuxArgs.filter((entry) => entry[0] === "new-split");
    const splitTargets = splitCommands.map((entry) => entry[entry.indexOf("--panel") + 1]);
    const splitDirections = splitCommands.map((entry) => entry[1]);

    expect(splitTargets).toEqual(["pane:2", "pane:99", "pane:2"]);
    expect(splitDirections).toEqual(["right", "down", "down"]);
  });

  test("removes auto-closed cmux panes from the layout planner before the next spawn", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-layout-close");
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

    for (let index = 0; index < 2; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        {
          agent: "worker",
          task: `Inspect repository ${index}`,
        },
        agentDef,
        {
          index,
          runId: `testrun-layout-close-${index}`,
          recursionDepth: 0,
          launchMode: "cmux-pane",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.cmuxPaneClosed).toBe(true);
    }

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);

    const splitTargets = capturedCmuxArgs
      .filter((entry) => entry[0] === "new-split")
      .map((entry) => entry[entry.indexOf("--panel") + 1]);

    expect(splitTargets).toEqual(["pane:2", "pane:2"]);
  });

  test("true rebalance moves swapped managed surfaces back into their planned panes", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-true-rebalance");
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

    const first = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 0",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-true-rebalance-0",
        recursionDepth: 0,
        launchMode: "cmux-pane",
        closeCompletedCmuxPane: false,
      },
    );
    expect(first.exitCode).toBe(0);

    const state = readFakeCmuxState(cmuxArgsFile);
    state.panes = {
      "pane:2": ["surface:99"],
      "pane:99": ["surface:2"],
    };
    state.surfaceToPane = {
      "surface:2": "pane:99",
      "surface:99": "pane:2",
    };
    writeFakeCmuxState(cmuxArgsFile, state);

    const second = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 1",
      },
      agentDef,
      {
        index: 1,
        runId: "testrun-true-rebalance-1",
        recursionDepth: 0,
        launchMode: "cmux-pane",
        closeCompletedCmuxPane: false,
      },
    );
    expect(second.exitCode).toBe(0);

    const finalState = readFakeCmuxState(cmuxArgsFile);
    expect(finalState.surfaceToPane["surface:2"]).toBe("pane:2");
    expect(finalState.surfaceToPane["surface:99"]).toBe("pane:99");

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    const commandNames = getCmuxCommandNames(capturedCmuxArgs);
    expect(commandNames).toContain("move-surface");
    expect(commandNames).toContain("reorder-surface");

    const moveCommands = capturedCmuxArgs.filter((entry) => getCmuxCommandName(entry) === "move-surface");
    expect(moveCommands).toEqual([
      ["move-surface", "--workspace", "workspace:77", "--surface", "surface:2", "--pane", "pane:2"],
      ["move-surface", "--workspace", "workspace:77", "--surface", "surface:99", "--pane", "pane:99"],
    ]);
  });

  test("snapshot sync drops manually closed panes before choosing the next split target", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-snapshot-sync");
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

    const first = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 0",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-snapshot-sync-0",
        recursionDepth: 0,
        launchMode: "cmux-pane",
        closeCompletedCmuxPane: false,
      },
    );
    expect(first.exitCode).toBe(0);

    const state = readFakeCmuxState(cmuxArgsFile);
    delete state.panes["pane:99"];
    delete state.surfaceToPane["surface:99"];
    writeFakeCmuxState(cmuxArgsFile, state);

    const second = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 1",
      },
      agentDef,
      {
        index: 1,
        runId: "testrun-snapshot-sync-1",
        recursionDepth: 0,
        launchMode: "cmux-pane",
        closeCompletedCmuxPane: false,
      },
    );
    expect(second.exitCode).toBe(0);

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    const splitTargets = capturedCmuxArgs
      .filter((entry) => getCmuxCommandName(entry) === "new-split")
      .map((entry) => entry[entry.indexOf("--panel") + 1]);

    expect(splitTargets).toEqual(["pane:2", "pane:2"]);
  });

  test("auto-closes after turn-finished output plus idle grace even if pane process stays open longer", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-idle-grace-close");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_SEND_ASYNC = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "2500";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const startedAt = Date.now();
    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun6",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(2400);
    expect(result.exitCode).toBe(0);
    expect(result.cmuxPaneClosed).toBe(true);

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
      "close-surface",
    ]);
  });

  test("keeps pane open when process exits non-zero during idle grace after emitting final output", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-nonzero-after-output");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_SEND_ASYNC = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "150";
    process.env.TEST_PI_EXIT_CODE = "7";

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
        runId: "testrun7",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    expect(result.exitCode).toBe(7);
    expect(result.cmuxPaneClosed).toBeUndefined();
    expect(result.error).toContain("exited with code 7");

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
    ]);
  });

  test("reports close failure without treating the successful cmux-pane subagent as failed", async () => {
    const tempDir = makeTempDir("collab-subagent-cmux-pane-close-fails");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: cmuxArgsFile } = writeFakeCmuxBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_CMUX_ARGS_FILE = cmuxArgsFile;
    process.env.TEST_CMUX_CLOSE_FAIL = "1";

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
        runId: "testrun8",
        recursionDepth: 0,
        launchMode: "cmux-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.cmuxPaneClosed).toBeUndefined();
    expect(result.cmuxCloseError).toContain("close failed");

    const capturedCmuxArgs = getCapturedCmuxArgs(cmuxArgsFile);
    expect(getCmuxCommandNames(capturedCmuxArgs)).toEqual([
      "identify",
      "list-panes",
      "list-pane-surfaces",
      "new-split",
      "identify",
      "send",
      "list-panes",
      "list-pane-surfaces",
      "list-pane-surfaces",
      "identify",
      "close-surface",
    ]);
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
