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
  source: "bundled" | "user" | "project";
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
  sessionFile?: string;
  launchMode: "process" | "cmux-pane";
  workingDirectory: string;
  launchArgs: string[];
  launchCommand: string;
  launchPrompt: string;
  launchSystemPromptSource?: string;
  launchSystemPromptLength?: number;
  cmuxWorkspaceRef?: string;
  cmuxPaneRef?: string;
  cmuxSurfaceRef?: string;
  launchEnv: {
    PI_AGENT_NAME: string;
    PI_COLLAB_SUBAGENT_DEPTH: string;
  };
  launchDelayMs?: number;
  resolvedModel?: string;
  resolvedTools?: string[];
  coordinator?: string;
  cmuxPaneClosed?: boolean;
  cmuxCloseError?: string;
}

export const DEFAULT_SUBAGENT_TOOLS = ["read", "write", "edit", "bash", "agent_message"];

const SUPPORTED_SUBAGENT_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

const LOCAL_COLLABORATING_AGENTS_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const HOME_COLLABORATING_AGENTS_EXTENSION = path.join(os.homedir(), ".pi", "agent", "extensions", "collaborating-agents", "index.ts");
const CMUX_PANE_IDLE_GRACE_MS = 1200;
const CMUX_PANE_IDLE_MAX_WAIT_MS = 15000;

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

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;

  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;

  return os.homedir();
}

export function discoverSpawnAgents(cwd: string): SpawnAgentDefinition[] {
  const homeDir = resolveHomeDir();
  const legacyUserDir = path.join(homeDir, ".pi", "agent", "agents");
  const preferredUserDir = path.join(homeDir, ".pi", "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const userAgents = [
    ...loadAgentsFromDir(legacyUserDir, "user"),
    ...loadAgentsFromDir(preferredUserDir, "user"),
  ];
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

function createPiEventProcessor(result: SpawnResult): {
  processLine: (line: string) => void;
  finalize: (stderr: string) => void;
} {
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

  const finalize = (stderr: string) => {
    result.output = lastAssistant || stderr.trim() || "(no output)";
  };

  return { processLine, finalize };
}

async function waitForFile(pathToWatch: string): Promise<void> {
  while (true) {
    try {
      await fs.promises.access(pathToWatch, fs.constants.F_OK);
      return;
    } catch {
      await sleep(100);
    }
  }
}

async function waitForFileWithTimeout(pathToWatch: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.promises.access(pathToWatch, fs.constants.F_OK);
      return true;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) return false;
      await sleep(100);
    }
  }
}

function createSubagentSessionFilePath(childName: string, runId: string): string {
  const sessionsDir = path.join(resolveHomeDir(), ".pi", "agent", "sessions", "collaborating-agents-subagents");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${timestamp}_${runId}_${childName}.jsonl`);
}

function createSubagentExitMarkerPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

function buildCmuxPaneCommand(args: {
  piArgs: string[];
  env: Record<string, string>;
  cwd: string;
  exitMarkerPath: string;
}): string {
  const envAssignments = Object.entries(args.env).map(([key, value]) => `${key}=${quoteShellArg(value)}`);
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments.join(" ")} ` : "";
  const piCommand = buildLaunchCommand(args.piArgs);
  const cwd = quoteShellArg(args.cwd);
  const exitMarkerPath = quoteShellArg(args.exitMarkerPath);

  return [
    `printf '\\033c'`,
    `cd ${cwd} || exit $?`,
    `${envPrefix}${piCommand}`,
    `status=$?`,
    `mkdir -p $(dirname ${exitMarkerPath})`,
    `printf '%s\\n' "$status" > ${exitMarkerPath}`,
    `exit $status`,
  ].join('; ');
}

function readExitMarkerCode(exitMarkerPath: string): number | null {
  if (!fs.existsSync(exitMarkerPath)) return null;
  try {
    const code = Number(fs.readFileSync(exitMarkerPath, "utf-8").trim());
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

async function waitForSessionIdleGrace(args: {
  sessionFile: string;
  exitMarkerPath: string;
  idleGraceMs?: number;
  maxWaitMs?: number;
}): Promise<{ idleReached: boolean; exitCode: number | null; timedOut: boolean }> {
  const idleGraceMs = Math.max(100, Math.floor(args.idleGraceMs ?? CMUX_PANE_IDLE_GRACE_MS));
  const maxWaitMs = Math.max(idleGraceMs, Math.floor(args.maxWaitMs ?? CMUX_PANE_IDLE_MAX_WAIT_MS));
  const startedAt = Date.now();
  let lastObservedMtime = readFileMtimeMs(args.sessionFile) ?? 0;
  let lastActivityAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const currentMtime = readFileMtimeMs(args.sessionFile);
    if (currentMtime && currentMtime > lastObservedMtime + 0.5) {
      lastObservedMtime = currentMtime;
      lastActivityAt = Date.now();
    }

    const exitCode = readExitMarkerCode(args.exitMarkerPath);
    if (exitCode !== null && exitCode !== 0) {
      return { idleReached: false, exitCode, timedOut: false };
    }

    if (Date.now() - lastActivityAt >= idleGraceMs) {
      return { idleReached: true, exitCode, timedOut: false };
    }

    await sleep(100);
  }

  return {
    idleReached: false,
    exitCode: readExitMarkerCode(args.exitMarkerPath),
    timedOut: true,
  };
}

function parseSessionMessageLine(line: string): {
  sessionId?: string;
  terminalAssistantText?: string;
} {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }

  if (!event || typeof event !== "object") return {};
  const parsed = event as Record<string, unknown>;

  if (parsed.type === "session" && typeof parsed.id === "string") {
    return { sessionId: parsed.id };
  }

  if (parsed.type !== "message" || !parsed.message || typeof parsed.message !== "object") {
    return {};
  }

  const message = parsed.message as Record<string, unknown>;
  if (message.role !== "assistant") return {};

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  if (stopReason === "toolUse") return {};

  return {
    terminalAssistantText: extractAssistantText(message.content),
  };
}

function readSpawnSessionState(sessionFile: string): {
  sessionId?: string;
  terminalAssistantText?: string;
} {
  if (!fs.existsSync(sessionFile)) return {};

  let content = "";
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return {};
  }

  let sessionId: string | undefined;
  let terminalAssistantText: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSessionMessageLine(line);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.terminalAssistantText !== undefined) {
      terminalAssistantText = parsed.terminalAssistantText;
    }
  }

  return { sessionId, terminalAssistantText };
}

async function waitForSessionResult(
  sessionFile: string,
  timeoutMs: number,
  onUpdate?: (state: { sessionId?: string }) => void,
): Promise<{ sessionId?: string; terminalAssistantText?: string } | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = readSpawnSessionState(sessionFile);
    if (state.sessionId) onUpdate?.({ sessionId: state.sessionId });
    if (state.terminalAssistantText !== undefined) return state;
    await sleep(100);
  }

  return null;
}

async function runCmuxCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const proc = spawn("cmux", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: 1, stdout: "", stderr: message });
    });
  });
}

function parseCmuxIdentify(jsonText: string): { workspaceRef: string; paneRef: string; surfaceRef: string } | null {
  try {
    const parsed = JSON.parse(jsonText) as {
      caller?: { workspace_ref?: unknown; pane_ref?: unknown; surface_ref?: unknown };
    };
    const workspaceRef = typeof parsed.caller?.workspace_ref === "string" ? parsed.caller.workspace_ref : undefined;
    const paneRef = typeof parsed.caller?.pane_ref === "string" ? parsed.caller.pane_ref : undefined;
    const surfaceRef = typeof parsed.caller?.surface_ref === "string" ? parsed.caller.surface_ref : undefined;
    if (!workspaceRef || !paneRef || !surfaceRef) return null;
    return { workspaceRef, paneRef, surfaceRef };
  } catch {
    return null;
  }
}

function parseCmuxNewSplit(stdout: string): { workspaceRef: string; surfaceRef: string } | null {
  const workspaceMatch = stdout.match(/\b(workspace:\d+)\b/);
  const surfaceMatch = stdout.match(/\b(surface:\d+)\b/);
  if (!workspaceMatch || !surfaceMatch) return null;
  return {
    workspaceRef: workspaceMatch[1],
    surfaceRef: surfaceMatch[1],
  };
}

async function launchCmuxPane(args: { scriptPath: string }): Promise<
  | {
      ok: true;
      workspaceRef: string;
      paneRef: string;
      surfaceRef: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const identify = await runCmuxCommand(["identify", "--json"]);
  if (identify.exitCode !== 0) {
    return { ok: false, error: identify.stderr || identify.stdout || "Failed to identify current cmux surface" };
  }

  const callerContext = parseCmuxIdentify(identify.stdout);
  if (!callerContext) {
    return { ok: false, error: "cmux pane launch requires running inside a cmux terminal surface" };
  }

  const split = await runCmuxCommand([
    "new-split",
    "right",
    "--workspace",
    callerContext.workspaceRef,
    "--surface",
    callerContext.surfaceRef,
  ]);
  if (split.exitCode !== 0) {
    return { ok: false, error: split.stderr || split.stdout || "Failed to create cmux pane" };
  }

  const created = parseCmuxNewSplit(split.stdout);
  if (!created) {
    return { ok: false, error: `Unexpected cmux new-split output: ${split.stdout || "(empty)"}` };
  }

  const paneIdentify = await runCmuxCommand([
    "identify",
    "--json",
    "--workspace",
    created.workspaceRef,
    "--surface",
    created.surfaceRef,
  ]);
  if (paneIdentify.exitCode !== 0) {
    return { ok: false, error: paneIdentify.stderr || paneIdentify.stdout || "Failed to identify cmux pane" };
  }

  const paneContext = parseCmuxIdentify(paneIdentify.stdout);
  if (!paneContext) {
    return { ok: false, error: "Failed to resolve cmux pane refs after split" };
  }

  const send = await runCmuxCommand([
    "send",
    "--workspace",
    paneContext.workspaceRef,
    "--surface",
    paneContext.surfaceRef,
    `${args.scriptPath}\n`,
  ]);
  if (send.exitCode !== 0) {
    return { ok: false, error: send.stderr || send.stdout || "Failed to send command to cmux pane" };
  }

  return {
    ok: true,
    workspaceRef: paneContext.workspaceRef,
    paneRef: paneContext.paneRef,
    surfaceRef: paneContext.surfaceRef,
  };
}

async function closeCmuxSurface(surfaceRef: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const close = await runCmuxCommand(["close-surface", "--surface", surfaceRef]);
  if (close.exitCode !== 0) {
    return { ok: false, error: close.stderr || close.stdout || "Failed to close cmux surface" };
  }
  return { ok: true };
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
    launchMode?: "process" | "cmux-pane";
    closeCompletedCmuxPane?: boolean;
    onLaunch?: (launch: SpawnResult) => void | Promise<void>;
  },
): Promise<SpawnResult> {
  const generatedCallsign = reserveReadableCallsign(options.runId, options.index);
  const runToken = options.runId.slice(0, 4);
  const childName = sanitizeAgentName(`${task.agent}-${runToken}-${generatedCallsign}`);

  const commonArgs: string[] = [];
  if (options.enableSessionControl !== false) commonArgs.push("--session-control");

  const model = agentDef.model;
  if (model) commonArgs.push("--models", model);

  const requestedTools = agentDef.tools ?? [];
  const supportedTools = requestedTools.filter((tool) => SUPPORTED_SUBAGENT_TOOL_NAMES.has(tool));

  if (supportedTools.length > 0) {
    commonArgs.push("--tools", supportedTools.join(","));
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
      commonArgs.push("--extension", extensionPath);
      break;
    }
  }

  const typeSystemPrompt = agentDef.systemPrompt.trim();
  if (typeSystemPrompt) {
    // Pass prompt text directly so type instructions are always attached,
    // regardless of file-path resolution behavior across pi versions.
    commonArgs.push("--append-system-prompt", typeSystemPrompt);
  }

  const parentContextHeader = options.parentAgentName
    ? `Parent agent: ${options.parentAgentName}\n\n`
    : "";

  // Keep the task prompt payload user-controlled (type instructions come from TOML
  // via --append-system-prompt). Only add lightweight parent context metadata.
  const wrappedTaskPrompt = `${parentContextHeader}${task.task}`;
  const env = {
    ...process.env,
    PI_AGENT_NAME: childName,
    PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
  };

  const cwd = task.cwd || options.defaultCwd || runtimeCwd;

  const launchMode = options.launchMode ?? "process";
  const sessionFile = launchMode === "cmux-pane" ? createSubagentSessionFilePath(childName, options.runId.slice(0, 8)) : undefined;
  const exitMarkerPath = sessionFile ? createSubagentExitMarkerPath(sessionFile) : undefined;

  const args: string[] =
    launchMode === "cmux-pane"
      ? [...commonArgs, "--session", sessionFile!, wrappedTaskPrompt]
      : ["--mode", "json", "-p", ...commonArgs, wrappedTaskPrompt];

  const launchArgs = [...args];
  if (typeSystemPrompt) {
    const promptArgIndex = launchArgs.indexOf("--append-system-prompt");
    if (promptArgIndex >= 0 && promptArgIndex + 1 < launchArgs.length) {
      launchArgs[promptArgIndex + 1] = `<subagent-type-prompt:${typeSystemPrompt.length} chars>`;
    }
  }

  const launchDelayMs = Math.max(0, Math.floor(options.launchDelayMs ?? 0));

  const result: SpawnResult = {
    agent: task.agent,
    name: childName,
    task: task.task,
    exitCode: 1,
    output: "",
    sessionFile,
    launchMode,
    workingDirectory: cwd,
    launchArgs,
    launchCommand: buildLaunchCommand(launchArgs),
    launchPrompt: wrappedTaskPrompt,
    launchSystemPromptSource: typeSystemPrompt ? agentDef.filePath : undefined,
    launchSystemPromptLength: typeSystemPrompt.length > 0 ? typeSystemPrompt.length : undefined,
    launchEnv: {
      PI_AGENT_NAME: childName,
      PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
    },
    launchDelayMs,
    resolvedModel: model,
    resolvedTools: agentDef.tools ? [...agentDef.tools] : undefined,
    coordinator: options.parentAgentName,
  };

  if (launchDelayMs > 0) {
    await sleep(launchDelayMs);
  }

  if (result.launchMode === "cmux-pane") {
    const cmuxLaunchEnv: Record<string, string> = {
      PI_AGENT_NAME: result.launchEnv.PI_AGENT_NAME,
      PI_COLLAB_SUBAGENT_DEPTH: result.launchEnv.PI_COLLAB_SUBAGENT_DEPTH,
    };
    if (typeof process.env.PATH === "string" && process.env.PATH.length > 0) {
      cmuxLaunchEnv.PATH = process.env.PATH;
    }
    if (typeof process.env.HOME === "string" && process.env.HOME.length > 0) {
      cmuxLaunchEnv.HOME = process.env.HOME;
    }
    if (typeof process.env.USERPROFILE === "string" && process.env.USERPROFILE.length > 0) {
      cmuxLaunchEnv.USERPROFILE = process.env.USERPROFILE;
    }
    if (typeof process.env.COLLABORATING_AGENTS_DIR === "string" && process.env.COLLABORATING_AGENTS_DIR.length > 0) {
      cmuxLaunchEnv.COLLABORATING_AGENTS_DIR = process.env.COLLABORATING_AGENTS_DIR;
    }
    if (typeof process.env.PI_COLLAB_SUBAGENT_MAX_DEPTH === "string" && process.env.PI_COLLAB_SUBAGENT_MAX_DEPTH.length > 0) {
      cmuxLaunchEnv.PI_COLLAB_SUBAGENT_MAX_DEPTH = process.env.PI_COLLAB_SUBAGENT_MAX_DEPTH;
    }

    const cmuxCommand = buildCmuxPaneCommand({
      piArgs: args,
      env: cmuxLaunchEnv,
      cwd,
      exitMarkerPath: exitMarkerPath!,
    });

    const cmuxLaunch = await launchCmuxPane({ scriptPath: cmuxCommand });

    if (!cmuxLaunch.ok) {
      result.exitCode = 1;
      result.error = cmuxLaunch.error;
      result.output = result.error;
      return result;
    }

    result.cmuxWorkspaceRef = cmuxLaunch.workspaceRef;
    result.cmuxPaneRef = cmuxLaunch.paneRef;
    result.cmuxSurfaceRef = cmuxLaunch.surfaceRef;

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

    const didCreateSession = await waitForFileWithTimeout(result.sessionFile!, 10000);
    if (!didCreateSession) {
      result.exitCode = 1;
      const paneScreen = await runCmuxCommand([
        "read-screen",
        "--workspace",
        result.cmuxWorkspaceRef!,
        "--surface",
        result.cmuxSurfaceRef!,
        "--scrollback",
        "--lines",
        "120",
      ]);
      result.error = paneScreen.stdout || "Timed out waiting for subagent session file in cmux pane";
      result.output = result.error;
      return result;
    }

    const sessionState = await waitForSessionResult(result.sessionFile!, 600_000, (state) => {
      if (state.sessionId) result.sessionId = state.sessionId;
    });

    if (!sessionState) {
      const paneScreen = await runCmuxCommand([
        "read-screen",
        "--workspace",
        result.cmuxWorkspaceRef!,
        "--surface",
        result.cmuxSurfaceRef!,
        "--scrollback",
        "--lines",
        "200",
      ]);
      result.exitCode = 1;
      result.error = paneScreen.stdout || "Timed out waiting for subagent response in cmux pane";
      result.output = result.error;
      return result;
    }

    result.sessionId = sessionState.sessionId ?? result.sessionId;
    result.output = sessionState.terminalAssistantText || "(no output)";
    result.exitCode = 0;

    if (options.closeCompletedCmuxPane === false) {
      return result;
    }

    const idleWait = await waitForSessionIdleGrace({
      sessionFile: result.sessionFile!,
      exitMarkerPath: exitMarkerPath!,
    });
    if (!idleWait.idleReached) {
      if (idleWait.exitCode !== null && idleWait.exitCode !== 0) {
        result.exitCode = idleWait.exitCode;
        result.error = result.error ?? `cmux-pane subagent exited with code ${idleWait.exitCode}`;
      } else if (idleWait.timedOut) {
        result.cmuxCloseError = "Timed out waiting for cmux-pane subagent to reach idle grace after final output";
      }
      return result;
    }

    if (idleWait.exitCode !== null && idleWait.exitCode !== 0) {
      result.exitCode = idleWait.exitCode;
      result.error = result.error ?? `cmux-pane subagent exited with code ${idleWait.exitCode}`;
      return result;
    }

    if (result.cmuxSurfaceRef) {
      const closeResult = await closeCmuxSurface(result.cmuxSurfaceRef);
      if (closeResult.ok) result.cmuxPaneClosed = true;
      else result.cmuxCloseError = closeResult.error;
    }
    return result;
  }

  result.exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processor = createPiEventProcessor(result);

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

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) processor.processLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processor.processLine(stdoutBuffer);
        processor.finalize(stderr);
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
