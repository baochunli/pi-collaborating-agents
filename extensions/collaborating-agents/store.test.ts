import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatAgentDisplayName,
  getConflictsWithOtherAgents,
  listActiveAgents,
  pathMatchesReservation,
  processInbox,
  readMessageLog,
  readMessageLogTail,
  registerSelf,
  resolveSubagentRunRecord,
  resolveActiveAgentName,
  resolveThreadPeerName,
  sendBroadcast,
  sendDirect,
  listSubagentRunRecords,
  unregisterSelf,
  updateSubagentRunRecord,
  updateSubagentRunRecordWith,
  updateSelfHeartbeat,
  writeSubagentRunRecord,
} from "./store.ts";
import type { AgentRegistration, Dirs, InboxMessage, MessageLogEvent, SubagentRunRecord } from "./types.ts";

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
    runs: path.join(base, "runs"),
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

function makeRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const now = new Date().toISOString();
  return {
    recordId: "batch-1-0",
    batchRunId: "batch-1",
    taskIndex: 0,
    parentAgent: "Coordinator",
    parentSessionId: "parent-session",
    parentSessionFile: "/tmp/parent-session.jsonl",
    parentPid: process.pid,
    type: "worker",
    taskPreview: "Inspect the codebase",
    cwd: process.cwd(),
    status: "launching",
    launchMode: "process",
    startedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
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

describe("store subagent run records", () => {
  test("writeSubagentRunRecord stores planned records by child record id and bounds previews", () => {
    const dirs = makeDirs("collab-store-runs-write");
    const longTask = "task ".repeat(400);
    const longOutput = "output ".repeat(500);

    const written = writeSubagentRunRecord(
      dirs,
      makeRunRecord({
        recordId: "batch-abc-0",
        batchRunId: "batch-abc",
        taskPreview: longTask,
        outputPreview: longOutput,
      }),
    );

    expect(written).toBe(true);

    const runPath = path.join(dirs.runs, "batch-abc-0.json");
    expect(fs.existsSync(runPath)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(runPath, "utf-8")) as SubagentRunRecord;
    expect(stored).toMatchObject({
      recordId: "batch-abc-0",
      batchRunId: "batch-abc",
      taskIndex: 0,
      status: "launching",
    });
    expect(stored.name).toBeUndefined();
    expect(stored.displayName).toBeUndefined();
    expect(stored.sessionId).toBeUndefined();
    expect(stored.sessionFile).toBeUndefined();
    expect(stored.taskPreview.length).toBeLessThanOrEqual(1000);
    expect(stored.taskPreview).toContain("[truncated");
    expect(stored.outputPreview?.length).toBeLessThanOrEqual(2000);
    expect(stored.outputPreview).toContain("[truncated");
  });

  test("updateSubagentRunRecord merges patches without dropping concurrent metadata", () => {
    const dirs = makeDirs("collab-store-runs-update");

    expect(writeSubagentRunRecord(dirs, makeRunRecord())).toBe(true);
    expect(
      updateSubagentRunRecord(dirs, "batch-1-0", {
        sessionId: "session-live",
        sessionFile: "/tmp/session-live.jsonl",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toBe(true);

    expect(
      updateSubagentRunRecord(dirs, "batch-1-0", {
        status: "completed",
        completedAt: "2026-01-01T00:00:02.000Z",
        outputPreview: "done",
      }),
    ).toBe(true);

    const [stored] = listSubagentRunRecords(dirs);
    expect(stored).toMatchObject({
      recordId: "batch-1-0",
      status: "completed",
      sessionId: "session-live",
      sessionFile: "/tmp/session-live.jsonl",
      completedAt: "2026-01-01T00:00:02.000Z",
      outputPreview: "done",
    });
  });

  test("updateSubagentRunRecord ignores undefined patch fields so metadata is not erased", () => {
    const dirs = makeDirs("collab-store-runs-undefined");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          sessionId: "session-live",
          sessionFile: "/tmp/session-live.jsonl",
        }),
      ),
    ).toBe(true);

    expect(
      updateSubagentRunRecord(dirs, "batch-1-0", {
        status: "completed",
        sessionId: undefined,
        sessionFile: undefined,
        completedAt: "2026-01-01T00:00:02.000Z",
      }),
    ).toBe(true);

    const [stored] = listSubagentRunRecords(dirs);
    expect(stored).toMatchObject({
      recordId: "batch-1-0",
      status: "completed",
      sessionId: "session-live",
      sessionFile: "/tmp/session-live.jsonl",
      completedAt: "2026-01-01T00:00:02.000Z",
    });
  });

  test("updateSubagentRunRecordWith merges against the latest stored record", () => {
    const dirs = makeDirs("collab-store-runs-update-with");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          status: "completed",
          sessionId: "session-live",
          sessionFile: "/tmp/session-live.jsonl",
          completedAt: "2026-01-01T00:00:02.000Z",
          exitCode: 0,
          outputPreview: "done",
        }),
      ),
    ).toBe(true);

    expect(
      updateSubagentRunRecordWith(dirs, "batch-1-0", (existing) => ({
        status: existing.status === "completed" || existing.status === "failed" ? existing.status : "running",
        name: "worker-aa-SunnyBreeze",
        displayName: formatAgentDisplayName("worker-aa-SunnyBreeze"),
        sessionId: existing.sessionId ?? "new-session",
        sessionFile: existing.sessionFile ?? "/tmp/new-session.jsonl",
        lastSeenAt: "2026-01-01T00:00:03.000Z",
      })),
    ).toBe(true);

    const [stored] = listSubagentRunRecords(dirs);
    expect(stored).toMatchObject({
      recordId: "batch-1-0",
      status: "completed",
      name: "worker-aa-SunnyBreeze",
      displayName: "SunnyBreeze",
      sessionId: "session-live",
      sessionFile: "/tmp/session-live.jsonl",
      completedAt: "2026-01-01T00:00:02.000Z",
      exitCode: 0,
      outputPreview: "done",
      lastSeenAt: "2026-01-01T00:00:03.000Z",
    });
  });

  test("listSubagentRunRecords ignores corrupt files and returns newest records first", () => {
    const dirs = makeDirs("collab-store-runs-list");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "batch-1-0",
          batchRunId: "batch-1",
          lastSeenAt: "2026-01-01T00:00:01.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "batch-2-0",
          batchRunId: "batch-2",
          lastSeenAt: "2026-01-01T00:00:03.000Z",
        }),
      ),
    ).toBe(true);

    fs.writeFileSync(path.join(dirs.runs, "corrupt.json"), "{not json", "utf-8");

    expect(listSubagentRunRecords(dirs).map((record) => record.recordId)).toEqual(["batch-2-0", "batch-1-0"]);
  });

  test("listSubagentRunRecords derives stale state for old active records without changing status", () => {
    const dirs = makeDirs("collab-store-runs-stale");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "old-running-0",
          batchRunId: "old-running",
          status: "running",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "old-completed-0",
          batchRunId: "old-completed",
          status: "completed",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);

    const records = listSubagentRunRecords(dirs, {
      now: new Date("2026-01-01T00:10:00.000Z"),
      staleAfterMs: 60_000,
    });

    const running = records.find((record) => record.recordId === "old-running-0");
    const completed = records.find((record) => record.recordId === "old-completed-0");
    expect(running).toMatchObject({ status: "running", isStale: true });
    expect(completed).toMatchObject({ status: "completed", isStale: false });
  });

  test("resolveSubagentRunRecord supports names, prefixes, session id, and record id selectors", () => {
    const dirs = makeDirs("collab-store-runs-resolve");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "sunny-run-0",
          batchRunId: "batch-sunny",
          name: "worker-aa-SunnyBreeze",
          sessionId: "session-sunny-123",
        }),
      ),
    ).toBe(true);
    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "misty-run-0",
          batchRunId: "batch-misty",
          name: "reviewer-bb-MistyVale",
          sessionId: "session-misty-456",
        }),
      ),
    ).toBe(true);

    const context = { parentAgent: "Coordinator", parentSessionId: "parent-session" };

    expect(resolveSubagentRunRecord(dirs, "worker-aa-SunnyBreeze", context)).toMatchObject({
      status: "ok",
      record: { recordId: "sunny-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "SunnyBreeze", context)).toMatchObject({
      status: "ok",
      record: { recordId: "sunny-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "SunnyBreeze (subagent)", context)).toMatchObject({
      status: "ok",
      record: { recordId: "sunny-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "reviewer-bb", context)).toMatchObject({
      status: "ok",
      record: { recordId: "misty-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "Misty", context)).toMatchObject({
      status: "ok",
      record: { recordId: "misty-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "session-sunny", context)).toMatchObject({
      status: "ok",
      record: { recordId: "sunny-run-0" },
    });
    expect(resolveSubagentRunRecord(dirs, "sunny-run", context)).toMatchObject({
      status: "ok",
      record: { recordId: "sunny-run-0" },
    });
  });

  test("resolveSubagentRunRecord returns ambiguity for shared batch ids and ambiguous display prefixes", () => {
    const dirs = makeDirs("collab-store-runs-resolve-ambiguous");

    for (const [recordId, name] of [
      ["batch-shared-0", "worker-aa-SunnyBreeze"],
      ["batch-shared-1", "reviewer-bb-SunnyBrook"],
    ] as const) {
      expect(
        writeSubagentRunRecord(
          dirs,
          makeRunRecord({
            recordId,
            batchRunId: "batch-shared",
            name,
          }),
        ),
      ).toBe(true);
    }

    const context = { parentAgent: "Coordinator", parentSessionId: "parent-session" };

    expect(resolveSubagentRunRecord(dirs, "batch-shared", context)).toMatchObject({
      status: "ambiguous",
      candidates: [{ recordId: "batch-shared-0" }, { recordId: "batch-shared-1" }],
    });
    expect(resolveSubagentRunRecord(dirs, "Sunny", context)).toMatchObject({
      status: "ambiguous",
      candidates: [{ recordId: "batch-shared-0" }, { recordId: "batch-shared-1" }],
    });
  });

  test("resolveSubagentRunRecord scopes latest and never falls back to global newest records", () => {
    const dirs = makeDirs("collab-store-runs-resolve-latest");

    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "global-newest-0",
          batchRunId: "global-newest",
          parentAgent: "OtherCoordinator",
          parentSessionId: "other-session",
          parentPid: 111,
          lastSeenAt: "2026-01-01T00:04:00.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "scoped-stale-0",
          batchRunId: "scoped-stale",
          parentSessionId: "current-session",
          status: "running",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);
    expect(
      writeSubagentRunRecord(
        dirs,
        makeRunRecord({
          recordId: "scoped-fresh-0",
          batchRunId: "scoped-fresh",
          parentSessionId: "current-session",
          status: "running",
          lastSeenAt: "2026-01-01T00:01:45.000Z",
        }),
      ),
    ).toBe(true);

    expect(
      resolveSubagentRunRecord(dirs, "latest", {
        parentAgent: "Coordinator",
        parentSessionId: "current-session",
        now: new Date("2026-01-01T00:02:00.000Z"),
        staleAfterMs: 30_000,
      }),
    ).toMatchObject({
      status: "ok",
      record: { recordId: "scoped-fresh-0", isStale: false },
    });

    expect(
      resolveSubagentRunRecord(dirs, "latest", {
        parentAgent: "Coordinator",
        parentPid: process.pid,
      }),
    ).toMatchObject({
      status: "ok",
      record: { recordId: "scoped-fresh-0" },
    });

    expect(
      resolveSubagentRunRecord(dirs, "latest", {
        parentAgent: "UnknownCoordinator",
        parentSessionId: "missing-session",
      }),
    ).toMatchObject({
      status: "not_found",
      message: expect.stringContaining("No runs for current coordinator"),
      candidates: expect.any(Array),
    });
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
  test("resolveActiveAgentName accepts unique display aliases and role labels", () => {
    const dirs = makeDirs("collab-store-resolve-active");
    writeRegistration(dirs, makeRegistration("reviewer-ba15-SunnyBreeze"));

    expect(formatAgentDisplayName("reviewer-ba15-SunnyBreeze")).toBe("SunnyBreeze");
    expect(resolveActiveAgentName(dirs, "reviewer-ba15-SunnyBreeze")).toEqual({
      ok: true,
      name: "reviewer-ba15-SunnyBreeze",
    });
    expect(resolveActiveAgentName(dirs, "SunnyBreeze")).toEqual({
      ok: true,
      name: "reviewer-ba15-SunnyBreeze",
    });
    expect(resolveActiveAgentName(dirs, "SunnyBreeze (subagent)")).toEqual({
      ok: true,
      name: "reviewer-ba15-SunnyBreeze",
    });
  });

  test("resolveActiveAgentName rejects ambiguous display aliases", () => {
    const dirs = makeDirs("collab-store-resolve-ambiguous");
    writeRegistration(dirs, makeRegistration("reviewer-ba15-SunnyBreeze"));
    writeRegistration(dirs, makeRegistration("worker-c920-SunnyBreeze"));

    const resolved = resolveActiveAgentName(dirs, "SunnyBreeze");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected ambiguous alias to fail");
    expect(resolved.error).toContain("ambiguous");
    expect(resolved.matches).toEqual([
      "reviewer-ba15-SunnyBreeze",
      "worker-c920-SunnyBreeze",
    ]);
  });

  test("resolveThreadPeerName accepts historical display aliases even after the peer exits", () => {
    const dirs = makeDirs("collab-store-resolve-thread-historical");
    const events: MessageLogEvent[] = [
      {
        id: "event-1",
        from: "reviewer-ba15-SunnyBreeze",
        to: "RapidRiver",
        text: "Done",
        kind: "direct",
        timestamp: new Date().toISOString(),
      },
    ];

    expect(resolveThreadPeerName(dirs, "RapidRiver", events, "SunnyBreeze")).toEqual({
      ok: true,
      name: "reviewer-ba15-SunnyBreeze",
    });
  });

  test("resolveThreadPeerName rejects ambiguous historical display aliases", () => {
    const dirs = makeDirs("collab-store-resolve-thread-ambiguous");
    const events: MessageLogEvent[] = [
      {
        id: "event-1",
        from: "reviewer-ba15-SunnyBreeze",
        to: "RapidRiver",
        text: "Done",
        kind: "direct",
        timestamp: new Date().toISOString(),
      },
      {
        id: "event-2",
        from: "worker-c920-SunnyBreeze",
        to: "RapidRiver",
        text: "Also done",
        kind: "direct",
        timestamp: new Date().toISOString(),
      },
    ];

    const resolved = resolveThreadPeerName(dirs, "RapidRiver", events, "SunnyBreeze");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected ambiguous thread alias to fail");
    expect(resolved.error).toContain("ambiguous");
    expect(resolved.matches).toEqual([
      "reviewer-ba15-SunnyBreeze",
      "worker-c920-SunnyBreeze",
    ]);
  });

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

  test("sendDirect accepts a unique display alias and stores the canonical recipient", () => {
    const dirs = makeDirs("collab-store-send-direct-alias");
    writeRegistration(dirs, makeRegistration("reviewer-ba15-SunnyBreeze"));

    const sent = sendDirect(dirs, "RapidRiver", "SunnyBreeze", "hello there");
    expect(sent).toEqual({ ok: true });

    const inboxDir = path.join(dirs.inbox, "reviewer-ba15-SunnyBreeze");
    const inboxFiles = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".json"));
    expect(inboxFiles).toHaveLength(1);

    const payload = JSON.parse(fs.readFileSync(path.join(inboxDir, inboxFiles[0]!), "utf-8")) as InboxMessage;
    expect(payload.to).toBe("reviewer-ba15-SunnyBreeze");

    const events = readMessageLog(dirs);
    expect(events).toHaveLength(1);
    expect(events[0]?.to).toBe("reviewer-ba15-SunnyBreeze");
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
