import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSubagentTypes, getDefaultSubagentType } from "./subagent-types.ts";

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_BUNDLED_SUBAGENTS_DIR = process.env.COLLABORATING_AGENTS_BUNDLED_SUBAGENTS_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

function writeTypeConfig(
  dir: string,
  fileName: string,
  options: {
    name: string;
    description: string;
    prompt?: string;
    model?: string;
    reasoning?: "low" | "medium" | "high" | "xhigh";
  },
): string {
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `name = "${options.name}"`,
    `description = "${options.description}"`,
    options.model ? `model = "${options.model}"` : undefined,
    options.reasoning ? `reasoning = "${options.reasoning}"` : undefined,
    `prompt = """${options.prompt ?? `${options.name} prompt`}"""`,
  ].filter((line): line is string => Boolean(line));

  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
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

  if (typeof ORIGINAL_BUNDLED_SUBAGENTS_DIR === "string") {
    process.env.COLLABORATING_AGENTS_BUNDLED_SUBAGENTS_DIR = ORIGINAL_BUNDLED_SUBAGENTS_DIR;
  } else {
    delete process.env.COLLABORATING_AGENTS_BUNDLED_SUBAGENTS_DIR;
  }
});

describe("subagent type discovery", () => {
  test("loads bundled example types by default", () => {
    const home = makeTempDir("collab-types-home");
    setHome(home);

    const cwd = makeTempDir("collab-types-cwd");
    const types = discoverSubagentTypes(cwd);

    expect(types.length).toBeGreaterThan(0);

    const worker = types.find((t) => t.name.toLowerCase() === "worker");
    expect(worker).toBeDefined();
    expect(worker?.source).toBe("bundled");

    const scout = types.find((t) => t.name.toLowerCase() === "scout");
    expect(scout).toBeDefined();
    expect(scout?.source).toBe("bundled");
  });

  test("bundled tester type is discoverable by name", () => {
    const home = makeTempDir("collab-types-tester-home");
    setHome(home);

    const cwd = makeTempDir("collab-types-tester-cwd");
    const types = discoverSubagentTypes(cwd);
    const tester = types.find((t) => t.name.toLowerCase() === "tester");

    expect(tester).toBeDefined();
    expect(tester?.source).toBe("bundled");
    expect(tester?.filePath.endsWith(`${path.sep}examples${path.sep}subagents${path.sep}tester.toml`)).toBe(true);
  });

  test("uses COLLABORATING_AGENTS_BUNDLED_SUBAGENTS_DIR override when provided", () => {
    const home = makeTempDir("collab-types-bundled-override-home");
    setHome(home);

    const bundledOverrideDir = makeTempDir("collab-types-bundled-override");
    writeTypeConfig(bundledOverrideDir, "worker.toml", {
      name: "worker",
      description: "Bundled override worker",
      prompt: "Bundled override prompt",
    });

    process.env.COLLABORATING_AGENTS_BUNDLED_SUBAGENTS_DIR = bundledOverrideDir;

    const cwd = makeTempDir("collab-types-bundled-override-cwd");
    const types = discoverSubagentTypes(cwd);
    const worker = types.find((t) => t.name.toLowerCase() === "worker");

    expect(worker).toBeDefined();
    expect(worker?.source).toBe("bundled");
    expect(worker?.description).toBe("Bundled override worker");
    expect(worker?.filePath).toContain(bundledOverrideDir);

    const resolvedDefault = getDefaultSubagentType(types);
    expect(resolvedDefault.filePath).toContain(bundledOverrideDir);
    expect(resolvedDefault.prompt).toBe("Bundled override prompt");
  });

  test("user ~/.pi/subagents override takes priority over bundled type", () => {
    const home = makeTempDir("collab-types-user-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "subagents"), "worker.toml", {
      name: "worker",
      description: "User worker override",
      prompt: "User worker prompt",
    });

    const cwd = makeTempDir("collab-types-user-cwd");
    const types = discoverSubagentTypes(cwd);
    const worker = types.find((t) => t.name.toLowerCase() === "worker");

    expect(worker).toBeDefined();
    expect(worker?.source).toBe("user");
    expect(worker?.description).toBe("User worker override");
    expect(worker?.filePath).toContain(path.join(home, ".pi", "subagents"));
  });

  test("default override is used when no worker override is provided", () => {
    const home = makeTempDir("collab-types-default-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "subagents"), "default.toml", {
      name: "default",
      description: "User default override",
      prompt: "Default override prompt",
    });

    const cwd = makeTempDir("collab-types-default-cwd");
    const types = discoverSubagentTypes(cwd);
    const resolvedDefault = getDefaultSubagentType(types);

    expect(resolvedDefault.name.toLowerCase()).toBe("default");
    expect(resolvedDefault.source).toBe("user");
    expect(resolvedDefault.description).toBe("User default override");
  });

  test("preferred and legacy user/project override directories all participate in precedence", () => {
    const home = makeTempDir("collab-types-precedence-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "agent", "subagents"), "worker.toml", {
      name: "worker",
      description: "Legacy worker override",
      prompt: "Legacy worker prompt",
    });

    writeTypeConfig(path.join(home, ".pi", "subagents"), "worker.toml", {
      name: "worker",
      description: "Current user worker override",
      prompt: "Current user worker prompt",
    });

    writeTypeConfig(path.join(home, ".pi", "agents"), "worker.toml", {
      name: "worker",
      description: "Preferred user worker override",
      prompt: "Preferred user worker prompt",
    });

    writeTypeConfig(path.join(home, ".pi", "subagents"), "reviewer.toml", {
      name: "reviewer",
      description: "User reviewer override",
      prompt: "User reviewer prompt",
    });

    const cwd = makeTempDir("collab-types-precedence-cwd");
    writeTypeConfig(path.join(cwd, ".pi", "subagents"), "worker.toml", {
      name: "worker",
      description: "Legacy project worker override",
      prompt: "Legacy project worker prompt",
    });

    writeTypeConfig(path.join(cwd, ".pi", "agents"), "worker.toml", {
      name: "worker",
      description: "Project worker override",
      prompt: "Project worker prompt",
    });

    const types = discoverSubagentTypes(cwd);
    const worker = types.find((t) => t.name.toLowerCase() === "worker");
    const reviewer = types.find((t) => t.name.toLowerCase() === "reviewer");

    expect(worker).toBeDefined();
    expect(worker?.source).toBe("project");
    expect(worker?.description).toBe("Project worker override");
    expect(worker?.filePath).toContain(path.join(cwd, ".pi", "agents"));

    expect(reviewer).toBeDefined();
    expect(reviewer?.source).toBe("user");
    expect(reviewer?.filePath).toContain(path.join(home, ".pi", "subagents"));

    const resolvedDefault = getDefaultSubagentType(types);
    expect(resolvedDefault.source).toBe("project");
    expect(resolvedDefault.description).toBe("Project worker override");
  });
});
