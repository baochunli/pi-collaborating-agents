import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollaboratingAgentsConfig, SubagentLaunchMode } from "./types.js";

const DEFAULT_CONFIG: CollaboratingAgentsConfig = {
  messageHistoryLimit: 400,
  subagentLaunchMode: "process",
  closeCompletedCmuxPanes: true,
};

function isSubagentLaunchMode(value: unknown): value is SubagentLaunchMode {
  return value === "process" || value === "cmux-pane";
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;

  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;

  return homedir();
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadConfig(cwd: string): CollaboratingAgentsConfig {
  const projectPath = join(cwd, ".pi", "collaborating-agents.json");
  const globalPath = join(resolveHomeDir(), ".pi", "agent", "collaborating-agents.json");

  const globalConfig = readJson(globalPath) as Partial<CollaboratingAgentsConfig> | null;
  const projectConfig = readJson(projectPath) as Partial<CollaboratingAgentsConfig> | null;

  const merged: Partial<CollaboratingAgentsConfig> = {
    ...DEFAULT_CONFIG,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {}),
  };

  return {
    messageHistoryLimit:
      typeof merged.messageHistoryLimit === "number" && merged.messageHistoryLimit > 0
        ? merged.messageHistoryLimit
        : DEFAULT_CONFIG.messageHistoryLimit,
    subagentLaunchMode: isSubagentLaunchMode(merged.subagentLaunchMode)
      ? merged.subagentLaunchMode
      : DEFAULT_CONFIG.subagentLaunchMode,
    closeCompletedCmuxPanes:
      typeof merged.closeCompletedCmuxPanes === "boolean"
        ? merged.closeCompletedCmuxPanes
        : DEFAULT_CONFIG.closeCompletedCmuxPanes,
  };
}
