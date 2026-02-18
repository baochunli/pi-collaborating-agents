import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, matchesKey, type TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { MessagesOverlay } from "./overlays/messages-overlay.js";
import { loadConfig } from "./config.js";
import { resolveDirs } from "./paths.js";
import {
  getAgentByName,
  getConflictsWithOtherAgents,
  listActiveAgents,
  processInbox,
  readMessageLog,
  readMessageLogTail,
  clearMessageLog,
  registerSelf,
  sendBroadcast,
  sendDirect,
  unregisterSelf,
  updateSelfHeartbeat,
} from "./store.js";
import { registerRenderers } from "./renderers.js";
import type {
  AgentMessageAction,
  AgentRegistration,
  AgentRole,
  CollaboratingAgentsConfig,
  ExtensionState,
  InboxMessage,
  MessageLogEvent,
} from "./types.js";
import {
  createDefaultSpawnAgentDefinition,
  mapWithConcurrencyLimit,
  runSpawnTask,
  type SpawnAgentDefinition,
  type SpawnResult,
  type SpawnTask,
} from "./subagent-spawn.js";

const STATUS_KEY = "collab";
const WATCH_DEBOUNCE_MS = 40;
const REMOTE_SESSION_REFRESH_MS = 1000;

const ADJECTIVES = ["Swift", "Calm", "Bright", "Vivid", "Rapid", "Lunar", "Cedar", "Amber"];
const NOUNS = ["Tiger", "Falcon", "River", "Quartz", "Harbor", "Nova", "Pine", "Raven"];

function generateName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? "Agent";
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? "Node";
  return `${a}${n}`;
}

function getInitialAgentName(): string {
  const envName = process.env.PI_AGENT_NAME?.trim();
  return envName && envName.length > 0 ? envName : generateName();
}

const AGENT_MESSAGE_ACTIONS = [
  "status",
  "list",
  "send",
  "broadcast",
  "feed",
  "thread",
  "reserve",
  "release",
] as const;

const AgentMessageParams = Type.Object({
  action: StringEnum(AGENT_MESSAGE_ACTIONS, {
    description: "Action: status | list | send | broadcast | feed | thread | reserve | release",
  }),
  to: Type.Optional(Type.String({ description: "Target agent name (required for send/thread)" })),
  message: Type.Optional(Type.String({ description: "Message text (required for send/broadcast)" })),
  replyTo: Type.Optional(Type.String({ description: "Reply message id (optional, for send)" })),
  urgent: Type.Optional(
    Type.Boolean({
      description: "If true, interrupt recipients immediately. If false, queue after current turn.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max messages to return (feed/thread), default 20" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Reservation path patterns (reserve/release)" })),
  reason: Type.Optional(Type.String({ description: "Optional reservation reason (reserve)" })),
});

const SubagentTaskItem = Type.Object({
  task: Type.String({ description: "Task prompt for the spawned subagent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Single-mode task prompt" })),
  tasks: Type.Optional(Type.Array(SubagentTaskItem, { description: "Parallel-mode tasks" })),
  cwd: Type.Optional(Type.String({ description: "Default working directory for spawned subagents" })),
  sessionControl: Type.Optional(Type.Boolean({ description: "Spawn children with --session-control (default true)" })),
});

const SUBAGENT_MAX_PARALLEL = 8;
const SUBAGENT_MAX_CONCURRENCY = 4;
const SUBAGENT_DEFAULT_MAX_DEPTH = 2;

function formatToolCallArgs(args: unknown): string {
  const json = JSON.stringify(args, null, 2) ?? "{}";
  const maxChars = 2000;
  return json.length > maxChars ? `${json.slice(0, maxChars)}\n…(truncated)` : json;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default function collaboratingAgentsExtension(pi: ExtensionAPI): void {
  const dirs = resolveDirs();

  const state: ExtensionState = {
    agentName: getInitialAgentName(),
    registered: false,
    focus: { mode: "local" },
    reservations: [],
    unreadCounts: new Map(),
    watcher: null,
    watcherDebounceTimer: null,
    hasClearedSubagentHistory: false,
    hasSpawnedSubagents: false,
    completedSubagents: [],
    activeSubagentRuns: 0,
  };

  let config: CollaboratingAgentsConfig = loadConfig(process.cwd());
  let startedAt = new Date().toISOString();
  let lastContext: ExtensionContext | null = null;

  let localSessionFile: string | undefined;
  let coordinatorSessionFile: string | undefined;
  let coordinatorSessionId: string | undefined;
  let coordinatorCwd: string | undefined;
  let coordinatorModel: string | undefined;

  let remoteSessionRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let remoteSessionRefreshPath: string | undefined;
  let remoteSessionRefreshMtime = 0;
  let remoteSessionRefreshSize = 0;
  let remoteSessionRefreshRunning = false;
  let remoteSessionRefreshScheduled = false;
  let remoteSessionSwitchContext: ExtensionCommandContext | null = null;

  registerRenderers(pi);

  function getCurrentAgentRole(): AgentRole | undefined {
    if (state.hasSpawnedSubagents) return "orchestrator";

    const depthRaw = Number(process.env.PI_COLLAB_SUBAGENT_DEPTH ?? "0");
    if (Number.isFinite(depthRaw) && depthRaw > 0) return "subagent";
    return undefined;
  }

  function withRoleLabel(name: string, role: AgentRole | undefined): string {
    const displayName = formatAgentDisplayName(name);
    if (!role) return displayName;
    return `${displayName} (${role})`;
  }

  function buildRegistration(ctx: ExtensionContext): AgentRegistration {
    return {
      name: state.agentName,
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      cwd: ctx.cwd,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      startedAt,
      lastSeenAt: new Date().toISOString(),
      role: getCurrentAgentRole(),
      reservations: state.reservations.length > 0 ? [...state.reservations] : undefined,
    };
  }

  function rememberCoordinatorSession(ctx: ExtensionContext): void {
    if (process.env.PI_AGENT_NAME) return;
    if (coordinatorSessionFile) return;

    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    if (!sessionFile) return;

    coordinatorSessionFile = sessionFile;
    coordinatorSessionId = ctx.sessionManager.getSessionId();
    coordinatorCwd = ctx.cwd;
    coordinatorModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  }

  function buildCoordinatorSwitchEntry(): AgentRegistration | undefined {
    if (!coordinatorSessionFile) return undefined;

    return {
      name: state.agentName,
      pid: process.pid,
      sessionId: coordinatorSessionId ?? "local-session",
      sessionFile: coordinatorSessionFile,
      cwd: coordinatorCwd ?? process.cwd(),
      model: coordinatorModel ?? "unknown",
      startedAt,
      lastSeenAt: new Date().toISOString(),
      role: getCurrentAgentRole(),
    };
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const activePeers = listActiveAgents(dirs, state.agentName);
    const peers = activePeers.length;
    const unread = Array.from(state.unreadCounts.values()).reduce((n, v) => n + v, 0);

    const focusText =
      state.focus.mode === "local"
        ? ctx.ui.theme.fg("dim", "local")
        : ctx.ui.theme.fg(
            "warning",
            withRoleLabel(
              state.focus.targetAgent,
              activePeers.find((peer) => peer.name === state.focus.targetAgent)?.role,
            ),
          );

    const unreadText = unread > 0 ? ctx.ui.theme.fg("accent", ` ●${unread}`) : "";
    const reservationText =
      state.reservations.length > 0 ? ctx.ui.theme.fg("warning", ` 🔒${state.reservations.length}`) : "";

    const selfLabel = withRoleLabel(state.agentName, getCurrentAgentRole());
    const label = `${ctx.ui.theme.fg("accent", selfLabel)} ${ctx.ui.theme.fg("dim", `(${peers} peers)`)} ${ctx.ui.theme.fg("dim", "focus:")} ${focusText}${reservationText}${unreadText}`;
    ctx.ui.setStatus(STATUS_KEY, label);
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function ensureRegistered(ctx: ExtensionContext): boolean {
    rememberCoordinatorSession(ctx);
    if (state.registered) return true;

    const explicit = Boolean(process.env.PI_AGENT_NAME);

    const tryRegister = (name: string): boolean => {
      state.agentName = name;
      const ok = registerSelf(dirs, buildRegistration(ctx));
      if (ok) {
        state.registered = true;
        rememberCoordinatorSession(ctx);
        return true;
      }
      return false;
    };

    if (explicit) {
      if (!tryRegister(state.agentName)) {
        ctx.ui.notify(`collaborating-agents: name '${state.agentName}' already in use`, "error");
        return false;
      }
      return true;
    }

    if (tryRegister(state.agentName)) return true;

    for (let i = 2; i <= 50; i++) {
      if (tryRegister(`${state.agentName}${i}`)) return true;
    }

    ctx.ui.notify("collaborating-agents: failed to find an available agent name", "error");
    return false;
  }

  function refreshRegistration(ctx: ExtensionContext): void {
    if (!state.registered) return;
    updateSelfHeartbeat(dirs, buildRegistration(ctx));
  }

  function stopWatcher(): void {
    if (state.watcherDebounceTimer) {
      clearTimeout(state.watcherDebounceTimer);
      state.watcherDebounceTimer = null;
    }
    if (state.watcher) {
      state.watcher.close();
      state.watcher = null;
    }
  }

  function deliverInboxMessage(msg: InboxMessage): void {
    if (msg.from !== state.agentName) {
      const current = state.unreadCounts.get(msg.from) ?? 0;
      state.unreadCounts.set(msg.from, current + 1);
    }

    const senderLabel = formatAgentDisplayName(msg.from);
    const prefix =
      msg.kind === "broadcast"
        ? `${msg.urgent ? "Urgent " : ""}broadcast message from ${senderLabel}:`
        : `${msg.urgent ? "Urgent " : ""}direct message from ${senderLabel}:`;
    const content = `${prefix}\n\n${msg.text}`;

    const custom = {
      customType: "collab_inbox_message",
      content,
      display: true,
      details: {
        ...msg,
        senderLabel,
      },
    };

    const deliverAs = msg.urgent ? "steer" : "followUp";
    pi.sendMessage(custom, { triggerTurn: true, deliverAs });
  }

  function processInboxNow(): void {
    if (!state.registered) return;
    processInbox(dirs, state.agentName, deliverInboxMessage);
    if (lastContext) updateStatus(lastContext);
  }

  function startWatcher(ctx: ExtensionContext): void {
    stopWatcher();

    const inboxPath = join(dirs.inbox, state.agentName);
    fs.mkdirSync(inboxPath, { recursive: true });

    processInboxNow();

    try {
      state.watcher = fs.watch(inboxPath, () => {
        if (state.watcherDebounceTimer) clearTimeout(state.watcherDebounceTimer);
        state.watcherDebounceTimer = setTimeout(() => {
          state.watcherDebounceTimer = null;
          processInboxNow();
          refreshRegistration(ctx);
        }, WATCH_DEBOUNCE_MS);
      });
    } catch {
      ctx.ui.notify("collaborating-agents: failed to start inbox watcher", "warning");
    }
  }

  function canSwitchSession(ctx: ExtensionContext): ctx is ExtensionCommandContext {
    return typeof (ctx as ExtensionCommandContext).switchSession === "function";
  }

  function rememberSwitchSessionContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
    if (!canSwitchSession(ctx)) return false;
    remoteSessionSwitchContext = ctx;
    return true;
  }

  function getSwitchSessionContext(ctx: ExtensionContext): ExtensionCommandContext | null {
    if (rememberSwitchSessionContext(ctx)) {
      return ctx;
    }
    return remoteSessionSwitchContext;
  }

  function getSessionFileFingerprint(sessionFile: string): { mtimeMs: number; size: number } | null {
    try {
      const stats = fs.statSync(sessionFile);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  function stopRemoteSessionAutoRefresh(): void {
    if (remoteSessionRefreshTimer) {
      clearInterval(remoteSessionRefreshTimer);
      remoteSessionRefreshTimer = null;
    }

    remoteSessionRefreshPath = undefined;
    remoteSessionRefreshMtime = 0;
    remoteSessionRefreshSize = 0;
    remoteSessionRefreshRunning = false;
    remoteSessionRefreshScheduled = false;
  }

  async function refreshRemoteSessionIfChanged(ctx: ExtensionCommandContext): Promise<void> {
    if (!remoteSessionRefreshPath) return;
    if (state.focus.mode !== "remote") return;

    const currentSessionFile = ctx.sessionManager.getSessionFile();
    if (!currentSessionFile || currentSessionFile !== remoteSessionRefreshPath) return;

    const fingerprint = getSessionFileFingerprint(remoteSessionRefreshPath);
    if (!fingerprint) {
      stopRemoteSessionAutoRefresh();
      focusLocal(ctx);
      return;
    }

    if (fingerprint.size === remoteSessionRefreshSize && fingerprint.mtimeMs === remoteSessionRefreshMtime) return;
    if (remoteSessionRefreshRunning) return;

    remoteSessionRefreshRunning = true;
    try {
      const result = await ctx.switchSession(remoteSessionRefreshPath);
      if (result.cancelled) return;
      remoteSessionRefreshMtime = fingerprint.mtimeMs;
      remoteSessionRefreshSize = fingerprint.size;
    } catch {
      // best effort: keep timer running and try again on next interval
    } finally {
      remoteSessionRefreshRunning = false;
    }
  }

  function queueRemoteSessionRefresh(ctx: ExtensionCommandContext): void {
    if (remoteSessionRefreshScheduled || remoteSessionRefreshPath === undefined) return;
    remoteSessionRefreshScheduled = true;

    queueMicrotask(() => {
      remoteSessionRefreshScheduled = false;
      void refreshRemoteSessionIfChanged(ctx);
    });
  }

  function startRemoteSessionAutoRefresh(ctx: ExtensionContext): void {
    const switchCtx = getSwitchSessionContext(ctx);
    if (!switchCtx) {
      stopRemoteSessionAutoRefresh();
      return;
    }

    if (state.focus.mode !== "remote") {
      stopRemoteSessionAutoRefresh();
      return;
    }

    const targetSessionFile = switchCtx.sessionManager.getSessionFile();
    if (!targetSessionFile || targetSessionFile === localSessionFile || !fs.existsSync(targetSessionFile)) {
      stopRemoteSessionAutoRefresh();
      return;
    }

    const fingerprint = getSessionFileFingerprint(targetSessionFile);
    if (!fingerprint) {
      stopRemoteSessionAutoRefresh();
      return;
    }

    stopRemoteSessionAutoRefresh();

    remoteSessionRefreshPath = targetSessionFile;
    remoteSessionRefreshMtime = fingerprint.mtimeMs;
    remoteSessionRefreshSize = fingerprint.size;

    remoteSessionRefreshTimer = setInterval(() => {
      queueRemoteSessionRefresh(switchCtx);
    }, REMOTE_SESSION_REFRESH_MS);
    remoteSessionRefreshTimer.unref?.();
  }

  async function trySwitchToAgentSession(
    ctx: ExtensionContext,
    target: AgentRegistration,
    options?: { allowMissingSessionFile?: boolean },
  ): Promise<boolean> {
    if (!canSwitchSession(ctx)) {
      ctx.ui.notify("Session switching is not available from this context.", "warning");
      return false;
    }

    if (!target.sessionFile) return false;
    if (!options?.allowMissingSessionFile && !fs.existsSync(target.sessionFile)) return false;

    try {
      const result = await ctx.switchSession(target.sessionFile);
      if (result.cancelled) return false;
      ctx.ui.notify(`Switched to active session: ${target.name}`, "info");
      return true;
    } catch {
      return false;
    }
  }


  function focusLocal(ctx: ExtensionContext): void {
    state.focus = { mode: "local" };
    stopRemoteSessionAutoRefresh();
    updateStatus(ctx);
  }

  function focusRemote(target: AgentRegistration, ctx: ExtensionContext): void {
    state.focus = {
      mode: "remote",
      targetAgent: target.name,
      targetSessionId: target.sessionId,
    };
    updateStatus(ctx);
  }

  function syncFocusToCurrentSession(ctx: ExtensionContext): void {
    const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

    if (!currentSessionFile) {
      focusLocal(ctx);
      return;
    }

    if (currentSessionFile === localSessionFile) {
      focusLocal(ctx);
      return;
    }

    const agents = listActiveAgents(dirs);
    const matchedPeer = agents.find(
      (agent) => agent.sessionFile === currentSessionFile && agent.name !== state.agentName,
    );

    if (matchedPeer) {
      focusRemote(matchedPeer, ctx);
      return;
    }

    if (coordinatorSessionFile && currentSessionFile === coordinatorSessionFile) {
      focusLocal(ctx);
      return;
    }

    if (state.focus.mode === "remote" && state.focus.targetSessionId) {
      const stillRemote = agents.some((agent) => agent.sessionId === state.focus.targetSessionId);
      if (!stillRemote) {
        focusLocal(ctx);
        return;
      }
    } else {
      focusLocal(ctx);
    }
  }

  function normalizeLimit(raw: number | undefined, fallback = 20, max = 500): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
    return Math.max(1, Math.min(max, Math.floor(raw)));
  }

  function formatMessageEvent(event: MessageLogEvent): string {
    const timestamp = new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const target = event.to === "all" ? "all" : String(event.to);
    const text = event.text.length > 240 ? `${event.text.slice(0, 237)}...` : event.text;
    const priority = event.urgent ? " [urgent]" : "";
    return `${timestamp}${priority} ${event.from} -> ${target}: ${text}`;
  }

  function formatAgentDisplayName(agentName: string): string {
    const callsignMatch = agentName.match(/-([A-Z][a-z]+[A-Z][A-Za-z]+)$/);
    if (callsignMatch?.[1]) return callsignMatch[1];
    return agentName;
  }

  function normalizeReservationPaths(paths: string[] | undefined): string[] {
    if (!Array.isArray(paths)) return [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const raw of paths) {
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }

    return out;
  }

  const BROAD_RESERVATION_PATTERNS = new Set([".", "/", "./", "..", "../", ""]);

  function validateReservationPattern(pattern: string): { valid: boolean; warning?: string } {
    if (!pattern || pattern.trim() === "") {
      return { valid: false };
    }

    const stripped = pattern.replace(/\/+$/, "");
    if (BROAD_RESERVATION_PATTERNS.has(stripped) || BROAD_RESERVATION_PATTERNS.has(pattern)) {
      return {
        valid: true,
        warning: `"${pattern}" is very broad and will block most file operations for other agents.`,
      };
    }

    const segments = pattern.replace(/\/+$/, "").split("/").filter(Boolean);
    if (segments.length === 1 && pattern.endsWith("/")) {
      return {
        valid: true,
        warning: `"${pattern}" covers an entire top-level directory. Consider reserving a more specific path.`,
      };
    }

    return { valid: true };
  }

  function reservePaths(paths: string[], reason?: string): void {
    const since = new Date().toISOString();
    const normalizedReason = reason?.trim() ? reason.trim() : undefined;

    for (const pattern of paths) {
      state.reservations = state.reservations.filter((reservation) => reservation.pattern !== pattern);
      state.reservations.push({ pattern, reason: normalizedReason, since });
    }
  }

  function releasePaths(paths?: string[]): string[] {
    if (!paths || paths.length === 0) {
      const released = state.reservations.map((reservation) => reservation.pattern);
      state.reservations = [];
      return released;
    }

    const releaseSet = new Set(paths);
    const released = state.reservations
      .filter((reservation) => releaseSet.has(reservation.pattern))
      .map((reservation) => reservation.pattern);

    state.reservations = state.reservations.filter((reservation) => !releaseSet.has(reservation.pattern));
    return released;
  }

  function resolveModelByProviderFallback(args: {
    provider: string;
    modelId: string;
    modelRegistry: ExtensionContext["modelRegistry"];
  }): { model?: string; warning?: string } {
    const requestedModel = args.modelId.trim();
    const requestedProvider = args.provider.trim();

    const availableModels = args.modelRegistry.getAll();
    const providerModels = availableModels.filter(
      (model) => model.provider.toLowerCase() === requestedProvider.toLowerCase(),
    );

    if (providerModels.length === 0) return { model: undefined };

    const requested = `${requestedProvider}/${requestedModel}`;
    const exact = providerModels.find((model) => model.id.toLowerCase() === requestedModel.toLowerCase());
    if (exact) {
      return { model: `${exact.provider}/${exact.id}` };
    }

    let candidate = requestedModel;
    while (candidate.length > 0) {
      const lastHyphen = candidate.lastIndexOf("-");
      const lastUnderscore = candidate.lastIndexOf("_");
      const cut = Math.max(lastHyphen, lastUnderscore);
      if (cut <= 0) break;

      candidate = candidate.slice(0, cut);
      const fallback = providerModels.find((model) => model.id.toLowerCase() === candidate.toLowerCase());
      if (fallback) {
        return {
          model: `${fallback.provider}/${fallback.id}`,
          warning: `Requested model ${requested} is unavailable; using ${fallback.provider}/${fallback.id} for subagents.`,
        };
      }
    }

    const fallbackModel = providerModels[0];
    return {
      model: `${fallbackModel.provider}/${fallbackModel.id}`,
      warning: `Requested model ${requested} is unavailable; using ${fallbackModel.provider}/${fallbackModel.id} for subagents.`,
    };
  }

  function getSubagentDepthState(): { depth: number; maxDepth: number; blocked: boolean } {
    const depthRaw = Number(process.env.PI_COLLAB_SUBAGENT_DEPTH ?? "0");
    const maxRaw = Number(process.env.PI_COLLAB_SUBAGENT_MAX_DEPTH ?? String(SUBAGENT_DEFAULT_MAX_DEPTH));
    const depth = Number.isFinite(depthRaw) ? depthRaw : 0;
    const maxDepth = Number.isFinite(maxRaw) ? maxRaw : SUBAGENT_DEFAULT_MAX_DEPTH;
    return { depth, maxDepth, blocked: depth >= maxDepth };
  }

  function formatSingleSubagentLaunchBlock(profile: string, result: SpawnResult): string {
    const launchLines = [
      "## Subagent Launch Details",
      `Spawning subagent **${formatAgentDisplayName(result.name)}** with the prompt:`,
      "",
      "```text",
      result.launchPrompt,
      "```",
      "",
      `- **Profile:** ${profile}`,
      `- **Runtime subagent name:** ${result.name}`,
      `- **Session ID:** ${result.sessionId ?? "(not reported)"}`,
      `- **Working directory:** ${result.workingDirectory}`,
      `- **Model used:** ${result.resolvedModel ?? "(default model)"}`,
      `- **Tools enabled:** ${result.resolvedTools && result.resolvedTools.length > 0 ? result.resolvedTools.join(", ") : "(default tools)"}`,
      `- **Parent routing:** ${result.coordinator ? `direct updates to ${result.coordinator}` : "no parent specified"}`,
      `- **Launch environment:** PI_AGENT_NAME=${result.launchEnv.PI_AGENT_NAME}, PI_COLLAB_SUBAGENT_DEPTH=${result.launchEnv.PI_COLLAB_SUBAGENT_DEPTH}`,
    ];

    return launchLines.join("\n");
  }

  function formatParallelSubagentLaunchBlock(profile: string, result: SpawnResult, index: number): string {
    const lines = [
      `### Launch ${index + 1}`,
      `Spawning subagent **${formatAgentDisplayName(result.name)}** with the prompt:`,
      "",
      "```text",
      result.launchPrompt,
      "```",
      "",
      `- Profile: ${profile}`,
      `- Runtime subagent name: ${result.name}`,
      `- Session ID: ${result.sessionId ?? "(not reported)"}`,
      `- Working directory: ${result.workingDirectory}`,
    ];

    return lines.join("\n");
  }

  async function executeSubagentParams(
    params: {
      task?: string;
      tasks?: Array<{ task: string; cwd?: string }>;
      cwd?: string;
      sessionControl?: boolean;
    },
    ctx: ExtensionContext,
    options?: {
      includeLaunchBlock?: boolean;
      onLaunch?: (payload: {
        profile: string;
        launch: SpawnResult;
      }) => void | Promise<void>;
    },
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }> {
    const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
    const hasParallel = (params.tasks?.length ?? 0) > 0;

    if (Number(hasSingle) + Number(hasParallel) !== 1) {
      return {
        content: [{ type: "text", text: "Provide exactly one mode: task or tasks[]" }],
        isError: true,
        details: { mode: "subagent", error: "invalid_params" },
      };
    }

    if (!ensureRegistered(ctx)) {
      return {
        content: [{ type: "text", text: "Failed to register local agent before spawning subagents." }],
        isError: true,
        details: { mode: "subagent", error: "registration_failed" },
      };
    }

    if (!state.watcher) startWatcher(ctx);
    refreshRegistration(ctx);

    if (!process.env.PI_AGENT_NAME && !state.hasClearedSubagentHistory) {
      clearMessageLog(dirs);
      state.hasClearedSubagentHistory = true;
    }

    const depthState = getSubagentDepthState();
    if (depthState.blocked) {
      return {
        content: [
          {
            type: "text",
            text: `Subagent spawn blocked (depth=${depthState.depth}, max=${depthState.maxDepth}).`,
          },
        ],
        isError: true,
        details: { mode: "subagent", error: "max_depth_reached", depth: depthState.depth, maxDepth: depthState.maxDepth },
      };
    }

    markAsOrchestrator(ctx);

    const runId = randomUUID().slice(0, 8);
    const enableSessionControl = params.sessionControl !== false;
    const includeLaunchBlock = options?.includeLaunchBlock ?? true;

    const defaultAgent = createDefaultSpawnAgentDefinition("subagent");
    const resolvedModel = ctx.model
      ? resolveModelByProviderFallback({
          provider: ctx.model.provider,
          modelId: ctx.model.id,
          modelRegistry: ctx.modelRegistry,
        })
      : { model: undefined };

    const runtimeAgent: SpawnAgentDefinition = {
      ...defaultAgent,
      model: resolvedModel.model || defaultAgent.model,
    };

    if (hasSingle) {
      const profile = runtimeAgent.name;
      const taskToRun: SpawnTask = {
        agent: profile,
        task: params.task!,
        cwd: params.cwd,
      };

      const result = await runSpawnTask(ctx.cwd, taskToRun, runtimeAgent, {
        index: 0,
        runId,
        defaultCwd: params.cwd,
        enableSessionControl,
        recursionDepth: depthState.depth,
        parentAgentName: state.agentName,
        onLaunch: options?.onLaunch
          ? (launch) =>
              options.onLaunch?.({
                profile,
                launch,
              })
          : undefined,
      });

      const resolutionLine = `Using built-in subagent profile '${profile}'.`;
      const modelNotice = resolvedModel.warning ? `\n\n⚠️ ${resolvedModel.warning}` : "";
      const launchBlock = formatSingleSubagentLaunchBlock(profile, result);

      const ok = result.exitCode === 0;
      const responseText = result.output || (ok ? "(no output)" : "Subagent failed");
      const contentText = includeLaunchBlock
        ? `${resolutionLine}${modelNotice}\n\n${launchBlock}\n\n## Subagent Response\n${responseText}`
        : responseText;

      return {
        content: [{ type: "text", text: contentText }],
        isError: ok ? false : true,
        details: {
          mode: "subagent",
          runId,
          single: true,
          profile,
          result,
          modelResolutionWarning: resolvedModel.warning,
        },
      };
    }

    const tasks = params.tasks ?? [];
    if (tasks.length > SUBAGENT_MAX_PARALLEL) {
      return {
        content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${SUBAGENT_MAX_PARALLEL}.` }],
        isError: true,
        details: { mode: "subagent", error: "too_many_tasks", max: SUBAGENT_MAX_PARALLEL },
      };
    }

    const resolvedTasks: Array<{ task: SpawnTask; def: SpawnAgentDefinition }> = [];
    for (const task of tasks) {
      const taskToRun: SpawnTask = {
        ...task,
        agent: runtimeAgent.name,
      };
      resolvedTasks.push({ task: taskToRun, def: runtimeAgent });
    }

    const concurrency = Math.max(1, Math.min(SUBAGENT_MAX_CONCURRENCY, tasks.length));

    const results = await mapWithConcurrencyLimit(resolvedTasks, concurrency, async (entry, index) => {
      return await runSpawnTask(ctx.cwd, entry.task, entry.def, {
        index,
        runId,
        defaultCwd: params.cwd,
        enableSessionControl,
        recursionDepth: depthState.depth,
        parentAgentName: state.agentName,
        onLaunch: options?.onLaunch
          ? (launch) =>
              options.onLaunch?.({
                profile: entry.def.name,
                launch,
              })
          : undefined,
      });
    });

    const successCount = results.filter((r) => r.exitCode === 0).length;
    const lines = results.map((r) => {
      const status = r.exitCode === 0 ? "ok" : "failed";
      const preview = r.output.length > 120 ? `${r.output.slice(0, 117)}...` : r.output;
      return `- ${r.name} (${r.agent}) ${status}: ${preview || "(no output)"}`;
    });

    const launchSections = results.map((result, idx) => {
      const resolved = resolvedTasks[idx];
      return formatParallelSubagentLaunchBlock(resolved?.def.name ?? result.agent, result, idx);
    });

    const resultSummaryLines = [
      `Parallel subagents: ${successCount}/${results.length} succeeded`,
      resolvedModel.warning ? `⚠️ ${resolvedModel.warning}` : undefined,
      "",
      "## Result Summary",
      lines.join("\n"),
    ].filter((line): line is string => Boolean(line));

    const contentText = includeLaunchBlock
      ? [...resultSummaryLines, "", "## Launch Details", launchSections.join("\n\n")].join("\n")
      : resultSummaryLines.join("\n");

    return {
      content: [
        {
          type: "text",
          text: contentText,
        },
      ],
      isError: successCount === results.length ? false : true,
      details: {
        mode: "subagent",
        runId,
        single: false,
        concurrency,
        profile: defaultAgent.name,
        results,
        modelResolutionWarning: resolvedModel.warning,
      },
    };
  }

  type SubagentLaunchParams = {
    task?: string;
    tasks?: Array<{ task: string; cwd?: string }>;
    cwd?: string;
    sessionControl?: boolean;
  };

  function validateSubagentLaunchParams(
    params: SubagentLaunchParams,
  ): { ok: true; mode: "single" | "parallel"; taskCount: number } | { ok: false; error: string } {
    const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
    const hasParallel = (params.tasks?.length ?? 0) > 0;

    if (Number(hasSingle) + Number(hasParallel) !== 1) {
      return { ok: false, error: "Provide exactly one mode: task or tasks[]" };
    }

    if (hasParallel) {
      const count = params.tasks?.length ?? 0;
      if (count > SUBAGENT_MAX_PARALLEL) {
        return {
          ok: false,
          error: `Too many parallel tasks (${count}). Max is ${SUBAGENT_MAX_PARALLEL}.`,
        };
      }
      return { ok: true, mode: "parallel", taskCount: count };
    }

    return { ok: true, mode: "single", taskCount: 1 };
  }

  function sendSubagentLaunchUpdate(profile: string, launch: SpawnResult): void {
    pi.sendMessage(
      {
        customType: "collab_focus_status",
        content: [
          `Spawning subagent "${formatAgentDisplayName(launch.name)}".`,
          "",
          "Task sent to subagent:",
          "```text",
          launch.task,
          "```",
          "",
          "Full launch prompt:",
          "```text",
          launch.launchPrompt,
          "```",
          "",
          `Profile: ${profile}`,
          `Working directory: ${launch.workingDirectory}`,
          "Direct status messages from subagents are optional; final outputs are collected automatically on completion.",
        ].join("\n"),
        display: true,
        details: {
          mode: "subagent_launch",
          profile,
          launch,
        },
      },
      { triggerTurn: false },
    );
  }

  function collectSpawnResults(details: Record<string, unknown>): SpawnResult[] {
    const singleResult =
      typeof details.result === "object" && details.result
        ? (details.result as SpawnResult)
        : undefined;

    const parallelResults = Array.isArray(details.results)
      ? (details.results as SpawnResult[])
      : undefined;

    if (parallelResults && parallelResults.length > 0) return parallelResults;
    return singleResult ? [singleResult] : [];
  }

  function findSessionFileBySessionId(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;

    const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
    if (!fs.existsSync(sessionsRoot)) return undefined;

    const targetSuffix = `_${sessionId}.jsonl`;
    const stack = [sessionsRoot];

    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(targetSuffix)) return fullPath;
      }
    }

    return undefined;
  }

  function snapshotCompletedSubagents(results: SpawnResult[]): void {
    const now = new Date().toISOString();
    const liveByName = new Map(listActiveAgents(dirs).map((agent) => [agent.name, agent] as const));
    const previousByName = new Map(state.completedSubagents.map((agent) => [agent.name, agent] as const));

    const snapshots: AgentRegistration[] = results.map((result, index) => {
      const live = liveByName.get(result.name);
      const previous = previousByName.get(result.name);

      return {
        name: result.name,
        pid: 0,
        sessionId: result.sessionId ?? live?.sessionId ?? previous?.sessionId ?? `completed-${index}-${result.name}`,
        sessionFile:
          live?.sessionFile ??
          previous?.sessionFile ??
          findSessionFileBySessionId(result.sessionId),
        cwd: result.workingDirectory,
        model: result.resolvedModel ?? live?.model ?? previous?.model ?? "unknown",
        startedAt: live?.startedAt ?? previous?.startedAt ?? now,
        lastSeenAt: now,
        role: "subagent",
      };
    });

    state.completedSubagents = snapshots.sort((a, b) => a.name.localeCompare(b.name));
  }

  function sendSubagentCompletionUpdate(
    result: {
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
      isError?: boolean;
    },
    ctx: ExtensionContext,
  ): void {
    const detailsObj = result.details as Record<string, unknown>;
    const spawnResults = collectSpawnResults(detailsObj);

    let intro: string;
    let body: string;

    if (spawnResults.length > 1) {
      const successCount = spawnResults.filter((r) => r.exitCode === 0).length;
      intro = result.isError
        ? `Received final results from ${spawnResults.length} subagents (${successCount} succeeded, ${spawnResults.length - successCount} failed).`
        : `Received final results from ${spawnResults.length} subagents.`;

      const sections = spawnResults.map((r, index) => {
        const displayName = formatAgentDisplayName(r.name);
        const status = r.exitCode === 0 ? "ok" : "failed";
        const output = (r.output || "(no output)").trim() || "(no output)";
        return [
          `### ${index + 1}. ${displayName} (${status})`,
          "",
          output,
        ].join("\n");
      });

      body = sections.join("\n\n");
    } else {
      const singleResult = spawnResults[0];
      const runtimeLabel = singleResult?.name ? formatAgentDisplayName(singleResult.name) : "the subagent";
      intro = result.isError
        ? `Received an error from ${runtimeLabel}.`
        : `Received final results from ${runtimeLabel}.`;

      body = (singleResult?.output || result.content[0]?.text || "(no output)").trim() || "(no output)";
    }

    const shouldAutoTurn = !ctx.hasUI;
    const sendOptions = shouldAutoTurn
      ? { triggerTurn: true as const }
      : ctx.isIdle()
        ? { triggerTurn: true as const }
        : { triggerTurn: true as const, deliverAs: "steer" as const };

    pi.sendMessage(
      {
        customType: "collab_focus_status",
        content: `${intro}\n\n${body}`,
        display: true,
        details: result.details,
      },
      sendOptions,
    );
  }

  function markAsOrchestrator(ctx: ExtensionContext): void {
    if (state.hasSpawnedSubagents) return;
    state.hasSpawnedSubagents = true;
    refreshRegistration(ctx);
    updateStatus(ctx);
  }

  function subagentRunInProgressMessage(): string {
    return "A subagent run is already in progress. Do not wait for direct subagent messages; final outputs are auto-collected and posted when the run completes.";
  }

  function launchSubagentsInBackground(params: SubagentLaunchParams, ctx: ExtensionContext): void {
    state.activeSubagentRuns += 1;
    state.completedSubagents = [];
    state.unreadCounts.clear();
    clearMessageLog(dirs);
    updateStatus(ctx);

    void (async () => {
      try {
        const result = await executeSubagentParams(
          params,
          ctx,
          {
            includeLaunchBlock: false,
            onLaunch: ({ profile, launch }) => sendSubagentLaunchUpdate(profile, launch),
          },
        );

        const detailsObj = result.details as Record<string, unknown>;
        snapshotCompletedSubagents(collectSpawnResults(detailsObj));
        updateStatus(ctx);
        sendSubagentCompletionUpdate(result, ctx);

        if (!ctx.hasUI) return;
        if (result.isError) {
          ctx.ui.notify("Subagent failed", "error");
        } else {
          ctx.ui.notify("Subagent completed", "info");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const sendOptions = !ctx.hasUI
          ? { triggerTurn: true as const }
          : ctx.isIdle()
            ? { triggerTurn: true as const }
            : { triggerTurn: true as const, deliverAs: "steer" as const };

        pi.sendMessage(
          {
            customType: "collab_focus_status",
            content: `Subagent failed to run: ${msg}`,
            display: true,
            details: { mode: "subagent", error: msg },
          },
          sendOptions,
        );
        if (ctx.hasUI) ctx.ui.notify("Subagent failed", "error");
      } finally {
        state.activeSubagentRuns = Math.max(0, state.activeSubagentRuns - 1);
        updateStatus(ctx);
      }
    })();
  }

  pi.registerTool({
    name: "agent_message",
    label: "Agent Message",
    description: `Autonomous agent messaging API for collaborating-agents.

Actions:
- status: Current agent identity/focus/peer count
- list: List active agents
- send: Send direct message to one active agent (set urgent: true to interrupt immediately)
- broadcast: Send message to all active peers (set urgent: true to interrupt immediately)
- feed: Read recent global messages
- thread: Read direct-message thread with one peer agent
- reserve: Reserve files/directories for exclusive write/edit intent
- release: Release reservations (specific paths or all)`,
    parameters: AgentMessageParams,
    renderCall(args, theme) {
      const text = [
        theme.fg("toolTitle", theme.bold("agent_message")),
        theme.fg("toolOutput", formatToolCallArgs(args)),
      ].join("\n");
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastContext = ctx;
      config = loadConfig(ctx.cwd);

      if (!ensureRegistered(ctx)) {
        return {
          content: [{ type: "text", text: "Failed to register this agent in collaborating-agents." }],
          isError: true,
          details: { action: "status", error: "registration_failed" },
        };
      }

      refreshRegistration(ctx);

      const action = params.action as AgentMessageAction;

      if (action === "status") {
        const peers = listActiveAgents(dirs, state.agentName);
        const focus = state.focus.mode === "local" ? "local" : `remote:${state.focus.targetAgent}`;
        const selfRole = getCurrentAgentRole();
        const selfDisplayName = withRoleLabel(state.agentName, selfRole);
        return {
          content: [
            {
              type: "text",
              text: `Agent: ${selfDisplayName}\nFocus: ${focus}\nActive peers: ${peers.length}\nReservations: ${state.reservations.length}`,
            },
          ],
          details: {
            action,
            self: state.agentName,
            selfRole,
            focus: state.focus,
            reservations: state.reservations,
            peers: peers.map((p) => ({ name: p.name, role: p.role, sessionId: p.sessionId, model: p.model, cwd: p.cwd })),
          },
        };
      }

      if (action === "list") {
        const peers = listActiveAgents(dirs);
        if (peers.length === 0) {
          return {
            content: [{ type: "text", text: "No active agents." }],
            details: { action, agents: [] },
          };
        }

        const lines = peers.map((p) => {
          const marker = p.name === state.agentName ? " (you)" : "";
          const reservationPart = p.reservations && p.reservations.length > 0 ? ` • 🔒${p.reservations.length}` : "";
          const displayName = withRoleLabel(p.name, p.role);
          return `- ${displayName}${marker} • ${p.model} • ${p.sessionId.slice(0, 8)}...${reservationPart}`;
        });

        return {
          content: [{ type: "text", text: `Active agents:\n${lines.join("\n")}` }],
          details: { action, agents: peers },
        };
      }

      if (action === "send") {
        if (!params.to || params.to.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Missing 'to' for send action." }],
            isError: true,
            details: { action, error: "missing_to" },
          };
        }
        if (!params.message || params.message.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Missing 'message' for send action." }],
            isError: true,
            details: { action, error: "missing_message" },
          };
        }

        const urgent = params.urgent === true;
        const sendResult = sendDirect(dirs, state.agentName, params.to, params.message, params.replyTo, urgent);
        if (!sendResult.ok) {
          return {
            content: [{ type: "text", text: sendResult.error }],
            isError: true,
            details: { action, error: sendResult.error },
          };
        }

        return {
          content: [{ type: "text", text: `Sent ${urgent ? "urgent " : ""}direct message to ${params.to}.` }],
          details: { action, to: params.to, urgent, ok: true },
        };
      }

      if (action === "broadcast") {
        if (!params.message || params.message.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Missing 'message' for broadcast action." }],
            isError: true,
            details: { action, error: "missing_message" },
          };
        }

        const urgent = params.urgent === true;
        const broadcastResult = sendBroadcast(dirs, state.agentName, params.message, urgent);
        if (!broadcastResult.ok) {
          return {
            content: [{ type: "text", text: broadcastResult.error }],
            isError: true,
            details: { action, error: broadcastResult.error },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `${urgent ? "Urgent " : ""}broadcast sent to ${broadcastResult.delivered.length} agent(s).`,
            },
          ],
          details: {
            action,
            urgent,
            delivered: broadcastResult.delivered,
            failed: broadcastResult.failed,
          },
        };
      }

      if (action === "feed") {
        const limit = normalizeLimit(params.limit, 20, 400);
        const events = readMessageLogTail(dirs, limit);
        if (events.length === 0) {
          return {
            content: [{ type: "text", text: "No messages in feed." }],
            details: { action, events: [] },
          };
        }

        const lines = events.map(formatMessageEvent);
        return {
          content: [{ type: "text", text: `Recent messages (${events.length}):\n${lines.join("\n")}` }],
          details: { action, events },
        };
      }

      if (action === "thread") {
        if (!params.to || params.to.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Missing 'to' for thread action." }],
            isError: true,
            details: { action, error: "missing_to" },
          };
        }

        const limit = normalizeLimit(params.limit, 20, 400);
        const all = readMessageLog(dirs);
        const peer = params.to;
        const thread = all
          .filter((e) =>
            e.kind === "direct" &&
            ((e.from === state.agentName && e.to === peer) || (e.from === peer && e.to === state.agentName)),
          )
          .slice(-limit);

        if (thread.length === 0) {
          return {
            content: [{ type: "text", text: `No direct messages with ${peer}.` }],
            details: { action, to: peer, events: [] },
          };
        }

        const lines = thread.map(formatMessageEvent);
        return {
          content: [{ type: "text", text: `Thread with ${peer} (${thread.length}):\n${lines.join("\n")}` }],
          details: { action, to: peer, events: thread },
        };
      }

      if (action === "reserve") {
        const paths = normalizeReservationPaths(params.paths);
        if (paths.length === 0) {
          return {
            content: [{ type: "text", text: "Missing 'paths' for reserve action." }],
            isError: true,
            details: { action, error: "missing_paths" },
          };
        }

        const warnings: string[] = [];
        for (const pattern of paths) {
          const validation = validateReservationPattern(pattern);
          if (!validation.valid) {
            return {
              content: [{ type: "text", text: `Invalid reservation pattern: "${pattern}".` }],
              isError: true,
              details: { action, error: "invalid_pattern", pattern },
            };
          }
          if (validation.warning) warnings.push(validation.warning);
        }

        reservePaths(paths, params.reason);
        refreshRegistration(ctx);
        updateStatus(ctx);

        const reasonText = params.reason?.trim() ? ` (reason: ${params.reason.trim()})` : "";
        const warningText =
          warnings.length > 0
            ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
            : "";

        return {
          content: [{ type: "text", text: `Reserved ${paths.join(", ")}${reasonText}.${warningText}` }],
          details: {
            action,
            paths,
            reason: params.reason?.trim() || undefined,
            warnings: warnings.length > 0 ? warnings : undefined,
            reservations: state.reservations,
          },
        };
      }

      if (action === "release") {
        const hasPathsParam = Array.isArray(params.paths);
        const paths = normalizeReservationPaths(params.paths);

        if (hasPathsParam && paths.length === 0) {
          return {
            content: [{ type: "text", text: "No valid 'paths' were provided for release action." }],
            isError: true,
            details: { action, error: "invalid_paths" },
          };
        }

        const released = releasePaths(hasPathsParam ? paths : undefined);
        refreshRegistration(ctx);
        updateStatus(ctx);

        if (released.length === 0) {
          return {
            content: [{ type: "text", text: "No reservations were released." }],
            details: {
              action,
              released,
              remaining: state.reservations,
            },
          };
        }

        return {
          content: [{ type: "text", text: `Released: ${released.join(", ")}.` }],
          details: {
            action,
            released,
            remaining: state.reservations,
          },
        };
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${String(action)}` }],
        isError: true,
        details: { action, error: "unknown_action" },
      };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Spawn one or more subagent pi processes using the built-in collaborating subagent prompt.

Modes:
- Single: { task }
- Parallel: { tasks: [{ task, cwd? }, ...] }

By default subagents use the same model as the spawning session.` ,
    parameters: SubagentParams,
    renderCall(args, theme) {
      const text = [
        theme.fg("toolTitle", theme.bold("subagent")),
        theme.fg("toolOutput", formatToolCallArgs(args)),
      ].join("\n");
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastContext = ctx;

      const validation = validateSubagentLaunchParams(params);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: validation.error }],
          isError: true,
          details: { mode: "subagent", error: "invalid_params" },
        };
      }

      if (state.activeSubagentRuns > 0) {
        const text = subagentRunInProgressMessage();
        if (ctx.hasUI) ctx.ui.notify("Subagent run already in progress", "warning");
        return {
          content: [{ type: "text", text }],
          details: {
            mode: "subagent",
            queued: false,
            background: true,
            launchMode: validation.mode,
            taskCount: validation.taskCount,
            blocked: "already_running",
          },
        };
      }

      if (ctx.hasUI) ctx.ui.notify("Launching subagent in background...", "info");
      launchSubagentsInBackground(params, ctx);

      const label =
        validation.mode === "single"
          ? "Subagent launched in background."
          : `${validation.taskCount} subagents launched in background.`;

      return {
        content: [{ type: "text", text: `${label} Do not wait for direct subagent messages; final outputs are auto-collected and posted on completion.` }],
        details: {
          mode: "subagent",
          queued: true,
          background: true,
          launchMode: validation.mode,
          taskCount: validation.taskCount,
        },
      };
    },
  });

  pi.registerCommand("subagent", {
    description: "Spawn a single subagent: /subagent <task>",
    handler: async (args, ctx) => {
      lastContext = ctx;
      rememberSwitchSessionContext(ctx);
      const trimmed = args.trim();

      const notifyUsage = () => {
        ctx.ui.notify("Usage: /subagent <task>", "warning");
      };

      if (!trimmed) {
        notifyUsage();
        return;
      }

      // Backward-compatible convenience: strip old leading "worker" prefix.
      const task = trimmed.replace(/^worker\s+/i, "").trim();
      if (!task) {
        notifyUsage();
        return;
      }

      if (state.activeSubagentRuns > 0) {
        ctx.ui.notify("Subagent run already in progress", "warning");
        return;
      }

      ctx.ui.notify("Launching subagent in background...", "info");

      launchSubagentsInBackground({ task }, ctx);
    },
  });

  function hasExistingSessionFile(agent: AgentRegistration): boolean {
    return !!agent.sessionFile && fs.existsSync(agent.sessionFile);
  }

  function listMessagePeers(): AgentRegistration[] {
    const active = listActiveAgents(dirs, state.agentName);
    const merged = new Map<string, AgentRegistration>();

    for (const agent of active) merged.set(agent.name, agent);
    for (const agent of state.completedSubagents) {
      if (!merged.has(agent.name)) merged.set(agent.name, agent);
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function listOverlaySwitchTargets(): AgentRegistration[] {
    const peers = listMessagePeers();
    const coordinator = buildCoordinatorSwitchEntry();
    if (!coordinator) return peers;

    const alreadyPresent = peers.some((agent) => !!agent.sessionFile && agent.sessionFile === coordinator.sessionFile);

    if (alreadyPresent) return peers;
    return [coordinator, ...peers];
  }

  async function switchToCoordinatorSession(ctx: ExtensionContext): Promise<boolean> {
    const coordinator = buildCoordinatorSwitchEntry();
    if (!coordinator) return false;

    const currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    if (currentSessionFile && currentSessionFile === coordinator.sessionFile) {
      focusLocal(ctx);
      return true;
    }

    const switched = await trySwitchToAgentSession(ctx, coordinator, { allowMissingSessionFile: true });
    if (!switched) return false;

    focusLocal(ctx);
    startRemoteSessionAutoRefresh(ctx);
    return true;
  }

  async function openAgentsOverlay(ctx: ExtensionContext): Promise<void> {
    lastContext = ctx;
    rememberSwitchSessionContext(ctx);
    config = loadConfig(ctx.cwd);
    if (!ensureRegistered(ctx)) return;
    if (!state.watcher) startWatcher(ctx);
    refreshRegistration(ctx);

    if (!ctx.hasUI) return;

    let overlayClosed = false;
    let requestOverlayClose: (() => void) | null = null;
    let overlayComponent: MessagesOverlay | null = null;
    let overlayTui: TUI | null = null;

    const ensureOverlayFocus = (): void => {
      if (overlayClosed) return;
      if (!overlayComponent || !overlayTui) return;
      if (!overlayComponent.focused) overlayTui.setFocus(overlayComponent);
    };

    const closeOverlay = (): void => {
      if (overlayClosed) return;
      requestOverlayClose?.();
    };

    const stopTerminalListener = ctx.ui.onTerminalInput((data) => {
      if (overlayClosed) return;

      ensureOverlayFocus();

      const shouldClose = matchesKey(data, "escape");

      if (!shouldClose || !requestOverlayClose) return;
      closeOverlay();
      return { consume: true };
    });

    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const finish = () => {
            if (overlayClosed) return;
            overlayClosed = true;
            done(undefined);
          };

          requestOverlayClose = finish;

          const overlay = new MessagesOverlay(tui, theme, {
            selfName: state.agentName,
            selfRole: getCurrentAgentRole(),
            focus: state.focus,
            loadAgents: () => listMessagePeers(),
            loadSwitchTargets: () => listOverlaySwitchTargets(),
            loadReservationAgents: () => listActiveAgents(dirs),
            loadMessages: (limit) => readMessageLogTail(dirs, Math.max(limit, config.messageHistoryLimit)),
            sendDirect: (to, text, urgent) => sendDirect(dirs, state.agentName, to, text, undefined, urgent),
            sendBroadcast: (text, urgent) => sendBroadcast(dirs, state.agentName, text, urgent),
            onFocusLocal: () => focusLocal(ctx),
            onFocusRemote: async (target) => {
              const isCoordinatorSwitchEntry =
                !!coordinatorSessionFile &&
                target.sessionFile === coordinatorSessionFile &&
                target.pid === process.pid;

              if (isCoordinatorSwitchEntry) {
                const switchedToCoordinator = await switchToCoordinatorSession(ctx);
                if (switchedToCoordinator) return;

                ctx.ui.notify("Could not switch to local session.", "error");
                updateStatus(ctx);
                return;
              }

              const liveTarget = getAgentByName(dirs, target.name);
              const switchTarget = liveTarget && isProcessAlive(liveTarget.pid) ? liveTarget : target;

              if (!hasExistingSessionFile(switchTarget)) {
                const inactive = !liveTarget || !isProcessAlive(liveTarget.pid);
                const message = inactive
                  ? `Agent ${target.name} is completed/inactive and has no persisted session file to open.`
                  : `Agent ${target.name} has not persisted a session file yet. Ask it to produce output first.`;
                ctx.ui.notify(message, "warning");
                updateStatus(ctx);
                return;
              }

              const switched = await trySwitchToAgentSession(ctx, switchTarget);
              if (switched) {
                if (coordinatorSessionFile && switchTarget.sessionFile === coordinatorSessionFile) {
                  focusLocal(ctx);
                } else {
                  focusRemote(switchTarget, ctx);
                }
                startRemoteSessionAutoRefresh(ctx);
                return;
              }

              ctx.ui.notify(`Could not switch to ${target.name}.`, "error");
              updateStatus(ctx);
            },
            notify: (message, level = "info") => ctx.ui.notify(message, level),
            done: finish,
          });

          overlayComponent = overlay;
          overlayTui = tui;

          return overlay;
        },
        { overlay: true },
      );
    } finally {
      overlayClosed = true;
      requestOverlayClose = null;
      overlayComponent = null;
      overlayTui = null;
      stopTerminalListener();
      updateStatus(ctx);
    }
  }

  pi.registerCommand("agents", {
    description: "Open collaborating-agents agent and message overlay",
    handler: async (_args, ctx) => {
      rememberSwitchSessionContext(ctx);
      await openAgentsOverlay(ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    lastContext = ctx;
    rememberSwitchSessionContext(ctx);

    const text = event.text.trim();
    if (text === "/agents" || text.startsWith("/agents ")) {
      await openAgentsOverlay(ctx);
      return { action: "handled" as const };
    }

    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!state.registered) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const input = event.input as Record<string, unknown>;
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path) return;

    const conflicts = getConflictsWithOtherAgents(dirs, state.agentName, path);
    if (conflicts.length === 0) return;

    const conflict = conflicts[0]!;
    const agentFolder = basename(conflict.registration.cwd) || conflict.registration.cwd;
    const lines = [
      path,
      `Reserved by: ${conflict.agent} (in ${agentFolder})`,
      `Reservation pattern: ${conflict.pattern}`,
    ];

    if (conflict.reason) lines.push(`Reason: "${conflict.reason}"`);

    lines.push("");
    lines.push(`Coordinate via agent_message({ action: "send", to: "${conflict.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });

  pi.on("session_start", async (_event, ctx) => {
    lastContext = ctx;
    config = loadConfig(ctx.cwd);
    startedAt = new Date().toISOString();
    localSessionFile = ctx.sessionManager.getSessionFile() ?? localSessionFile;

    if (!process.env.PI_AGENT_NAME) {
      state.hasClearedSubagentHistory = false;
    }

    if (!ensureRegistered(ctx)) return;
    startWatcher(ctx);
    refreshRegistration(ctx);
    syncFocusToCurrentSession(ctx);
    startRemoteSessionAutoRefresh(ctx);
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    lastContext = ctx;
    config = loadConfig(ctx.cwd);
    localSessionFile = localSessionFile ?? ctx.sessionManager.getSessionFile() ?? localSessionFile;

    if (!state.registered) {
      if (!ensureRegistered(ctx)) return;
    }
    if (!state.watcher) startWatcher(ctx);
    refreshRegistration(ctx);
    syncFocusToCurrentSession(ctx);
    startRemoteSessionAutoRefresh(ctx);
    updateStatus(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    lastContext = ctx;
    if (!state.registered) return;
    refreshRegistration(ctx);
    syncFocusToCurrentSession(ctx);
    startRemoteSessionAutoRefresh(ctx);
    updateStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastContext = ctx;
    if (!state.registered) return;
    refreshRegistration(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatcher();
    stopRemoteSessionAutoRefresh();
    if (state.registered) {
      unregisterSelf(dirs, state.agentName);
      state.registered = false;
    }
    if (lastContext) clearStatus(lastContext);
  });
}
