import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, normalize } from "node:path";
import type {
  AgentRegistration,
  AgentRole,
  Dirs,
  FileReservation,
  InboxMessage,
  MessageLogEvent,
  ReservationConflict,
} from "./types.js";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 1500;
const STALE_LOCK_MS = 30_000;
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_ARRAY = new Int32Array(SLEEP_BUFFER);

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleepSync(ms: number): void {
  const duration = Math.max(1, Math.floor(ms));
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, duration);
  } catch {
    const deadline = Date.now() + duration;
    while (Date.now() < deadline) {
      // best-effort fallback
    }
  }
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

function isValidInboxMessage(msg: unknown): msg is InboxMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.from === "string" &&
    typeof m.to === "string" &&
    typeof m.text === "string" &&
    typeof m.kind === "string" &&
    typeof m.timestamp === "string" &&
    (typeof m.urgent === "undefined" || typeof m.urgent === "boolean") &&
    (typeof m.replyTo === "undefined" || typeof m.replyTo === "string" || m.replyTo === null)
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

function registrationLockPath(dirs: Dirs, agentName: string): string {
  return `${registrationPath(dirs, agentName)}.lock`;
}

function inboxDir(dirs: Dirs, agentName: string): string {
  return join(dirs.inbox, agentName);
}

function readLockOwner(lockDir: string): { pid?: number; acquiredAt?: number } | null {
  return readJsonFile<{ pid?: number; acquiredAt?: number }>(join(lockDir, "owner.json"));
}

function isLockStale(lockPath: string): boolean {
  const owner = readLockOwner(lockPath);
  if (owner) {
    if (typeof owner.pid === "number" && owner.pid > 0 && !isProcessAlive(owner.pid)) return true;
    if (typeof owner.acquiredAt === "number" && Date.now() - owner.acquiredAt > STALE_LOCK_MS) return true;
    return false;
  }

  try {
    const stats = fs.statSync(lockPath);
    return Date.now() - stats.mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

function acquireLockSync(lockPath: string, timeoutMs: number = LOCK_TIMEOUT_MS): (() => void) | null {
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));

  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockPath);
      try {
        fs.writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best effort
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // best effort
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") return null;

      if (isLockStale(lockPath)) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // best effort
        }
        continue;
      }

      sleepSync(LOCK_RETRY_MS);
    }
  }

  return null;
}

function withRegistrationLock<T>(dirs: Dirs, agentName: string, fn: () => T): T | undefined {
  const release = acquireLockSync(registrationLockPath(dirs, agentName));
  if (!release) return undefined;

  try {
    return fn();
  } finally {
    release();
  }
}

function writeFileAtomic(path: string, content: string): boolean {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(tempPath, content, "utf-8");

    try {
      fs.renameSync(tempPath, path);
    } catch {
      // Best-effort fallback for environments where rename cannot replace existing files.
      fs.rmSync(path, { force: true });
      fs.renameSync(tempPath, path);
    }

    return true;
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best effort
    }
    return false;
  }
}

function removeRegistrationIfStillDead(filePath: string, expected: AgentRegistration): void {
  const release = acquireLockSync(`${filePath}.lock`, 250);
  if (!release) return;

  try {
    const latest = readJsonFile<unknown>(filePath);
    if (!latest || !isValidRegistration(latest)) return;

    if (latest.pid !== expected.pid || latest.sessionId !== expected.sessionId) return;
    if (isProcessAlive(latest.pid)) return;

    try {
      fs.unlinkSync(filePath);
    } catch {
      // best effort
    }
  } finally {
    release();
  }
}

export function registerSelf(dirs: Dirs, registration: AgentRegistration): boolean {
  ensureDirSync(dirs.base);
  ensureDirSync(dirs.registry);
  ensureDirSync(dirs.inbox);
  ensureDirSync(inboxDir(dirs, registration.name));

  const serialized = JSON.stringify(registration, null, 2);

  const result = withRegistrationLock(dirs, registration.name, () => {
    const path = registrationPath(dirs, registration.name);
    const existing = readJsonFile<unknown>(path);

    if (existing && isValidRegistration(existing)) {
      const sameOwner = existing.pid === registration.pid && existing.sessionId === registration.sessionId;
      if (!sameOwner && isProcessAlive(existing.pid)) {
        return false;
      }
    }

    return writeFileAtomic(path, serialized);
  });

  return result ?? false;
}

export function updateSelfHeartbeat(dirs: Dirs, registration: AgentRegistration): void {
  const serialized = JSON.stringify(registration, null, 2);

  withRegistrationLock(dirs, registration.name, () => {
    const path = registrationPath(dirs, registration.name);
    const existing = readJsonFile<unknown>(path);

    if (!existing || !isValidRegistration(existing)) {
      writeFileAtomic(path, serialized);
      return;
    }

    const sameOwner = existing.pid === registration.pid && existing.sessionId === registration.sessionId;
    if (sameOwner || !isProcessAlive(existing.pid)) {
      writeFileAtomic(path, serialized);
    }
  });
}

export function unregisterSelf(
  dirs: Dirs,
  agentName: string,
  owner?: { pid: number; sessionId?: string },
): void {
  withRegistrationLock(dirs, agentName, () => {
    const path = registrationPath(dirs, agentName);

    if (!owner) {
      try {
        fs.unlinkSync(path);
      } catch {
        // best effort
      }
      return;
    }

    const existing = readJsonFile<unknown>(path);
    if (!existing || !isValidRegistration(existing)) return;

    if (existing.pid !== owner.pid) return;
    if (owner.sessionId && existing.sessionId !== owner.sessionId) return;

    try {
      fs.unlinkSync(path);
    } catch {
      // best effort
    }
  });
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
    const parsed = readJsonFile<unknown>(file);

    // Do not delete unreadable/invalid files here. They may be observed mid-update.
    if (!parsed || !isValidRegistration(parsed)) continue;

    if (!isProcessAlive(parsed.pid)) {
      removeRegistrationIfStillDead(file, parsed);
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
  const normalizedFilePath = normalize(filePath).replace(/^\.\//, "");
  const normalizedPattern = normalize(pattern).replace(/^\.\//, "");

  if (normalizedPattern.endsWith("/")) {
    return (
      normalizedFilePath.startsWith(normalizedPattern) ||
      `${normalizedFilePath}/` === normalizedPattern
    );
  }

  return normalizedFilePath === normalizedPattern;
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

export function clearMessageLog(_dirs: Dirs): void {
  // Intentionally a no-op.
  // Deleting shared log state is unsafe under concurrent orchestrators/sessions.
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

  const baseName = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const filePath = join(dir, `${baseName}.json`);
  const tempPath = join(dir, `${baseName}.tmp`);
  const payload = JSON.stringify(message, null, 2);

  try {
    fs.writeFileSync(tempPath, payload, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best effort
    }
    throw error;
  }
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

  const quarantineDir = join(dir, ".invalid");

  for (const file of files) {
    const fullPath = join(dir, file);
    const parsed = readJsonFile<unknown>(fullPath);

    if (!parsed || !isValidInboxMessage(parsed)) {
      ensureDirSync(quarantineDir);
      const quarantinePath = join(quarantineDir, `${Date.now()}-${file}`);
      try {
        fs.renameSync(fullPath, quarantinePath);
      } catch {
        // best effort; leave in place if we cannot move it
      }
      continue;
    }

    let delivered = false;
    try {
      onMessage(parsed);
      delivered = true;
    } catch {
      delivered = false;
    }

    if (!delivered) continue;

    try {
      fs.unlinkSync(fullPath);
    } catch {
      // best effort
    }
  }
}

export function sendDirect(
  dirs: Dirs,
  from: string,
  to: string,
  text: string,
  replyTo?: string,
  urgent: boolean = false,
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
    urgent,
    replyTo: replyTo ?? null,
  };

  try {
    enqueueInboxMessage(dirs, to, message);

    appendMessageLogEvent(dirs, {
      id: message.id,
      from,
      to,
      text: trimmed,
      kind: "direct",
      timestamp: message.timestamp,
      urgent,
      replyTo: message.replyTo,
    });

    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to send direct message to '${to}': ${reason}` };
  }
}

export function sendBroadcast(
  dirs: Dirs,
  from: string,
  text: string,
  urgent: boolean = false,
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
        urgent,
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
    urgent,
    recipients,
  });

  return { ok: true, delivered, failed };
}
