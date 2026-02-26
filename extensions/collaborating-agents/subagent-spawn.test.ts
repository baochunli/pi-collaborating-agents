import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnAgentDefinition } from "./subagent-spawn.ts";
import { runSpawnTask } from "./subagent-spawn.ts";

const tempDirs: string[] = [];
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_ARGS_FILE = process.env.TEST_ARGS_FILE;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeFakePiBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "pi");
  const argsFile = path.join(dir, "captured-args.json");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argsFile = process.env.TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)), "utf-8");
}

process.stdout.write(JSON.stringify({ type: "session", id: "fake-session" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "fake-ok" }],
  },
}) + "\\n");
process.exit(0);
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
});
