import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentTypeConfig } from "./types.js";

/**
 * Simple TOML parser that extracts the basic structure we need.
 * Handles string values (quoted and unquoted), and basic key-value pairs.
 */
function parseSimpleToml(content: string): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    // Skip comments and empty lines
    if (!line || line.startsWith("#")) continue;

    // Find the first = sign
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Remove inline comments
    const commentIndex = value.search(/\s+#/);
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trim();
    }

    // Handle quoted strings
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle multiline strings (triple quotes) - for simplicity, just take the content
    if (value.startsWith('"""') || value.startsWith("'''")) {
      const quote = value.slice(0, 3);
      // Find the closing quote
      const endQuoteIndex = value.indexOf(quote, 3);
      if (endQuoteIndex !== -1) {
        value = value.slice(3, endQuoteIndex);
      } else {
        // Multiline - take everything after the opening quote
        value = value.slice(3);
      }
    }

    if (key) {
      result[key] = value;
    }
  }

  return result;
}

function loadSubagentTypeFromFile(filePath: string, source: "user" | "project"): SubagentTypeConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const parsed = parseSimpleToml(content);

  // Name is required - use filename without extension if not specified
  const name = parsed.name?.trim() || path.basename(filePath, ".toml");
  // Prompt is required
  const prompt = parsed.prompt?.trim();
  if (!prompt) {
    return null;
  }

  // Description is required
  const description = parsed.description?.trim();
  if (!description) {
    return null;
  }

  // Parse reasoning level
  let reasoning: SubagentTypeConfig["reasoning"] = undefined;
  const reasoningValue = parsed.reasoning?.toLowerCase().trim();
  if (reasoningValue === "low" || reasoningValue === "medium" || reasoningValue === "high") {
    reasoning = reasoningValue;
  }

  return {
    name,
    description,
    model: parsed.model?.trim() || undefined,
    reasoning,
    prompt,
    source,
    filePath,
  };
}

function loadSubagentTypesFromDir(dir: string, source: "user" | "project"): SubagentTypeConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const types: SubagentTypeConfig[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".toml")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    const config = loadSubagentTypeFromFile(filePath, source);
    if (config) {
      types.push(config);
    }
  }

  return types;
}

function findNearestProjectSubagentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "subagents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Discover all available subagent type configurations.
 * User configs override project configs for the same type name.
 */
export function discoverSubagentTypes(cwd: string): SubagentTypeConfig[] {
  const userDir = path.join(os.homedir(), ".pi", "agent", "subagents");
  const projectDir = findNearestProjectSubagentsDir(cwd);

  const userTypes = loadSubagentTypesFromDir(userDir, "user");
  const projectTypes = projectDir ? loadSubagentTypesFromDir(projectDir, "project") : [];

  // Project types take precedence over user types
  const map = new Map<string, SubagentTypeConfig>();
  for (const type of userTypes) map.set(type.name, type);
  for (const type of projectTypes) map.set(type.name, type);

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a subagent type by name (case-insensitive).
 */
export function findSubagentType(
  name: string,
  availableTypes: SubagentTypeConfig[],
): SubagentTypeConfig | undefined {
  const normalizedName = name.toLowerCase().trim();
  return availableTypes.find((t) => t.name.toLowerCase() === normalizedName);
}

/**
 * The hardcoded embedded default prompt, used as fallback when no
 * worker.toml or default.toml is found.
 */
const EMBEDDED_DEFAULT_PROMPT = `You are a spawned subagent operating under a parent agent.

## Messaging protocol (required)

1. At startup, call:
   - agent_message({ action: "status" })
   - agent_message({ action: "list" })

2. If the prompt contains a parent agent name, you may send direct status updates to that parent agent when useful:
   - "Started task: ..."
   - blockers/questions needing parent input

3. Do not send a mandatory final summary message to the parent. The parent collects your final output automatically from task completion.

4. Use direct messages for blockers and questions.

5. Do not broadcast progress updates unless explicitly requested by the task.

## Execution protocol

- Read relevant files before editing.
- Keep changes scoped to the requested task.
- Run validation when possible.
- Return a concise structured final report.

## Final response format

## Summary
[What was done]

## Files Changed
- file/path: what changed

## Validation
- command: result

## Notes
- blockers/follow-ups`;

/**
 * Get the default subagent type configuration.
 * 
 * Looks for a "worker" or "default" type in the available types first.
 * If found, returns that configuration. Otherwise returns the embedded default.
 * 
 * @param availableTypes - Optional array of discovered subagent types to search
 */
export function getDefaultSubagentType(availableTypes?: SubagentTypeConfig[]): SubagentTypeConfig {
  // Look for "worker" type first, then "default" type
  if (availableTypes) {
    const workerType = availableTypes.find((t) => t.name.toLowerCase() === "worker");
    if (workerType) {
      return workerType;
    }
    
    const defaultType = availableTypes.find((t) => t.name.toLowerCase() === "default");
    if (defaultType) {
      return defaultType;
    }
  }
  
  // Fall back to embedded default
  return {
    name: "default",
    description: "Default collaborating subagent with balanced capabilities",
    prompt: EMBEDDED_DEFAULT_PROMPT,
    source: "project",
    filePath: "<embedded>",
  };
}

/**
 * Format a subagent type for display.
 */
export function formatSubagentType(type: SubagentTypeConfig): string {
  const parts = [`${type.name}: ${type.description}`];
  if (type.model) parts.push(`  model: ${type.model}`);
  if (type.reasoning) parts.push(`  reasoning: ${type.reasoning}`);
  parts.push(`  source: ${type.source}`);
  return parts.join("\n");
}