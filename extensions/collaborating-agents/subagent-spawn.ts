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
const CMUX_PANE_MAX_IDLE_TIMEOUT_MULTIPLIER = 6;
const CMUX_PANE_MAX_IDLE_TIMEOUT_BUFFER_MS = 60_000;

type CmuxLayoutRole = "orchestrator" | "subagent";
type CmuxSplitDirection = "right" | "down";

interface FileChangeToken {
  mtimeMs: number;
  size: number;
}

interface CmuxLayoutLeafNode {
  kind: "leaf";
  id: string;
  paneRef: string;
  surfaceRef: string;
  role: CmuxLayoutRole;
  order: number;
}

interface CmuxLayoutBranchNode {
  kind: "branch";
  id: string;
  left: CmuxLayoutNode;
  right: CmuxLayoutNode;
}

type CmuxLayoutNode = CmuxLayoutLeafNode | CmuxLayoutBranchNode;

interface CmuxLayoutLeafCandidate extends CmuxLayoutLeafNode {
  depth: number;
}

interface CmuxWorkspaceLayoutState {
  workspaceRef: string;
  orchestratorPaneRef: string;
  orchestratorSurfaceRef: string;
  root: CmuxLayoutNode;
  nextNodeId: number;
  nextOrder: number;
}

// Tracks the orchestrator + live subagent panes per workspace so we can keep
// splitting the largest managed pane instead of repeatedly shrinking the
// orchestrator pane.
const cmuxWorkspaceLayouts = new Map<string, CmuxWorkspaceLayoutState>();
let cmuxLayoutLock: Promise<void> = Promise.resolve();

function createCmuxWorkspaceLayoutState(args: {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
}): CmuxWorkspaceLayoutState {
  return {
    workspaceRef: args.workspaceRef,
    orchestratorPaneRef: args.paneRef,
    orchestratorSurfaceRef: args.surfaceRef,
    root: {
      kind: "leaf",
      id: "n0",
      paneRef: args.paneRef,
      surfaceRef: args.surfaceRef,
      role: "orchestrator",
      order: 0,
    },
    nextNodeId: 1,
    nextOrder: 1,
  };
}

function nextCmuxLayoutNodeId(state: CmuxWorkspaceLayoutState): string {
  const id = `n${state.nextNodeId}`;
  state.nextNodeId += 1;
  return id;
}

function collectCmuxLayoutLeaves(node: CmuxLayoutNode, depth = 0, leaves: CmuxLayoutLeafCandidate[] = []): CmuxLayoutLeafCandidate[] {
  if (node.kind === "leaf") {
    leaves.push({ ...node, depth });
    return leaves;
  }

  collectCmuxLayoutLeaves(node.left, depth + 1, leaves);
  collectCmuxLayoutLeaves(node.right, depth + 1, leaves);
  return leaves;
}

function findCmuxLayoutLeaf(node: CmuxLayoutNode, predicate: (leaf: CmuxLayoutLeafNode) => boolean): CmuxLayoutLeafNode | null {
  if (node.kind === "leaf") {
    return predicate(node) ? node : null;
  }

  return findCmuxLayoutLeaf(node.left, predicate) ?? findCmuxLayoutLeaf(node.right, predicate);
}

function replaceCmuxLayoutLeaf(node: CmuxLayoutNode, targetLeafId: string, replacement: CmuxLayoutNode): CmuxLayoutNode {
  if (node.kind === "leaf") {
    return node.id === targetLeafId ? replacement : node;
  }

  return {
    ...node,
    left: replaceCmuxLayoutLeaf(node.left, targetLeafId, replacement),
    right: replaceCmuxLayoutLeaf(node.right, targetLeafId, replacement),
  };
}

function removeCmuxLayoutLeaf(node: CmuxLayoutNode, predicate: (leaf: CmuxLayoutLeafNode) => boolean): CmuxLayoutNode | null {
  if (node.kind === "leaf") {
    return predicate(node) ? null : node;
  }

  const left = removeCmuxLayoutLeaf(node.left, predicate);
  const right = removeCmuxLayoutLeaf(node.right, predicate);

  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  return {
    ...node,
    left,
    right,
  };
}

function getOrCreateCmuxWorkspaceLayout(args: {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
}): CmuxWorkspaceLayoutState {
  const existing = cmuxWorkspaceLayouts.get(args.workspaceRef);
  if (!existing) {
    const created = createCmuxWorkspaceLayoutState(args);
    cmuxWorkspaceLayouts.set(args.workspaceRef, created);
    return created;
  }

  const orchestratorLeaf = findCmuxLayoutLeaf(existing.root, (leaf) => leaf.role === "orchestrator");
  if (!orchestratorLeaf || orchestratorLeaf.surfaceRef !== args.surfaceRef) {
    const reset = createCmuxWorkspaceLayoutState(args);
    cmuxWorkspaceLayouts.set(args.workspaceRef, reset);
    return reset;
  }

  orchestratorLeaf.surfaceRef = args.surfaceRef;
  existing.orchestratorSurfaceRef = args.surfaceRef;
  return existing;
}

function chooseCmuxSplitLeaf(state: CmuxWorkspaceLayoutState): CmuxLayoutLeafCandidate {
  // The shallowest leaf approximates the largest visible pane in the current
  // split tree. On ties, prefer splitting subagent panes so the orchestrator
  // stays larger for longer.
  const leaves = collectCmuxLayoutLeaves(state.root);
  const [selected] = leaves.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.role !== b.role) return a.role === "subagent" ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });

  return selected;
}

function chooseCmuxSplitDirection(splitLeaf: CmuxLayoutLeafCandidate): CmuxSplitDirection {
  // Alternate horizontal and vertical splits by tree depth so the managed pane
  // layout grows toward a grid instead of endlessly slicing columns.
  return splitLeaf.depth % 2 === 0 ? "right" : "down";
}

function applyCmuxSplitToLayout(
  state: CmuxWorkspaceLayoutState,
  splitLeaf: CmuxLayoutLeafCandidate,
  createdPaneRef: string,
  createdSurfaceRef: string,
): void {
  const newPaneLeaf: CmuxLayoutLeafNode = {
    kind: "leaf",
    id: nextCmuxLayoutNodeId(state),
    paneRef: createdPaneRef,
    surfaceRef: createdSurfaceRef,
    role: "subagent",
    order: state.nextOrder,
  };
  state.nextOrder += 1;

  state.root = replaceCmuxLayoutLeaf(state.root, splitLeaf.id, {
    kind: "branch",
    id: nextCmuxLayoutNodeId(state),
    left: {
      kind: "leaf",
      id: splitLeaf.id,
      paneRef: splitLeaf.paneRef,
      surfaceRef: splitLeaf.surfaceRef,
      role: splitLeaf.role,
      order: splitLeaf.order,
    },
    right: newPaneLeaf,
  });
}

function removeCmuxPaneFromLayout(workspaceRef: string, args: { paneRef?: string; surfaceRef?: string }): void {
  const state = cmuxWorkspaceLayouts.get(workspaceRef);
  if (!state) return;

  const nextRoot = removeCmuxLayoutLeaf(state.root, (leaf) => {
    if (leaf.role === "orchestrator") return false;
    if (args.surfaceRef && leaf.surfaceRef === args.surfaceRef) return true;
    if (args.paneRef && leaf.paneRef === args.paneRef) return true;
    return false;
  });

  if (!nextRoot) {
    cmuxWorkspaceLayouts.delete(workspaceRef);
    return;
  }

  state.root = nextRoot;
}

async function withCmuxLayoutLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = cmuxLayoutLock;
  let release!: () => void;
  cmuxLayoutLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function resetCmuxLayoutStateForTests(): void {
  cmuxWorkspaceLayouts.clear();
  cmuxLayoutLock = Promise.resolve();
}

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
    `rm -f -- "$0"`,
    `exit $status`,
  ].join('; ');
}

function createCmuxPaneLaunchScript(args: {
  piArgs: string[];
  env: Record<string, string>;
  cwd: string;
  exitMarkerPath: string;
  childName: string;
  runId: string;
}): { scriptPath: string; command: string } {
  const scriptsDir = path.join(resolveHomeDir(), ".pi", "agent", "tmp", "collaborating-agents-subagents");
  fs.mkdirSync(scriptsDir, { recursive: true });

  const safeChildName = args.childName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const scriptPath = path.join(scriptsDir, `${args.runId.slice(0, 8)}_${safeChildName}.sh`);
  const scriptBody = buildCmuxPaneCommand(args);
  const scriptContent = `#!/usr/bin/env bash\n${scriptBody}\n`;
  fs.writeFileSync(scriptPath, scriptContent, { encoding: "utf-8", mode: 0o700 });

  return {
    scriptPath,
    command: `bash ${quoteShellArg(scriptPath)}`,
  };
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

function readFileChangeToken(filePath: string): FileChangeToken | null {
  try {
    const stats = fs.statSync(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

function didFileChange(current: FileChangeToken | null, previous: FileChangeToken | null): boolean {
  if (!current) return false;
  if (!previous) return true;
  // Some session appends can preserve mtime (or land within the same filesystem
  // timestamp quantum), so use size as a second signal instead of relying on
  // mtime alone.
  return Math.abs(current.mtimeMs - previous.mtimeMs) > 0.5 || current.size !== previous.size;
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

// A cmux-pane subagent session can emit multiple assistant messages before it is
// truly done (for example, an interrupted partial response followed by more tool
// work and a later final answer). Wait for the latest assistant output to remain
// idle for a short grace period instead of returning the first non-toolUse
// message we see.
async function waitForSettledSessionResult(args: {
  sessionFile: string;
  exitMarkerPath: string;
  timeoutMs: number;
  idleGraceMs?: number;
  onUpdate?: (state: { sessionId?: string }) => void;
}): Promise<{
  sessionId?: string;
  terminalAssistantText?: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  const idleGraceMs = Math.max(100, Math.floor(args.idleGraceMs ?? CMUX_PANE_IDLE_GRACE_MS));
  // Treat timeoutMs as an inactivity budget instead of an absolute wall-clock
  // cap. Long-running research subagents can legitimately stay busy for well
  // over 10 minutes; as long as the session file keeps changing, keep waiting.
  const inactivityTimeoutMs = Math.max(idleGraceMs, Math.floor(args.timeoutMs));
  const hardTimeoutMs = Math.max(
    inactivityTimeoutMs,
    inactivityTimeoutMs * CMUX_PANE_MAX_IDLE_TIMEOUT_MULTIPLIER,
    inactivityTimeoutMs + CMUX_PANE_MAX_IDLE_TIMEOUT_BUFFER_MS,
  );
  const startedAt = Date.now();
  let activityDeadlineAt = startedAt + inactivityTimeoutMs;
  let lastObservedToken = readFileChangeToken(args.sessionFile);
  let lastParsedToken: FileChangeToken | null = null;
  let lastActivityAt = Date.now();
  let sessionId: string | undefined;
  let terminalAssistantText: string | undefined;

  while (Date.now() - startedAt < hardTimeoutMs && Date.now() < activityDeadlineAt) {
    const currentToken = readFileChangeToken(args.sessionFile);
    if (didFileChange(currentToken, lastObservedToken)) {
      lastObservedToken = currentToken;
      lastActivityAt = Date.now();
      activityDeadlineAt = lastActivityAt + inactivityTimeoutMs;
    }

    if (lastParsedToken === null || didFileChange(currentToken, lastParsedToken)) {
      const state = readSpawnSessionState(args.sessionFile);
      if (state.sessionId) {
        sessionId = state.sessionId;
        args.onUpdate?.({ sessionId });
      }
      if (state.terminalAssistantText !== undefined) {
        terminalAssistantText = state.terminalAssistantText;
      }
      if (currentToken) {
        lastParsedToken = currentToken;
      }
    }

    const exitCode = readExitMarkerCode(args.exitMarkerPath);
    if (exitCode !== null) {
      if (exitCode !== 0) {
        return { sessionId, terminalAssistantText, exitCode, timedOut: false };
      }

      // If the pane process has already exited cleanly, the session file is no
      // longer changing. Once we have a terminal assistant message, return
      // immediately instead of burning the full idle-grace budget. This keeps
      // sequential synchronous cmux spawns fast while preserving the grace
      // period for still-running panes that may emit more output.
      if (terminalAssistantText !== undefined) {
        return { sessionId, terminalAssistantText, exitCode, timedOut: false };
      }
    }

    if (terminalAssistantText !== undefined && Date.now() - lastActivityAt >= idleGraceMs) {
      return { sessionId, terminalAssistantText, exitCode, timedOut: false };
    }

    await sleep(100);
  }

  const exitCode = readExitMarkerCode(args.exitMarkerPath);
  if (exitCode !== null && exitCode !== 0) {
    return { sessionId, terminalAssistantText, exitCode, timedOut: false };
  }

  if (terminalAssistantText !== undefined && Date.now() - lastActivityAt >= idleGraceMs) {
    return { sessionId, terminalAssistantText, exitCode, timedOut: false };
  }

  return {
    sessionId,
    terminalAssistantText,
    exitCode,
    timedOut: true,
  };
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

function extractCmuxRef(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && value.startsWith(`${prefix}:`) ? value : undefined;
}

function extractCmuxRefsFromCollection(value: unknown, prefix: string, out: string[] = []): string[] {
  if (typeof value === "string") {
    const match = value.match(new RegExp(`\\b(${prefix}:\\d+)\\b`, "g"));
    if (match) out.push(...match);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractCmuxRefsFromCollection(item, prefix, out);
    return out;
  }

  if (!value || typeof value !== "object") return out;

  const record = value as Record<string, unknown>;
  const directKeys = ["ref", `${prefix}_ref`, `${prefix}Ref`, "id", `${prefix}_id`, `${prefix}Id`];
  for (const key of directKeys) {
    const ref = extractCmuxRef(record[key], prefix);
    if (ref) out.push(ref);
  }

  for (const nestedValue of Object.values(record)) {
    extractCmuxRefsFromCollection(nestedValue, prefix, out);
  }

  return out;
}

function uniqueCmuxRefs(refs: string[]): string[] {
  return [...new Set(refs)];
}

async function listCmuxPaneRefs(workspaceRef: string): Promise<string[] | null> {
  const listed = await runCmuxCommand(["--json", "list-panes", "--workspace", workspaceRef]);
  if (listed.exitCode !== 0) return null;

  const refs = uniqueCmuxRefs(extractCmuxRefsFromCollection(listed.stdout, "pane"));
  if (refs.length > 0) return refs;

  const matches = listed.stdout.match(/\bpane:\d+\b/g);
  return matches ? uniqueCmuxRefs(matches) : [];
}

async function listCmuxPaneSurfaceRefs(workspaceRef: string, paneRef: string): Promise<string[] | null> {
  const listed = await runCmuxCommand(["--json", "list-pane-surfaces", "--workspace", workspaceRef, "--pane", paneRef]);
  if (listed.exitCode !== 0) return null;

  const refs = uniqueCmuxRefs(extractCmuxRefsFromCollection(listed.stdout, "surface"));
  if (refs.length > 0) return refs;

  const matches = listed.stdout.match(/\bsurface:\d+\b/g);
  return matches ? uniqueCmuxRefs(matches) : [];
}

async function snapshotCmuxWorkspace(workspaceRef: string): Promise<Map<string, string[]>> {
  const paneRefs = await listCmuxPaneRefs(workspaceRef);
  if (!paneRefs || paneRefs.length === 0) return new Map();

  const snapshot = new Map<string, string[]>();
  for (const paneRef of paneRefs) {
    const surfaceRefs = await listCmuxPaneSurfaceRefs(workspaceRef, paneRef);
    if (!surfaceRefs) continue;
    snapshot.set(paneRef, [...surfaceRefs]);
  }

  return snapshot;
}

function findSurfacePaneRef(snapshot: Map<string, string[]>, surfaceRef: string): string | undefined {
  for (const [paneRef, surfaceRefs] of snapshot.entries()) {
    if (surfaceRefs.includes(surfaceRef)) return paneRef;
  }
  return undefined;
}

function syncCmuxLayoutStateWithSnapshot(state: CmuxWorkspaceLayoutState, snapshot: Map<string, string[]>): void {
  const paneRefs = new Set(snapshot.keys());

  const leaves = collectCmuxLayoutLeaves(state.root);
  for (const leaf of leaves) {
    const actualPaneRef = findSurfacePaneRef(snapshot, leaf.surfaceRef);
    if (actualPaneRef) {
      if (!paneRefs.has(leaf.paneRef)) {
        leaf.paneRef = actualPaneRef;
      }
      continue;
    }

    if (leaf.role === "subagent") {
      removeCmuxPaneFromLayout(state.workspaceRef, {
        paneRef: leaf.paneRef,
        surfaceRef: leaf.surfaceRef,
      });
    }
  }

  const orchestratorLeaf = findCmuxLayoutLeaf(state.root, (leaf) => leaf.role === "orchestrator");
  const actualOrchestratorPane = orchestratorLeaf ? findSurfacePaneRef(snapshot, orchestratorLeaf.surfaceRef) : undefined;
  if (orchestratorLeaf && actualOrchestratorPane && !paneRefs.has(orchestratorLeaf.paneRef)) {
    orchestratorLeaf.paneRef = actualOrchestratorPane;
    state.orchestratorPaneRef = actualOrchestratorPane;
  }
}

async function moveCmuxSurfaceToPane(args: {
  workspaceRef: string;
  surfaceRef: string;
  targetPaneRef: string;
}): Promise<boolean> {
  const moved = await runCmuxCommand([
    "move-surface",
    "--workspace",
    args.workspaceRef,
    "--surface",
    args.surfaceRef,
    "--pane",
    args.targetPaneRef,
  ]);
  return moved.exitCode === 0;
}

async function reorderCmuxSurfaceBefore(args: {
  workspaceRef: string;
  surfaceRef: string;
  beforeSurfaceRef: string;
}): Promise<boolean> {
  const reordered = await runCmuxCommand([
    "reorder-surface",
    "--workspace",
    args.workspaceRef,
    "--surface",
    args.surfaceRef,
    "--before",
    args.beforeSurfaceRef,
  ]);
  return reordered.exitCode === 0;
}

async function rebalanceCmuxWorkspaceSurfaces(state: CmuxWorkspaceLayoutState): Promise<void> {
  // Phase 2: after choosing a balanced split target, reconcile the live cmux
  // workspace back to the planned pane assignment using move/reorder operations.
  const snapshot = await snapshotCmuxWorkspace(state.workspaceRef);
  if (snapshot.size === 0) return;

  const desiredLeaves = collectCmuxLayoutLeaves(state.root);
  const surfaceToPane = new Map<string, string>();
  for (const [paneRef, surfaceRefs] of snapshot.entries()) {
    for (const surfaceRef of surfaceRefs) {
      surfaceToPane.set(surfaceRef, paneRef);
    }
  }

  for (const leaf of desiredLeaves) {
    const currentPaneRef = surfaceToPane.get(leaf.surfaceRef);
    if (!currentPaneRef || currentPaneRef === leaf.paneRef) continue;
    if (!snapshot.has(leaf.paneRef)) continue;

    const targetPaneSurfaces = snapshot.get(leaf.paneRef) ?? [];
    const orderAnchor = targetPaneSurfaces.find((surfaceRef) => surfaceRef !== leaf.surfaceRef);

    const moved = await moveCmuxSurfaceToPane({
      workspaceRef: state.workspaceRef,
      surfaceRef: leaf.surfaceRef,
      targetPaneRef: leaf.paneRef,
    });
    if (!moved) continue;

    const sourcePaneSurfaces = snapshot.get(currentPaneRef);
    if (sourcePaneSurfaces) {
      snapshot.set(
        currentPaneRef,
        sourcePaneSurfaces.filter((surfaceRef) => surfaceRef !== leaf.surfaceRef),
      );
    }
    snapshot.set(leaf.paneRef, [...targetPaneSurfaces.filter((surfaceRef) => surfaceRef !== leaf.surfaceRef), leaf.surfaceRef]);
    surfaceToPane.set(leaf.surfaceRef, leaf.paneRef);

    if (orderAnchor) {
      const reordered = await reorderCmuxSurfaceBefore({
        workspaceRef: state.workspaceRef,
        surfaceRef: leaf.surfaceRef,
        beforeSurfaceRef: orderAnchor,
      });
      if (reordered) {
        const updatedTargetPaneSurfaces = snapshot.get(leaf.paneRef) ?? [];
        snapshot.set(leaf.paneRef, [leaf.surfaceRef, ...updatedTargetPaneSurfaces.filter((surfaceRef) => surfaceRef !== leaf.surfaceRef)]);
      }
    }
  }
}

async function createCmuxSplit(args: {
  workspaceRef: string;
  targetPaneRef: string;
  targetSurfaceRef: string;
  direction: CmuxSplitDirection;
}): Promise<
  | {
      ok: true;
      stdout: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const attempts: string[][] = [
    ["new-split", args.direction, "--workspace", args.workspaceRef, "--panel", args.targetPaneRef],
    ["new-split", args.direction, "--workspace", args.workspaceRef, "--surface", args.targetSurfaceRef],
  ];

  const seen = new Set<string>();
  const errors: string[] = [];

  for (const commandArgs of attempts) {
    const key = commandArgs.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);

    const result = await runCmuxCommand(commandArgs);
    if (result.exitCode === 0) {
      return { ok: true, stdout: result.stdout };
    }

    errors.push(result.stderr || result.stdout || `cmux ${commandArgs[0]} failed`);
  }

  return { ok: false, error: errors.filter(Boolean).join(" | ") || "Failed to create cmux pane" };
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
  return await withCmuxLayoutLock(async () => {
    const identify = await runCmuxCommand(["identify", "--json"]);
    if (identify.exitCode !== 0) {
      return { ok: false, error: identify.stderr || identify.stdout || "Failed to identify current cmux surface" };
    }

    const callerContext = parseCmuxIdentify(identify.stdout);
    if (!callerContext) {
      return { ok: false, error: "cmux pane launch requires running inside a cmux terminal surface" };
    }

    const layoutState = getOrCreateCmuxWorkspaceLayout(callerContext);
    const beforeSnapshot = await snapshotCmuxWorkspace(callerContext.workspaceRef);
    if (beforeSnapshot.size > 0) {
      syncCmuxLayoutStateWithSnapshot(layoutState, beforeSnapshot);
    }
    let splitTarget = chooseCmuxSplitLeaf(layoutState);
    let splitDirection = chooseCmuxSplitDirection(splitTarget);

    let split = await createCmuxSplit({
      workspaceRef: callerContext.workspaceRef,
      targetPaneRef: splitTarget.paneRef,
      targetSurfaceRef: splitTarget.surfaceRef,
      direction: splitDirection,
    });

    if (!split.ok && splitTarget.role !== "orchestrator") {
      removeCmuxPaneFromLayout(callerContext.workspaceRef, {
        paneRef: splitTarget.paneRef,
        surfaceRef: splitTarget.surfaceRef,
      });
      splitTarget = chooseCmuxSplitLeaf(layoutState);
      splitDirection = chooseCmuxSplitDirection(splitTarget);
      split = await createCmuxSplit({
        workspaceRef: callerContext.workspaceRef,
        targetPaneRef: splitTarget.paneRef,
        targetSurfaceRef: splitTarget.surfaceRef,
        direction: splitDirection,
      });
    }

    if (!split.ok) {
      return { ok: false, error: split.error };
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

    applyCmuxSplitToLayout(layoutState, splitTarget, paneContext.paneRef, paneContext.surfaceRef);

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

    await rebalanceCmuxWorkspaceSurfaces(layoutState);

    const postRebalanceIdentify = await runCmuxCommand([
      "identify",
      "--json",
      "--workspace",
      paneContext.workspaceRef,
      "--surface",
      paneContext.surfaceRef,
    ]);
    const postRebalanceContext =
      postRebalanceIdentify.exitCode === 0 ? parseCmuxIdentify(postRebalanceIdentify.stdout) : null;
    if (postRebalanceContext) {
      const newPaneLeaf = findCmuxLayoutLeaf(layoutState.root, (leaf) => leaf.surfaceRef === paneContext.surfaceRef);
      if (newPaneLeaf) newPaneLeaf.paneRef = postRebalanceContext.paneRef;
      paneContext.paneRef = postRebalanceContext.paneRef;
    }

    return {
      ok: true,
      workspaceRef: paneContext.workspaceRef,
      paneRef: paneContext.paneRef,
      surfaceRef: paneContext.surfaceRef,
    };
  });
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
    cmuxResultTimeoutMs?: number;
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
  const cmuxResultTimeoutMs = Math.max(100, Math.floor(options.cmuxResultTimeoutMs ?? 600_000));

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

    const cmuxLaunchScript = createCmuxPaneLaunchScript({
      piArgs: args,
      env: cmuxLaunchEnv,
      cwd,
      exitMarkerPath: exitMarkerPath!,
      childName,
      runId: options.runId,
    });

    const cmuxLaunch = await launchCmuxPane({ scriptPath: cmuxLaunchScript.command });

    if (!cmuxLaunch.ok) {
      try {
        fs.unlinkSync(cmuxLaunchScript.scriptPath);
      } catch {
        // ignore best-effort cleanup failures
      }
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

    const sessionState = await waitForSettledSessionResult({
      sessionFile: result.sessionFile!,
      exitMarkerPath: exitMarkerPath!,
      timeoutMs: cmuxResultTimeoutMs,
      onUpdate: (state) => {
        if (state.sessionId) result.sessionId = state.sessionId;
      },
    });

    if (sessionState.exitCode !== null && sessionState.exitCode !== 0) {
      result.sessionId = sessionState.sessionId ?? result.sessionId;
      result.output = sessionState.terminalAssistantText || "(no output)";
      result.exitCode = sessionState.exitCode;

      if (sessionState.terminalAssistantText === undefined) {
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
        if (paneScreen.stdout) {
          result.output = paneScreen.stdout;
          result.error = paneScreen.stdout;
        }
      }

      result.error = result.error ?? `cmux-pane subagent exited with code ${sessionState.exitCode}`;
      return result;
    }

    if (sessionState.terminalAssistantText === undefined || sessionState.timedOut) {
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
      result.error = paneScreen.stdout || "Timed out waiting for settled subagent response in cmux pane";
      result.output = result.error;
      return result;
    }

    result.sessionId = sessionState.sessionId ?? result.sessionId;
    result.output = sessionState.terminalAssistantText || "(no output)";
    result.exitCode = sessionState.exitCode ?? 0;

    if (result.exitCode !== 0) {
      result.error = result.error ?? `cmux-pane subagent exited with code ${result.exitCode}`;
      return result;
    }

    if (options.closeCompletedCmuxPane === false) {
      return result;
    }

    if (result.cmuxSurfaceRef) {
      const closeResult = await closeCmuxSurface(result.cmuxSurfaceRef);
      if (closeResult.ok) {
        result.cmuxPaneClosed = true;
        if (result.cmuxWorkspaceRef) {
          await withCmuxLayoutLock(async () => {
            removeCmuxPaneFromLayout(result.cmuxWorkspaceRef!, {
              paneRef: result.cmuxPaneRef,
              surfaceRef: result.cmuxSurfaceRef,
            });
          });
        }
      }
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
