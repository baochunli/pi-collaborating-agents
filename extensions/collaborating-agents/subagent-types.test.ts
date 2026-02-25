import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSubagentTypes, getDefaultSubagentType } from "./subagent-types.ts";

const tempDirs: string[] = [];
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

  test("user ~/.pi/agents override takes priority over bundled type", () => {
    const home = makeTempDir("collab-types-user-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "agents"), "worker.toml", {
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
    expect(worker?.filePath).toContain(path.join(home, ".pi", "agents"));
  });

  test("project .pi/agents override takes priority over user override", () => {
    const home = makeTempDir("collab-types-proj-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "agents"), "worker.toml", {
      name: "worker",
      description: "User worker override",
      prompt: "User worker prompt",
    });

    const projectRoot = makeTempDir("collab-types-proj-root");
    writeTypeConfig(path.join(projectRoot, ".pi", "agents"), "worker.toml", {
      name: "worker",
      description: "Project worker override",
      prompt: "Project worker prompt",
    });

    const nestedCwd = path.join(projectRoot, "src", "feature");
    fs.mkdirSync(nestedCwd, { recursive: true });

    const types = discoverSubagentTypes(nestedCwd);
    const worker = types.find((t) => t.name.toLowerCase() === "worker");

    expect(worker).toBeDefined();
    expect(worker?.source).toBe("project");
    expect(worker?.description).toBe("Project worker override");
    expect(worker?.filePath).toContain(path.join(projectRoot, ".pi", "agents"));
  });

  test("default override is used when no worker override is provided", () => {
    const home = makeTempDir("collab-types-default-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "agents"), "default.toml", {
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

  test("preferred ~/.pi/agents path overrides legacy ~/.pi/agent/subagents", () => {
    const home = makeTempDir("collab-types-legacy-home");
    setHome(home);

    writeTypeConfig(path.join(home, ".pi", "agent", "subagents"), "worker.toml", {
      name: "worker",
      description: "Legacy worker override",
      prompt: "Legacy worker prompt",
    });

    writeTypeConfig(path.join(home, ".pi", "agents"), "worker.toml", {
      name: "worker",
      description: "Preferred worker override",
      prompt: "Preferred worker prompt",
    });

    const cwd = makeTempDir("collab-types-legacy-cwd");
    const types = discoverSubagentTypes(cwd);
    const worker = types.find((t) => t.name.toLowerCase() === "worker");

    expect(worker).toBeDefined();
    expect(worker?.source).toBe("user");
    expect(worker?.description).toBe("Preferred worker override");
    expect(worker?.filePath).toContain(path.join(home, ".pi", "agents"));
  });
});
