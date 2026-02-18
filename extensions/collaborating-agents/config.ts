import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollaboratingAgentsConfig } from "./types.js";

const DEFAULT_CONFIG: CollaboratingAgentsConfig = {
  staleAgentSeconds: 120,
  messageHistoryLimit: 400,
};

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
  const globalPath = join(homedir(), ".pi", "agent", "collaborating-agents.json");

  const globalConfig = readJson(globalPath) as Partial<CollaboratingAgentsConfig> | null;
  const projectConfig = readJson(projectPath) as Partial<CollaboratingAgentsConfig> | null;

  const merged: Partial<CollaboratingAgentsConfig> = {
    ...DEFAULT_CONFIG,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {}),
  };

  return {
    staleAgentSeconds:
      typeof merged.staleAgentSeconds === "number" && merged.staleAgentSeconds > 0
        ? merged.staleAgentSeconds
        : DEFAULT_CONFIG.staleAgentSeconds,
    messageHistoryLimit:
      typeof merged.messageHistoryLimit === "number" && merged.messageHistoryLimit > 0
        ? merged.messageHistoryLimit
        : DEFAULT_CONFIG.messageHistoryLimit,
  };
}
