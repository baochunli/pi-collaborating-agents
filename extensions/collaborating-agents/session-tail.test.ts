import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractAssistantText,
  formatSessionTail,
  parseSessionJsonlLine,
  readSessionTail,
} from "./session-tail.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-session-tail-"));
  tempDirs.push(dir);
  return dir;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("session transcript tail parser", () => {
  test("extractAssistantText joins text blocks and ignores thinking/tool blocks", () => {
    expect(
      extractAssistantText([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "First paragraph" },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
        { type: "text", text: "Second paragraph" },
      ]),
    ).toBe("First paragraph\nSecond paragraph");
  });

  test("parseSessionJsonlLine emits session, assistant text, tool use, tool result, and final entries", () => {
    expect(
      parseSessionJsonlLine(
        jsonLine({ type: "session", id: "019session", timestamp: "2026-06-17T02:00:00.000Z" }).trim(),
      ).entries,
    ).toEqual([
      { kind: "session", sessionId: "019session", timestamp: "2026-06-17T02:00:00.000Z" },
    ]);

    const assistantTool = parseSessionJsonlLine(
      jsonLine({
        type: "message",
        timestamp: "2026-06-17T02:01:00.000Z",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "I will inspect the file." },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md", limit: 80 } },
          ],
        },
      }).trim(),
    );

    expect(assistantTool.entries).toEqual([
      {
        kind: "assistant",
        text: "I will inspect the file.",
        final: false,
        stopReason: "toolUse",
        timestamp: "2026-06-17T02:01:00.000Z",
      },
      {
        kind: "tool-use",
        name: "read",
        toolCallId: "call-1",
        args: { path: "README.md", limit: 80 },
        compactArgs: "path=README.md limit=80",
        paths: ["README.md"],
        timestamp: "2026-06-17T02:01:00.000Z",
      },
    ]);

    const toolResult = parseSessionJsonlLine(
      jsonLine({
        type: "message",
        timestamp: "2026-06-17T02:02:00.000Z",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call-1",
          content: [{ type: "text", text: "line one\nline two\nline three" }],
          isError: false,
        },
      }).trim(),
    );

    expect(toolResult.entries).toEqual([
      {
        kind: "tool-result",
        name: "read",
        toolCallId: "call-1",
        summary: "line one\nline two\nline three",
        isError: false,
        timestamp: "2026-06-17T02:02:00.000Z",
      },
    ]);

    const final = parseSessionJsonlLine(
      jsonLine({
        type: "message",
        timestamp: "2026-06-17T02:03:00.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
        },
      }).trim(),
    );

    expect(final.entries).toEqual([
      {
        kind: "assistant",
        text: "Done.",
        final: true,
        stopReason: "stop",
        timestamp: "2026-06-17T02:03:00.000Z",
      },
    ]);
  });

  test("readSessionTail skips malformed JSONL, reports count, enforces limit, and honors maxBytes", () => {
    const dir = makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");

    fs.writeFileSync(
      sessionFile,
      [
        "not-json\n",
        jsonLine({ type: "session", id: "older", timestamp: "2026-06-17T01:00:00.000Z" }),
        jsonLine({
          type: "message",
          timestamp: "2026-06-17T01:01:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "older text" }], stopReason: "toolUse" },
        }),
        jsonLine({
          type: "message",
          timestamp: "2026-06-17T01:02:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "newer text" }], stopReason: "stop" },
        }),
      ].join(""),
      "utf-8",
    );

    const fullTail = readSessionTail(sessionFile, { limit: 2, maxBytes: 10_000 });
    expect(fullTail.malformedLineCount).toBe(1);
    expect(fullTail.truncatedStart).toBe(false);
    expect(fullTail.entries.map((entry) => entry.kind)).toEqual(["assistant", "assistant"]);
    expect(fullTail.entries.at(-1)).toMatchObject({ text: "newer text", final: true });

    const cappedTail = readSessionTail(sessionFile, { limit: 10, maxBytes: 180 });
    expect(cappedTail.bytesRead).toBeLessThanOrEqual(180);
    expect(cappedTail.truncatedStart).toBe(true);
    expect(cappedTail.malformedLineCount).toBe(0);
    expect(cappedTail.entries).toHaveLength(1);
    expect(cappedTail.entries[0]).toMatchObject({ kind: "assistant", text: "newer text", final: true });
  });

  test("formatSessionTail produces concise stable output, truncates long fields, and supports raw output", () => {
    const entries = [
      { kind: "session" as const, sessionId: "019session", timestamp: "2026-06-17T02:00:00.000Z" },
      {
        kind: "assistant" as const,
        text: "I will inspect the file.",
        final: false,
        stopReason: "toolUse",
        timestamp: "2026-06-17T02:01:00.000Z",
      },
      {
        kind: "tool-use" as const,
        name: "read",
        toolCallId: "call-1",
        compactArgs: "path=README.md limit=80",
        paths: ["README.md"],
        timestamp: "2026-06-17T02:01:30.000Z",
      },
      {
        kind: "tool-result" as const,
        name: "read",
        summary: "A".repeat(140),
        isError: false,
        timestamp: "2026-06-17T02:02:00.000Z",
      },
      {
        kind: "assistant" as const,
        text: "Final answer",
        final: true,
        stopReason: "stop",
        timestamp: "2026-06-17T02:03:00.000Z",
      },
    ];

    expect(formatSessionTail(entries, { textLimit: 48 })).toBe(
      [
        "02:00 session 019session",
        "02:01 assistant (toolUse): I will inspect the file.",
        "02:01 tool read path=README.md limit=80",
        `02:02 toolResult read: ${"A".repeat(47)}…`,
        "02:03 assistant final (stop): Final answer",
      ].join("\n"),
    );

    expect(formatSessionTail(entries, { raw: true })).toBe(JSON.stringify(entries, null, 2));
  });
});
