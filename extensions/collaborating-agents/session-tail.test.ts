import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractAssistantText,
  formatSessionTail,
  parseSessionJsonlLine,
  readSessionTail,
} from "./session-tail.ts";

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-session-tail-"));
  return path.join(dir, name);
}

describe("session tail parsing", () => {
  test("extractAssistantText joins text content and ignores non-text content", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "hello" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  test("parses Pi session, assistant, tool call, tool result, and stop events", () => {
    expect(parseSessionJsonlLine(JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-01-01T00:00:00.000Z" }))).toEqual({
      entries: [{ kind: "session", sessionId: "session-1", timestamp: "2026-01-01T00:00:00.000Z" }],
      malformed: false,
    });

    const assistant = parseSessionJsonlLine(
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Use the tool" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
      }),
    );
    expect(assistant.entries).toEqual([
      { kind: "assistant_text", text: "Use the tool", timestamp: "2026-01-01T00:00:01.000Z", stopReason: "toolUse" },
      {
        kind: "assistant_tool_call",
        toolCallId: "tool-1",
        toolName: "read",
        argumentsText: "{\"path\":\"README.md\"}",
        timestamp: "2026-01-01T00:00:01.000Z",
        stopReason: "toolUse",
      },
      { kind: "stop", stopReason: "toolUse", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);

    expect(
      parseSessionJsonlLine(
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
          },
        }),
      ).entries,
    ).toEqual([{ kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "file contents" }]);

    expect(
      parseSessionJsonlLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
          },
        }),
      ).entries,
    ).toEqual([{ kind: "assistant_text", text: "final answer", stopReason: "message_end" }]);
  });

  test("returns malformed for invalid json lines", () => {
    expect(parseSessionJsonlLine("{not-json")).toEqual({ entries: [], malformed: true });
  });
});

describe("session tail reading and formatting", () => {
  test("reads bounded suffixes, discards partial first lines, and counts malformed lines", () => {
    const file = tempFile("session.jsonl");
    const lines = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `old-${"x".repeat(200)}` }] } }),
      "{bad",
      JSON.stringify({ type: "session", id: "session-2" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new" }] } }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");

    const tail = readSessionTail(file, { maxBytes: lines.slice(1).join("\n").length + 20, maxLines: 10 });

    expect(tail.truncatedStart).toBe(true);
    expect(tail.malformedLineCount).toBe(1);
    expect(tail.entries).toEqual([
      { kind: "session", sessionId: "session-2" },
      { kind: "assistant_text", text: "new", stopReason: "message_end" },
    ]);
  });

  test("truncates long text and tool outputs safely", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(20) }],
      },
    });

    expect(parseSessionJsonlLine(line, { textLimit: 8 }).entries).toEqual([
      { kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "xxxxx..." },
    ]);
  });

  test("formats stable concise output and labels only the final assistant response", () => {
    const output = formatSessionTail(
      [
        { kind: "session", sessionId: "session-3" },
        { kind: "assistant_text", text: "first" },
        { kind: "assistant_tool_call", toolCallId: "tool-1", toolName: "read", argumentsText: "{\"path\":\"README.md\"}" },
        { kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "ok" },
        { kind: "assistant_text", text: "done" },
      ],
      { runStatus: "completed" },
    );

    expect(output).toBe(
      [
        "session session-3",
        "assistant: first",
        "assistant tool call read tool-1: {\"path\":\"README.md\"}",
        "tool result read tool-1: ok",
        "assistant final: done",
      ].join("\n"),
    );
  });

  test("does not label tool-use assistant text as final", () => {
    const output = formatSessionTail(
      [
        { kind: "assistant_text", text: "I will inspect the file", stopReason: "toolUse" },
        { kind: "assistant_tool_call", toolCallId: "tool-1", toolName: "read" },
        { kind: "stop", stopReason: "toolUse" },
      ],
      { runStatus: "failed" },
    );

    expect(output).toBe(
      [
        "assistant: I will inspect the file",
        "assistant tool call read tool-1",
        "stop: toolUse",
      ].join("\n"),
    );
  });
});
