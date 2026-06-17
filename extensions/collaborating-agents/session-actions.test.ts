import { describe, expect, test } from "bun:test";
import {
  formatSubagentRunLine,
  formatSubagentRunResolutionError,
  formatSubagentSession,
  formatSubagentSessions,
} from "./session-actions.ts";
import type { ResolveSubagentRunRecordResult, SubagentRunRecord } from "./types.ts";

function record(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "abcdef123456",
    parentAgent: "Coordinator",
    name: "worker-abcd-WarmMoon",
    type: "worker",
    task: "Inspect",
    status: "completed",
    sessionId: "019ecdf41234567890",
    sessionFile: "/tmp/session.jsonl",
    cwd: "/repo",
    model: "provider/model",
    launchMode: "process",
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: "2026-06-17T00:01:00.000Z",
    lastSeenAt: "2026-06-17T00:01:00.000Z",
    ...overrides,
  };
}

describe("subagent session action formatting", () => {
  test("formats sessions list with compact run and session metadata", () => {
    expect(formatSubagentSessions([record()])).toBe(
      "Subagent sessions:\n- WarmMoon worker completed • run abcdef12 • session 019ecdf41234... • /tmp/session.jsonl",
    );
    expect(formatSubagentSessions([])).toBe("No subagent sessions found.");
  });

  test("formats a resolved session detail block", () => {
    expect(formatSubagentSession(record())).toContain("WarmMoon\nStatus: completed\nRun ID: abcdef123456");
    expect(formatSubagentSession(record({ sessionId: undefined, sessionFile: undefined, model: undefined }))).toContain(
      "Session ID: pending\nSession file: pending",
    );
  });

  test("formats resolution errors with candidate runs", () => {
    const result: ResolveSubagentRunRecordResult = {
      ok: false,
      reason: "ambiguous",
      selector: "worker",
      message: "Selector 'worker' is ambiguous.",
      candidates: [record()],
    };
    if (result.ok) throw new Error("expected failure fixture");

    expect(formatSubagentRunResolutionError(result)).toContain("Selector 'worker' is ambiguous.\n\nCandidates:\n- WarmMoon worker completed");
    expect(formatSubagentRunLine(record({ runId: "short" }))).toContain("run short");
  });
});
