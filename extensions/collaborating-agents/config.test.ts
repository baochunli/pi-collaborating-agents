import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.ts";

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
});

describe("config loading", () => {
  test("uses default history limit when no config files exist", () => {
    const home = makeTempDir("collab-config-home-default");
    setHome(home);

    const cwd = makeTempDir("collab-config-cwd-default");
    const config = loadConfig(cwd);

    expect(config).toEqual({ messageHistoryLimit: 400 });
  });

  test("merges global and project configs with project taking precedence", () => {
    const home = makeTempDir("collab-config-home-merge");
    setHome(home);

    const globalConfigPath = path.join(home, ".pi", "agent", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ messageHistoryLimit: 250 }), "utf-8");

    const cwd = makeTempDir("collab-config-cwd-merge");
    const projectConfigPath = path.join(cwd, ".pi", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, JSON.stringify({ messageHistoryLimit: 75 }), "utf-8");

    const config = loadConfig(cwd);
    expect(config).toEqual({ messageHistoryLimit: 75 });
  });

  test("falls back to default when config content is malformed or invalid", () => {
    const home = makeTempDir("collab-config-home-invalid");
    setHome(home);

    const globalConfigPath = path.join(home, ".pi", "agent", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, "{not-json", "utf-8");

    const cwd = makeTempDir("collab-config-cwd-invalid");
    const projectConfigPath = path.join(cwd, ".pi", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, JSON.stringify({ messageHistoryLimit: 0 }), "utf-8");

    const config = loadConfig(cwd);
    expect(config).toEqual({ messageHistoryLimit: 400 });
  });
});
