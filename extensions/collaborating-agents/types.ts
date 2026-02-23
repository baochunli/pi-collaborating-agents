import type * as fs from "node:fs";

export type DeliveryKind = "direct" | "broadcast";

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export type AgentRole = "subagent" | "orchestrator";

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  model: string;
  startedAt: string;
  lastSeenAt: string;
  role?: AgentRole;
  reservations?: FileReservation[];
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  replyTo?: string | null;
}

export interface MessageLogEvent {
  id: string;
  from: string;
  to: string | "all";
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  recipients?: string[];
  replyTo?: string | null;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export type FocusState =
  | { mode: "local" }
  | {
      mode: "remote";
      targetAgent: string;
      targetSessionId: string;
    };

export interface Dirs {
  base: string;
  registry: string;
  inbox: string;
  messageLog: string;
}

export interface ExtensionState {
  agentName: string;
  registered: boolean;
  focus: FocusState;
  reservations: FileReservation[];
  unreadCounts: Map<string, number>;
  watcher: fs.FSWatcher | null;
  watcherDebounceTimer: ReturnType<typeof setTimeout> | null;
  hasClearedSubagentHistory: boolean;
  hasSpawnedSubagents: boolean;
  completedSubagents: AgentRegistration[];
  activeSubagentRuns: number;
}

export interface CollaboratingAgentsConfig {
  messageHistoryLimit: number;
}

export type AgentMessageAction =
  | "status"
  | "list"
  | "send"
  | "broadcast"
  | "feed"
  | "thread"
  | "reserve"
  | "release";

export interface RemoteTurnResult {
  assistantText: string;
  turnIndex?: number;
}

/**
 * Configuration for a subagent type loaded from TOML files.
 * These define specialized subagent profiles with specific prompts,
 * models, and reasoning levels.
 */
export interface SubagentTypeConfig {
  /** Unique identifier for this subagent type (e.g., "scout", "documenter") */
  name: string;
  /** Human-readable description of what this subagent type does */
  description: string;
  /** Optional model override (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4-20250514") */
  model?: string;
  /** Optional reasoning level (e.g., "low", "medium", "high") */
  reasoning?: "low" | "medium" | "high";
  /** The system prompt for this subagent type */
  prompt: string;
  /** Source of the configuration */
  source: "user" | "project";
  /** Path to the TOML file */
  filePath: string;
}
