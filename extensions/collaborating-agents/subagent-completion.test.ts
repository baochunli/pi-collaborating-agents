import { describe, expect, test } from "bun:test";
import {
  buildSubagentCompletionMessagePayload,
  collectSpawnResults,
  partitionPendingSubagentCompletionUpdates,
  shouldDeferSubagentCompletionUpdate,
  type PendingSubagentCompletionUpdate,
} from "./subagent-completion.ts";
import type { SpawnResult } from "./subagent-spawn.ts";

function makeSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    agent: "worker",
    name: "SwiftTiger-1a2b-ClearWave",
    task: "test",
    exitCode: 0,
    output: "done",
    workingDirectory: process.cwd(),
    launchArgs: ["--mode", "json"],
    launchCommand: "pi --mode json",
    launchPrompt: "Task: test",
    launchEnv: {
      PI_AGENT_NAME: "SwiftTiger-1a2b-ClearWave",
      PI_COLLAB_SUBAGENT_DEPTH: "1",
    },
    ...overrides,
  };
}

describe("subagent completion payload helpers", () => {
  test("collectSpawnResults returns single result when details.result exists", () => {
    const single = makeSpawnResult({ name: "Solo" });
    const results = collectSpawnResults({ result: single });
    expect(results).toEqual([single]);
  });

  test("collectSpawnResults prefers details.results for parallel runs", () => {
    const fallback = makeSpawnResult({ name: "Fallback" });
    const first = makeSpawnResult({ name: "First" });
    const second = makeSpawnResult({ name: "Second" });

    const results = collectSpawnResults({ result: fallback, results: [first, second] });
    expect(results).toEqual([first, second]);
  });

  test("buildSubagentCompletionMessagePayload formats single successful result", () => {
    const single = makeSpawnResult({ name: "SwiftTiger-1a2b-ClearWave", output: "## Summary\nall good" });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", result: single },
      isError: false,
    });

    expect(payload.customType).toBe("collab_focus_status");
    expect(payload.content).toContain("Received final results from ClearWave.");
    expect(payload.content).toContain("## Summary\nall good");
    expect(payload.details).toEqual({ mode: "subagent", result: single });
  });

  test("buildSubagentCompletionMessagePayload summarizes parallel failures", () => {
    const ok = makeSpawnResult({ name: "SwiftTiger-1a2b-ClearWave", output: "ok output", exitCode: 0 });
    const failed = makeSpawnResult({
      name: "SwiftTiger-1a2b-BrightRiver",
      output: "bad output",
      exitCode: 1,
      error: "boom",
    });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", results: [ok, failed] },
      isError: true,
    });

    expect(payload.content).toContain("Received final results from 2 subagents (1 succeeded, 1 failed).");
    expect(payload.content).toContain("### 1. ClearWave (ok)");
    expect(payload.content).toContain("### 2. BrightRiver (failed)");
    expect(payload.content).toContain("ok output");
    expect(payload.content).toContain("bad output");
  });
});

describe("subagent completion routing helpers", () => {
  test("shouldDeferSubagentCompletionUpdate only defers when target is different", () => {
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: undefined, activeSessionFile: undefined })).toBe(
      false,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: "/tmp/a.jsonl" })).toBe(
      false,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: "/tmp/b.jsonl" })).toBe(
      true,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: undefined })).toBe(
      true,
    );
  });

  test("partitionPendingSubagentCompletionUpdates separates deliverable and deferred entries", () => {
    const updates: PendingSubagentCompletionUpdate[] = [
      {
        payload: {
          customType: "collab_focus_status",
          content: "for-a",
          display: true,
          details: {},
        },
        targetSessionFile: "/tmp/a.jsonl",
      },
      {
        payload: {
          customType: "collab_focus_status",
          content: "for-b",
          display: true,
          details: {},
        },
        targetSessionFile: "/tmp/b.jsonl",
      },
      {
        payload: {
          customType: "collab_focus_status",
          content: "global",
          display: true,
          details: {},
        },
      },
    ];

    const partitioned = partitionPendingSubagentCompletionUpdates(updates, "/tmp/a.jsonl");

    expect(partitioned.deliverable.map((entry) => entry.payload.content)).toEqual(["for-a", "global"]);
    expect(partitioned.deferred.map((entry) => entry.payload.content)).toEqual(["for-b"]);
  });
});
