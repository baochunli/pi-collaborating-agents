import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultSubagentType } from "./subagent-types.js";
import type { SubagentTypeConfig } from "./types.js";

export interface SpawnAgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface SpawnTask {
  agent: string;
  task: string;
  cwd?: string;
}

export interface SpawnResult {
  agent: string;
  name: string;
  task: string;
  exitCode: number;
  output: string;
  error?: string;
  sessionId?: string;
  workingDirectory: string;
  launchArgs: string[];
  launchCommand: string;
  launchPrompt: string;
  launchEnv: {
    PI_AGENT_NAME: string;
    PI_COLLAB_SUBAGENT_DEPTH: string;
  };
  launchDelayMs?: number;
  resolvedModel?: string;
  resolvedTools?: string[];
  coordinator?: string;
}

export const DEFAULT_SUBAGENT_TOOLS = ["read", "write", "edit", "bash", "agent_message"];

const SUPPORTED_SUBAGENT_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const LOCAL_COLLABORATING_AGENTS_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const HOME_COLLABORATING_AGENTS_EXTENSION = path.join(os.homedir(), ".pi", "agent", "extensions", "collaborating-agents", "index.ts");

export function createDefaultSpawnAgentDefinition(name = "subagent"): SpawnAgentDefinition {
  const defaultType = getDefaultSubagentType();

  return {
    name,
    description: defaultType.description,
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    systemPrompt: defaultType.prompt,
    source: defaultType.source,
    filePath: defaultType.filePath,
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized.trim() };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized.trim() };
  }

  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  for (const line of block.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[m[1]] = value;
  }

  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): SpawnAgentDefinition[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: SpawnAgentDefinition[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name.endsWith(".chain.md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
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

export function discoverSpawnAgents(cwd: string): SpawnAgentDefinition[] {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectDir ? loadAgentsFromDir(projectDir, "project") : [];

  const map = new Map<string, SpawnAgentDefinition>();
  for (const agent of userAgents) map.set(agent.name, agent);
  for (const agent of projectAgents) map.set(agent.name, agent);

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeAgentKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export interface ResolveSpawnAgentResult {
  definition?: SpawnAgentDefinition;
  suggestions: string[];
  ambiguous: boolean;
}

export function resolveSpawnAgentDefinition(
  requestedName: string,
  available: SpawnAgentDefinition[],
): ResolveSpawnAgentResult {
  const requested = normalizeAgentKey(requestedName);
  const names = available.map((a) => a.name);

  if (!requested) {
    return { suggestions: names.slice(0, 8), ambiguous: false };
  }

  const exact = available.find((a) => a.name === requestedName);
  if (exact) {
    return { definition: exact, suggestions: [], ambiguous: false };
  }

  const normalizedExact = available.find((a) => normalizeAgentKey(a.name) === requested);
  if (normalizedExact) {
    return { definition: normalizedExact, suggestions: [normalizedExact.name], ambiguous: false };
  }

  const suffixMatches = available.filter((a) => normalizeAgentKey(a.name).endsWith(`-${requested}`));
  if (suffixMatches.length === 1) {
    return { definition: suffixMatches[0], suggestions: [suffixMatches[0].name], ambiguous: false };
  }

  const prefixMatches = available.filter((a) => normalizeAgentKey(a.name).startsWith(`${requested}-`));
  if (prefixMatches.length === 1) {
    return { definition: prefixMatches[0], suggestions: [prefixMatches[0].name], ambiguous: false };
  }

  const containsMatches = available.filter((a) => normalizeAgentKey(a.name).includes(requested));

  const suggestions = Array.from(
    new Set([...suffixMatches, ...prefixMatches, ...containsMatches].map((a) => a.name)),
  ).slice(0, 8);

  if (suffixMatches.length > 1 || prefixMatches.length > 1) {
    return { suggestions, ambiguous: true };
  }

  return { suggestions, ambiguous: false };
}

const CALLSIGN_FIRST_WORDS = [
  "amber",
  "autumn",
  "bright",
  "calm",
  "clear",
  "dawn",
  "deep",
  "gentle",
  "golden",
  "grand",
  "green",
  "lively",
  "mellow",
  "mighty",
  "quiet",
  "rising",
  "silver",
  "steady",
  "sunny",
  "swift",
  "warm",
  "young",
] as const;

const CALLSIGN_SECOND_WORDS = [
  "Anchor",
  "Breeze",
  "Brook",
  "Cloud",
  "Field",
  "Forest",
  "Garden",
  "Harbor",
  "Hill",
  "Lake",
  "Maple",
  "Meadow",
  "Moon",
  "Ocean",
  "Pine",
  "River",
  "Sparrow",
  "Stone",
  "Sun",
  "Thunder",
  "Valley",
  "Wave",
  "Willow",
] as const;

const usedCallsignsByRun = new Map<string, Set<string>>();

function toTitleCase(word: string): string {
  return word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generateCallsignCandidate(runId: string, index: number, nonce: number): string {
  const hash = hashString(`${runId}:${index}:${nonce}`);
  const first = CALLSIGN_FIRST_WORDS[hash % CALLSIGN_FIRST_WORDS.length] ?? "bright";
  const second =
    CALLSIGN_SECOND_WORDS[(Math.floor(hash / CALLSIGN_FIRST_WORDS.length) + nonce) % CALLSIGN_SECOND_WORDS.length] ??
    "River";
  return `${toTitleCase(first)}${second}`;
}

function reserveReadableCallsign(runId: string, index: number): string {
  let used = usedCallsignsByRun.get(runId);
  if (!used) {
    used = new Set<string>();
    usedCallsignsByRun.set(runId, used);
    if (usedCallsignsByRun.size > 256) {
      const firstKey = usedCallsignsByRun.keys().next().value;
      if (typeof firstKey === "string") usedCallsignsByRun.delete(firstKey);
    }
  }

  for (let nonce = 0; nonce < 128; nonce++) {
    const callsign = generateCallsignCandidate(runId, index, nonce);
    if (!used.has(callsign)) {
      used.add(callsign);
      return callsign;
    }
  }

  const fallback = generateCallsignCandidate(runId, index, 0);
  used.add(fallback);
  return fallback;
}

function sanitizeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || `agent-${Date.now()}`;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null && "type" in c)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.join("\n").trim();
}

function quoteShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;

  if (/[\n\r\t]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `$'${escaped}'`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildLaunchCommand(args: string[]): string {
  return `pi ${args.map(quoteShellArg).join(" ")}`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSpawnTask(
  runtimeCwd: string,
  task: SpawnTask,
  agentDef: SpawnAgentDefinition,
  options: {
    index: number;
    runId: string;
    defaultCwd?: string;
    enableSessionControl?: boolean;
    recursionDepth: number;
    parentAgentName?: string;
    launchDelayMs?: number;
    onLaunch?: (launch: SpawnResult) => void | Promise<void>;
  },
): Promise<SpawnResult> {
  const generatedCallsign = reserveReadableCallsign(options.runId, options.index);
  const runToken = options.runId.slice(0, 4);
  const childName = sanitizeAgentName(`${task.agent}-${runToken}-${generatedCallsign}`);

  const args: string[] = ["--mode", "json", "-p"];
  if (options.enableSessionControl !== false) args.push("--session-control");

  const model = agentDef.model;
  if (model) args.push("--models", model);

  const requestedTools = agentDef.tools ?? [];
  const supportedTools = requestedTools.filter((tool) => SUPPORTED_SUBAGENT_TOOL_NAMES.has(tool));

  if (supportedTools.length > 0) {
    args.push("--tools", supportedTools.join(","));
  }

  // Ensure the collaborating-agents extension is always loaded in subagents so
  // `agent_message` and `subagent` tools are available, even if auto-discovery
  // is not functioning in the spawned environment.
  const extensionPaths = [
    LOCAL_COLLABORATING_AGENTS_EXTENSION,
    HOME_COLLABORATING_AGENTS_EXTENSION,
  ];
  for (const extensionPath of extensionPaths) {
    if (fs.existsSync(extensionPath)) {
      args.push("--extension", extensionPath);
      break;
    }
  }

  let tmpDir: string | null = null;
  if (agentDef.systemPrompt.trim()) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-subagent-"));
    const promptPath = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(promptPath, agentDef.systemPrompt, "utf-8");
    args.push("--append-system-prompt", promptPath);
  }

  const coordinationHeader = options.parentAgentName
    ? [
        `Parent agent: ${options.parentAgentName}`,
        "Direct status messages to the parent are optional and only needed for blockers/questions.",
        "Do not send a mandatory final summary message to the parent; completion output is collected automatically.",
        "Do not broadcast progress updates unless the task explicitly asks for broadcast.",
      ].join("\n")
    : "Do not broadcast progress updates unless explicitly requested by the task.";

  const wrappedTaskPrompt = `${coordinationHeader}\n\nTask: ${task.task}`;
  args.push(wrappedTaskPrompt);

  const env = {
    ...process.env,
    PI_AGENT_NAME: childName,
    PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
  };

  const cwd = task.cwd || options.defaultCwd || runtimeCwd;

  const launchArgs = [...args];

  const launchDelayMs = Math.max(0, Math.floor(options.launchDelayMs ?? 0));

  const result: SpawnResult = {
    agent: task.agent,
    name: childName,
    task: task.task,
    exitCode: 1,
    output: "",
    workingDirectory: cwd,
    launchArgs,
    launchCommand: buildLaunchCommand(launchArgs),
    launchPrompt: wrappedTaskPrompt,
    launchEnv: {
      PI_AGENT_NAME: childName,
      PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
    },
    launchDelayMs,
    resolvedModel: model,
    resolvedTools: agentDef.tools ? [...agentDef.tools] : undefined,
    coordinator: options.parentAgentName,
  };

  try {
    if (launchDelayMs > 0) {
      await sleep(launchDelayMs);
    }

    result.exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (options.onLaunch) {
        const launchSnapshot: SpawnResult = {
          ...result,
          launchArgs: [...result.launchArgs],
          launchEnv: { ...result.launchEnv },
          resolvedTools: result.resolvedTools ? [...result.resolvedTools] : undefined,
        };
        void Promise.resolve(options.onLaunch(launchSnapshot)).catch(() => {
          // ignore launch callback errors
        });
      }

      let stdoutBuffer = "";
      let stderr = "";
      let lastAssistant = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (!event || typeof event !== "object") return;
        const e = event as Record<string, unknown>;

        if (e.type === "session" && typeof e.id === "string") {
          result.sessionId = e.id;
          return;
        }

        if (e.type === "message_end" && typeof e.message === "object" && e.message) {
          const msg = e.message as Record<string, unknown>;
          if (msg.role === "assistant") {
            const text = extractAssistantText(msg.content);
            if (text) lastAssistant = text;
          }
        }
      };

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        result.output = lastAssistant || stderr.trim() || "(no output)";
        if ((code ?? 0) !== 0 && stderr.trim()) result.error = stderr.trim();
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        result.error = err instanceof Error ? err.message : String(err);
        result.output = result.error;
        resolve(1);
      });
    });

    if (result.exitCode !== 0 && !result.error) {
      result.error = result.output || "Subagent process failed";
    }

    return result;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const max = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(max).fill(null).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Create a SpawnAgentDefinition from a SubagentTypeConfig.
 * This converts TOML-based subagent type configurations to the format
 * needed by the spawn system.
 */
export function createSpawnAgentDefinitionFromType(
  typeConfig: SubagentTypeConfig,
): SpawnAgentDefinition {
  return {
    name: typeConfig.name,
    description: typeConfig.description,
    model: typeConfig.model,
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    systemPrompt: typeConfig.prompt,
    source: typeConfig.source,
    filePath: typeConfig.filePath,
  };
}
