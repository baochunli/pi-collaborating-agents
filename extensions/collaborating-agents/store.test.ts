import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConflictsWithOtherAgents,
  listActiveAgents,
  pathMatchesReservation,
  processInbox,
  readMessageLog,
  readMessageLogTail,
  registerSelf,
  sendBroadcast,
  sendDirect,
  unregisterSelf,
  updateSelfHeartbeat,
} from "./store.ts";
import type { AgentRegistration, Dirs, InboxMessage, MessageLogEvent } from "./types.ts";

const DEAD_PID = 99_999_999;

const tempBases: string[] = [];

afterEach(() => {
  while (tempBases.length > 0) {
    const dir = tempBases.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDirs(prefix: string): Dirs {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempBases.push(base);
  return {
    base,
    registry: path.join(base, "registry"),
    inbox: path.join(base, "inbox"),
    messageLog: path.join(base, "messages.jsonl"),
  };
}

function makeRegistration(name: string, overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  const now = new Date().toISOString();
  return {
    name,
    pid: process.pid,
    sessionId: `${name}-session`,
    cwd: process.cwd(),
    model: "test-model",
    startedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function writeRegistration(dirs: Dirs, registration: AgentRegistration): void {
  fs.mkdirSync(dirs.registry, { recursive: true });
  fs.writeFileSync(path.join(dirs.registry, `${registration.name}.json`), JSON.stringify(registration, null, 2), "utf-8");
}

function writeInboxMessageFile(dirs: Dirs, agentName: string, fileName: string, payload: unknown): string {
  const dir = path.join(dirs.inbox, agentName);
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), "utf-8");
  return fullPath;
}

describe("store reservation matching", () => {
  test("pathMatchesReservation normalizes ./ prefixes and supports directory patterns", () => {
    expect(pathMatchesReservation("./src/file.ts", "src/file.ts")).toBe(true);
    expect(pathMatchesReservation("src/file.ts", "./src/file.ts")).toBe(true);

    expect(pathMatchesReservation("src", "src/")).toBe(true);
    expect(pathMatchesReservation("src/nested/file.ts", "src/")).toBe(true);
    expect(pathMatchesReservation("src2/file.ts", "src/")).toBe(false);
  });

  test("getConflictsWithOtherAgents excludes self and reports matching peer reservations", () => {
    const dirs = makeDirs("collab-store-conflicts");

    writeRegistration(
      dirs,
      makeRegistration("SelfAgent", {
        reservations: [{ pattern: "docs/", reason: "self work", since: new Date().toISOString() }],
      }),
    );

    writeRegistration(
      dirs,
      makeRegistration("PeerAgent", {
        reservations: [{ pattern: "src/", reason: "migration", since: new Date().toISOString() }],
      }),
    );

    const conflicts = getConflictsWithOtherAgents(dirs, "SelfAgent", "src/routes/account.ts");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      agent: "PeerAgent",
      pattern: "src/",
      reason: "migration",
      path: "src/routes/account.ts",
    });

    const none = getConflictsWithOtherAgents(dirs, "SelfAgent", "README.md");
    expect(none).toHaveLength(0);
  });
});

describe("store registration ownership", () => {
  test("registerSelf rejects active conflicting owner and heartbeat cannot overwrite it", () => {
    const dirs = makeDirs("collab-store-register");

    const original = makeRegistration("BlueFalcon", { sessionId: "session-a" });
    const conflicting = makeRegistration("BlueFalcon", {
      sessionId: "session-b",
      lastSeenAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(registerSelf(dirs, original)).toBe(true);
    expect(registerSelf(dirs, conflicting)).toBe(false);

    updateSelfHeartbeat(dirs, conflicting);

    const stored = JSON.parse(
      fs.readFileSync(path.join(dirs.registry, "BlueFalcon.json"), "utf-8"),
    ) as AgentRegistration;

    expect(stored.sessionId).toBe("session-a");
    expect(stored.lastSeenAt).toBe(original.lastSeenAt);
  });

  test("unregisterSelf only removes when owner pid/session match", () => {
    const dirs = makeDirs("collab-store-unregister");
    const reg = makeRegistration("SilverPine", { sessionId: "session-live" });

    expect(registerSelf(dirs, reg)).toBe(true);

    unregisterSelf(dirs, reg.name, { pid: reg.pid, sessionId: "wrong-session" });
    expect(fs.existsSync(path.join(dirs.registry, `${reg.name}.json`))).toBe(true);

    unregisterSelf(dirs, reg.name, { pid: reg.pid, sessionId: reg.sessionId });
    expect(fs.existsSync(path.join(dirs.registry, `${reg.name}.json`))).toBe(false);
  });

  test("listActiveAgents excludes dead registrations and prunes stale files", () => {
    const dirs = makeDirs("collab-store-list");

    const alive = makeRegistration("AliveAgent");
    const dead = makeRegistration("DeadAgent", { pid: DEAD_PID, sessionId: "dead-session" });

    writeRegistration(dirs, alive);
    writeRegistration(dirs, dead);

    const listed = listActiveAgents(dirs);
    expect(listed.map((a) => a.name)).toEqual(["AliveAgent"]);
    expect(fs.existsSync(path.join(dirs.registry, "DeadAgent.json"))).toBe(false);
  });
});

describe("store inbox processing", () => {
  test("processInbox quarantines invalid payloads", () => {
    const dirs = makeDirs("collab-store-inbox-invalid");

    writeInboxMessageFile(dirs, "SelfAgent", "bad.json", { invalid: true });

    processInbox(dirs, "SelfAgent", () => {
      throw new Error("handler should not be called for invalid message payloads");
    });

    const inboxFile = path.join(dirs.inbox, "SelfAgent", "bad.json");
    expect(fs.existsSync(inboxFile)).toBe(false);

    const quarantineDir = path.join(dirs.inbox, "SelfAgent", ".invalid");
    expect(fs.existsSync(quarantineDir)).toBe(true);

    const quarantined = fs.readdirSync(quarantineDir);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toContain("bad.json");
  });

  test("processInbox keeps messages when handler throws and removes them on success", () => {
    const dirs = makeDirs("collab-store-inbox-retry");
    const message: InboxMessage = {
      id: "msg-1",
      from: "Sender",
      to: "SelfAgent",
      text: "hello",
      kind: "direct",
      timestamp: new Date().toISOString(),
      urgent: false,
      replyTo: null,
    };

    const messagePath = writeInboxMessageFile(dirs, "SelfAgent", "message.json", message);

    let attempts = 0;

    processInbox(dirs, "SelfAgent", () => {
      attempts += 1;
      throw new Error("simulated processing failure");
    });

    expect(attempts).toBe(1);
    expect(fs.existsSync(messagePath)).toBe(true);

    processInbox(dirs, "SelfAgent", () => {
      attempts += 1;
    });

    expect(attempts).toBe(2);
    expect(fs.existsSync(messagePath)).toBe(false);
  });
});

describe("store messaging", () => {
  test("sendDirect validates inputs and persists trimmed payload + log event", () => {
    const dirs = makeDirs("collab-store-send-direct");
    writeRegistration(dirs, makeRegistration("BlueFalcon"));

    expect(sendDirect(dirs, "SelfAgent", "BlueFalcon", "   ")).toEqual({ ok: false, error: "Message is empty" });
    expect(sendDirect(dirs, "SelfAgent", "SelfAgent", "ping")).toEqual({
      ok: false,
      error: "Cannot send direct message to yourself",
    });

    const missing = sendDirect(dirs, "SelfAgent", "MissingAgent", "ping");
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected missing target to fail");
    expect(missing.error).toContain("not active");

    const sent = sendDirect(dirs, "SelfAgent", "BlueFalcon", "  status update  ", "parent-1", true);
    expect(sent).toEqual({ ok: true });

    const inboxDir = path.join(dirs.inbox, "BlueFalcon");
    const inboxFiles = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".json"));
    expect(inboxFiles).toHaveLength(1);

    const payload = JSON.parse(fs.readFileSync(path.join(inboxDir, inboxFiles[0]!), "utf-8")) as InboxMessage;
    expect(payload).toMatchObject({
      from: "SelfAgent",
      to: "BlueFalcon",
      text: "status update",
      kind: "direct",
      urgent: true,
      replyTo: "parent-1",
    });

    const events = readMessageLog(dirs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      from: "SelfAgent",
      to: "BlueFalcon",
      text: "status update",
      kind: "direct",
      urgent: true,
      replyTo: "parent-1",
    });
  });

  test("sendBroadcast reports per-recipient failures and still appends one broadcast log event", () => {
    const dirs = makeDirs("collab-store-send-broadcast");

    writeRegistration(dirs, makeRegistration("BlockedAgent"));
    writeRegistration(dirs, makeRegistration("ReadyAgent"));

    fs.mkdirSync(dirs.inbox, { recursive: true });
    fs.writeFileSync(path.join(dirs.inbox, "BlockedAgent"), "not-a-directory", "utf-8");

    const result = sendBroadcast(dirs, "SelfAgent", "  wave complete  ", true);
    expect(result.ok).toBe(true);

    if (!result.ok) throw new Error("expected broadcast to succeed with partial delivery");

    expect(result.delivered).toEqual(["ReadyAgent"]);
    expect(result.failed).toEqual(["BlockedAgent"]);

    const readyInboxFiles = fs
      .readdirSync(path.join(dirs.inbox, "ReadyAgent"))
      .filter((name) => name.endsWith(".json"));
    expect(readyInboxFiles).toHaveLength(1);

    const events = readMessageLog(dirs);
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({
      from: "SelfAgent",
      to: "all",
      text: "wave complete",
      kind: "broadcast",
      urgent: true,
    });

    expect([...(event.recipients ?? [])].sort()).toEqual(["BlockedAgent", "ReadyAgent"]);
  });

  test("readMessageLog skips malformed lines and readMessageLogTail applies limits", () => {
    const dirs = makeDirs("collab-store-log-tail");

    const event1: MessageLogEvent = {
      id: "event-1",
      from: "A",
      to: "B",
      text: "hello",
      kind: "direct",
      timestamp: new Date().toISOString(),
    };

    const event2: MessageLogEvent = {
      id: "event-2",
      from: "A",
      to: "all",
      text: "announcement",
      kind: "broadcast",
      timestamp: new Date().toISOString(),
      recipients: ["B"],
    };

    fs.writeFileSync(
      dirs.messageLog,
      `${JSON.stringify(event1)}\nthis-is-not-json\n${JSON.stringify({ notAnEvent: true })}\n${JSON.stringify(event2)}\n`,
      "utf-8",
    );

    const all = readMessageLog(dirs);
    expect(all.map((event) => event.id)).toEqual(["event-1", "event-2"]);

    expect(readMessageLogTail(dirs, 1).map((event) => event.id)).toEqual(["event-2"]);
    expect(readMessageLogTail(dirs, 0)).toEqual([]);
  });
});
