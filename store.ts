import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type {
  AgentRegistration,
  AgentRole,
  Dirs,
  FileReservation,
  InboxMessage,
  MessageLogEvent,
  ReservationConflict,
} from "./types.js";

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isValidReservation(res: unknown): res is FileReservation {
  if (!res || typeof res !== "object") return false;
  const r = res as Record<string, unknown>;
  return (
    typeof r.pattern === "string" &&
    typeof r.since === "string" &&
    (typeof r.reason === "undefined" || typeof r.reason === "string")
  );
}

function isValidRole(role: unknown): role is AgentRole {
  return role === "subagent" || role === "orchestrator";
}

function isValidRegistration(reg: unknown): reg is AgentRegistration {
  if (!reg || typeof reg !== "object") return false;
  const r = reg as Record<string, unknown>;

  const reservationsValid =
    typeof r.reservations === "undefined" ||
    (Array.isArray(r.reservations) && r.reservations.every((item) => isValidReservation(item)));

  const roleValid = typeof r.role === "undefined" || isValidRole(r.role);

  return (
    typeof r.name === "string" &&
    typeof r.pid === "number" &&
    typeof r.sessionId === "string" &&
    typeof r.cwd === "string" &&
    typeof r.model === "string" &&
    typeof r.startedAt === "string" &&
    typeof r.lastSeenAt === "string" &&
    roleValid &&
    reservationsValid
  );
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function registrationPath(dirs: Dirs, agentName: string): string {
  return join(dirs.registry, `${agentName}.json`);
}

function inboxDir(dirs: Dirs, agentName: string): string {
  return join(dirs.inbox, agentName);
}

export function registerSelf(dirs: Dirs, registration: AgentRegistration): boolean {
  ensureDirSync(dirs.base);
  ensureDirSync(dirs.registry);
  ensureDirSync(dirs.inbox);
  ensureDirSync(inboxDir(dirs, registration.name));

  const path = registrationPath(dirs, registration.name);
  if (fs.existsSync(path)) {
    const existing = readJsonFile<AgentRegistration>(path);
    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      return false;
    }
  }

  try {
    fs.writeFileSync(path, JSON.stringify(registration, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function updateSelfHeartbeat(dirs: Dirs, registration: AgentRegistration): void {
  const path = registrationPath(dirs, registration.name);
  if (!fs.existsSync(path)) return;

  try {
    fs.writeFileSync(path, JSON.stringify(registration, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

export function unregisterSelf(dirs: Dirs, agentName: string): void {
  const path = registrationPath(dirs, agentName);
  try {
    fs.unlinkSync(path);
  } catch {
    // best effort
  }
}

export function listActiveAgents(dirs: Dirs, excludeAgentName?: string): AgentRegistration[] {
  ensureDirSync(dirs.registry);
  const agents: AgentRegistration[] = [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirs.registry);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dirs.registry, entry);
    const parsed = readJsonFile<AgentRegistration>(file);
    if (!isValidRegistration(parsed)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
      continue;
    }

    if (!isProcessAlive(parsed.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
      continue;
    }

    if (excludeAgentName && parsed.name === excludeAgentName) continue;

    agents.push(parsed);
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

export function getAgentByName(dirs: Dirs, name: string): AgentRegistration | undefined {
  return listActiveAgents(dirs).find((a) => a.name === name);
}

export function pathMatchesReservation(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    return filePath.startsWith(pattern) || `${filePath}/` === pattern;
  }
  return filePath === pattern;
}

export function getConflictsWithOtherAgents(
  dirs: Dirs,
  selfAgentName: string,
  filePath: string,
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const peers = listActiveAgents(dirs, selfAgentName);

  for (const agent of peers) {
    if (!agent.reservations || agent.reservations.length === 0) continue;

    for (const reservation of agent.reservations) {
      if (!pathMatchesReservation(filePath, reservation.pattern)) continue;
      conflicts.push({
        path: filePath,
        agent: agent.name,
        pattern: reservation.pattern,
        reason: reservation.reason,
        registration: agent,
      });
    }
  }

  return conflicts;
}

export function appendMessageLogEvent(dirs: Dirs, event: MessageLogEvent): void {
  ensureDirSync(dirs.base);
  try {
    fs.appendFileSync(dirs.messageLog, `${JSON.stringify(event)}\n`, "utf-8");
  } catch {
    // best effort
  }
}

export function clearMessageLog(dirs: Dirs): void {
  try {
    fs.unlinkSync(dirs.messageLog);
  } catch {
    // best effort
  }
}

export function readMessageLog(dirs: Dirs): MessageLogEvent[] {
  if (!fs.existsSync(dirs.messageLog)) return [];

  try {
    const content = fs.readFileSync(dirs.messageLog, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const out: MessageLogEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as MessageLogEvent;
        if (event && typeof event === "object" && typeof event.id === "string") out.push(event);
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readMessageLogTail(dirs: Dirs, limit: number): MessageLogEvent[] {
  if (limit <= 0) return [];
  const all = readMessageLog(dirs);
  return all.slice(-limit);
}

export function enqueueInboxMessage(dirs: Dirs, targetAgent: string, message: InboxMessage): void {
  const dir = inboxDir(dirs, targetAgent);
  ensureDirSync(dir);

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2), "utf-8");
}

export function processInbox(
  dirs: Dirs,
  selfAgentName: string,
  onMessage: (message: InboxMessage) => void,
): void {
  const dir = inboxDir(dirs, selfAgentName);
  ensureDirSync(dir);

  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const parsed = readJsonFile<InboxMessage>(fullPath);
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.from === "string" &&
        typeof parsed.to === "string" &&
        typeof parsed.text === "string"
      ) {
        onMessage(parsed);
      }
    } finally {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // best effort
      }
    }
  }
}

export function sendDirect(
  dirs: Dirs,
  from: string,
  to: string,
  text: string,
  replyTo?: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Message is empty" };
  if (to === from) return { ok: false, error: "Cannot send direct message to yourself" };

  const target = getAgentByName(dirs, to);
  if (!target) return { ok: false, error: `Agent '${to}' is not active` };

  const message: InboxMessage = {
    id: randomUUID(),
    from,
    to,
    text: trimmed,
    kind: "direct",
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
  };

  enqueueInboxMessage(dirs, to, message);

  appendMessageLogEvent(dirs, {
    id: message.id,
    from,
    to,
    text: trimmed,
    kind: "direct",
    timestamp: message.timestamp,
    replyTo: message.replyTo,
  });

  return { ok: true };
}

export function sendBroadcast(
  dirs: Dirs,
  from: string,
  text: string,
): { ok: true; delivered: string[]; failed: string[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Message is empty" };

  const recipients = listActiveAgents(dirs, from).map((a) => a.name);
  if (recipients.length === 0) return { ok: false, error: "No active recipients" };

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const failed: string[] = [];
  const delivered: string[] = [];

  for (const target of recipients) {
    try {
      const message: InboxMessage = {
        id,
        from,
        to: target,
        text: trimmed,
        kind: "broadcast",
        timestamp,
      };
      enqueueInboxMessage(dirs, target, message);
      delivered.push(target);
    } catch {
      failed.push(target);
    }
  }

  appendMessageLogEvent(dirs, {
    id,
    from,
    to: "all",
    text: trimmed,
    kind: "broadcast",
    timestamp,
    recipients,
  });

  return { ok: true, delivered, failed };
}
