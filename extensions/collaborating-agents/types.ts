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
