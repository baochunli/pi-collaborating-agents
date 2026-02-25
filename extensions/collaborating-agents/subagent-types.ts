import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentTypeConfig } from "./types.js";

function stripInlineTomlComment(value: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(value[i - 1] ?? "")) {
        return value.slice(0, i).trimEnd();
      }
    }
  }

  return value.trimEnd();
}

/**
 * Minimal TOML parser for flat key/value files.
 * Supports quoted/unquoted scalar values and multiline triple-quoted strings.
 */
function parseSimpleToml(content: string): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (!line || line.startsWith("#")) continue;

    // Find the first = sign
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!key) continue;

    // Handle multiline strings (triple quotes)
    if (value.startsWith('"""') || value.startsWith("'''")) {
      const quote = value.startsWith('"""') ? '"""' : "'''";
      value = value.slice(3);

      const chunks: string[] = [];
      while (true) {
        const endQuoteIndex = value.indexOf(quote);
        if (endQuoteIndex !== -1) {
          chunks.push(value.slice(0, endQuoteIndex));
          break;
        }

        chunks.push(value);

        i += 1;
        if (i >= lines.length) break;
        value = lines[i] ?? "";
      }

      result[key] = chunks.join("\n");
      continue;
    }

    // Remove inline comments
    value = stripInlineTomlComment(value).trim();

    // Handle quoted strings
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
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
  if (reasoningValue === "low" || reasoningValue === "medium" || reasoningValue === "high" || reasoningValue === "xhigh") {
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

const BUNDLED_WORKER_TOML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "subagents",
  "worker.toml",
);

const EMERGENCY_DEFAULT_PROMPT = `You are a general worker subagent working under a parent agent.

At startup, call:
- agent_message({ action: "status" })
- agent_message({ action: "list" })

Reserve files before editing and release reservations when done.
Read relevant files before editing, keep changes scoped to the task, run validation when possible, and return a concise final report.`;

function loadBundledWorkerType(): SubagentTypeConfig | null {
  return loadSubagentTypeFromFile(BUNDLED_WORKER_TOML_PATH, "project");
}

/**
 * Discover all available subagent type configurations.
 * Project configs override user configs for the same type name.
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
 * Get the default subagent type configuration.
 *
 * Resolution order:
 * 1. "worker" from discovered project/user configs
 * 2. "default" from discovered project/user configs
 * 3. Bundled examples/subagents/worker.toml in this extension package
 * 4. Emergency inline fallback (only if the bundled file is unavailable)
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

  const bundledWorkerType = loadBundledWorkerType();
  if (bundledWorkerType) {
    return bundledWorkerType;
  }

  return {
    name: "worker",
    description: "General-purpose collaborating subagent for software development tasks",
    prompt: EMERGENCY_DEFAULT_PROMPT,
    source: "project",
    filePath: "<emergency-fallback>",
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
