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

function normalizeTypeKey(name: string): string {
  return name.toLowerCase().trim();
}

function loadSubagentTypeFromFile(filePath: string, source: SubagentTypeConfig["source"]): SubagentTypeConfig | null {
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

function loadSubagentTypesFromDir(dir: string, source: SubagentTypeConfig["source"]): SubagentTypeConfig[] {
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

function findNearestProjectSubagentDir(cwd: string, leafName: "agents" | "subagents"): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", leafName);
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

function appendUniquePath(paths: string[], candidate: string | null): void {
  if (!candidate) return;
  if (!paths.includes(candidate)) {
    paths.push(candidate);
  }
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;

  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;

  return os.homedir();
}

const BUNDLED_SUBAGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "subagents",
);

const BUNDLED_WORKER_TOML_PATH = path.join(BUNDLED_SUBAGENTS_DIR, "worker.toml");

const EMERGENCY_DEFAULT_PROMPT = `You are a general worker subagent working under a parent agent.

At startup, call:
- agent_message({ action: "status" })
- agent_message({ action: "list" })

Reserve files before editing and release reservations when done.
Read relevant files before editing, keep changes scoped to the task, run validation when possible, and return a concise final report.`;

function loadBundledSubagentTypes(): SubagentTypeConfig[] {
  return loadSubagentTypesFromDir(BUNDLED_SUBAGENTS_DIR, "bundled");
}

function loadBundledWorkerType(): SubagentTypeConfig | null {
  return loadSubagentTypeFromFile(BUNDLED_WORKER_TOML_PATH, "bundled");
}

/**
 * Discover all available subagent type configurations.
 *
 * Resolution precedence (later overrides earlier for matching type names):
 * 1. Bundled defaults in examples/subagents/*.toml
 * 2. User overrides in ~/.pi/agents/*.toml (preferred) and ~/.pi/agent/subagents/*.toml (legacy)
 * 3. Project overrides in nearest .pi/agents/*.toml (preferred) and .pi/subagents/*.toml (legacy)
 */
export function discoverSubagentTypes(cwd: string): SubagentTypeConfig[] {
  const bundledTypes = loadBundledSubagentTypes();

  const homeDir = resolveHomeDir();
  const userDirs: string[] = [];
  appendUniquePath(userDirs, path.join(homeDir, ".pi", "agent", "subagents")); // legacy
  appendUniquePath(userDirs, path.join(homeDir, ".pi", "agents")); // preferred

  const projectDirs: string[] = [];
  appendUniquePath(projectDirs, findNearestProjectSubagentDir(cwd, "subagents")); // legacy
  appendUniquePath(projectDirs, findNearestProjectSubagentDir(cwd, "agents")); // preferred

  const userTypes = userDirs.flatMap((dir) => loadSubagentTypesFromDir(dir, "user"));
  const projectTypes = projectDirs.flatMap((dir) => loadSubagentTypesFromDir(dir, "project"));

  const map = new Map<string, SubagentTypeConfig>();

  const applyTypes = (types: SubagentTypeConfig[]) => {
    for (const type of types) {
      map.set(normalizeTypeKey(type.name), type);
    }
  };

  applyTypes(bundledTypes);
  applyTypes(userTypes);
  applyTypes(projectTypes);

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a subagent type by name (case-insensitive).
 */
export function findSubagentType(
  name: string,
  availableTypes: SubagentTypeConfig[],
): SubagentTypeConfig | undefined {
  const normalizedName = normalizeTypeKey(name);
  return availableTypes.find((t) => normalizeTypeKey(t.name) === normalizedName);
}

/**
 * Get the default subagent type configuration.
 *
 * Resolution order:
 * 1. "worker" from user/project overrides
 * 2. "default" from user/project overrides
 * 3. Bundled discovered "worker"
 * 4. Bundled examples/subagents/worker.toml in this extension package
 * 5. Emergency inline fallback (only if bundled defaults are unavailable)
 *
 * @param availableTypes - Optional array of discovered subagent types to search
 */
export function getDefaultSubagentType(availableTypes?: SubagentTypeConfig[]): SubagentTypeConfig {
  const resolvedAvailableTypes = availableTypes ?? discoverSubagentTypes(process.cwd());

  const workerType = resolvedAvailableTypes.find((t) => normalizeTypeKey(t.name) === "worker");
  const defaultType = resolvedAvailableTypes.find((t) => normalizeTypeKey(t.name) === "default");

  // Prefer explicit user/project overrides over bundled defaults.
  if (workerType && workerType.source !== "bundled") {
    return workerType;
  }

  if (defaultType && defaultType.source !== "bundled") {
    return defaultType;
  }

  if (workerType) {
    return workerType;
  }

  if (defaultType) {
    return defaultType;
  }

  const bundledWorkerType = loadBundledWorkerType();
  if (bundledWorkerType) {
    return bundledWorkerType;
  }

  return {
    name: "worker",
    description: "General-purpose collaborating subagent for software development tasks",
    prompt: EMERGENCY_DEFAULT_PROMPT,
    source: "bundled",
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
