import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { resolveDirs } from "./paths.ts";

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_COLLAB_DIR = process.env.COLLABORATING_AGENTS_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof ORIGINAL_HOME === "string") process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;

  if (typeof ORIGINAL_USERPROFILE === "string") process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;

  if (typeof ORIGINAL_COLLAB_DIR === "string") process.env.COLLABORATING_AGENTS_DIR = ORIGINAL_COLLAB_DIR;
  else delete process.env.COLLABORATING_AGENTS_DIR;
});

describe("path resolution", () => {
  test("uses default path under home directory when override is absent", () => {
    delete process.env.COLLABORATING_AGENTS_DIR;

    const dirs = resolveDirs();
    const expectedBase = path.join(homedir(), ".pi", "agent", "collaborating-agents");

    expect(dirs).toEqual({
      base: expectedBase,
      registry: path.join(expectedBase, "registry"),
      inbox: path.join(expectedBase, "inbox"),
      messageLog: path.join(expectedBase, "messages.jsonl"),
    });
  });

  test("uses COLLABORATING_AGENTS_DIR when provided", () => {
    const home = makeTempDir("collab-paths-home-override");
    setHome(home);

    const overrideBase = path.join(home, "custom-collab-state");
    process.env.COLLABORATING_AGENTS_DIR = overrideBase;

    const dirs = resolveDirs();

    expect(dirs).toEqual({
      base: overrideBase,
      registry: path.join(overrideBase, "registry"),
      inbox: path.join(overrideBase, "inbox"),
      messageLog: path.join(overrideBase, "messages.jsonl"),
    });
  });
});
