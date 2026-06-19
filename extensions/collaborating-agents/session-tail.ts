import * as fs from "node:fs";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 200;
const DEFAULT_TEXT_LIMIT = 2000;

export type SessionTailEntry =
  | {
      kind: "session";
      sessionId: string;
      timestamp?: string;
    }
  | {
      kind: "assistant_text";
      text: string;
      timestamp?: string;
      stopReason?: string;
    }
  | {
      kind: "assistant_tool_call";
      toolCallId?: string;
      toolName?: string;
      argumentsText?: string;
      timestamp?: string;
      stopReason?: string;
    }
  | {
      kind: "assistant_error";
      errorText: string;
      timestamp?: string;
      stopReason?: string;
    }
  | {
      kind: "tool_result";
      toolCallId?: string;
      toolName?: string;
      text: string;
      timestamp?: string;
    }
  | {
      kind: "stop";
      stopReason: string;
      timestamp?: string;
    };

export interface SessionTailParseOptions {
  textLimit?: number;
}

export interface SessionTailReadOptions extends SessionTailParseOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface SessionTailReadResult {
  entries: SessionTailEntry[];
  malformedLineCount: number;
  bytesRead: number;
  truncatedStart: boolean;
  truncatedLineCount: number;
}

export interface SessionTailFormatOptions {
  runStatus?: "launching" | "running" | "completed" | "failed";
}

function truncateText(value: string, limit = DEFAULT_TEXT_LIMIT): string {
  const max = Math.max(0, Math.floor(limit));
  if (value.length <= max) return value;
  if (max <= 3) return ".".repeat(max);
  return `${value.slice(0, max - 3)}...`;
}

function optionalTimestamp(value: Record<string, unknown>, message?: Record<string, unknown>): string | undefined {
  const candidate = value.timestamp ?? value.createdAt ?? message?.timestamp ?? message?.createdAt;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function withTimestamp<T extends Record<string, unknown>>(entry: T, timestamp: string | undefined): T {
  if (!timestamp) return entry;
  return { ...entry, timestamp };
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return undefined;
      const p = part as Record<string, unknown>;
      return p.type === "text" && typeof p.text === "string" ? p.text : undefined;
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0);
}

export function extractAssistantText(content: unknown, options: SessionTailParseOptions = {}): string {
  return truncateText(textParts(content).join("\n").trim(), options.textLimit);
}

function contentToolCalls(content: unknown): Array<{ id?: string; name?: string; argumentsText?: string }> {
  if (!Array.isArray(content)) return [];

  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const p = part as Record<string, unknown>;
    if (p.type !== "toolCall") return [];

    const args = p.arguments;
    return [{
      id: typeof p.id === "string" ? p.id : undefined,
      name: typeof p.name === "string" ? p.name : undefined,
      argumentsText: typeof args === "undefined" ? undefined : JSON.stringify(args),
    }];
  });
}

function assistantErrorText(message: Record<string, unknown>, options: SessionTailParseOptions): string | undefined {
  const direct = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  const diagnostic = Array.isArray(message.diagnostics)
    ? message.diagnostics
        .map((diagnostic) => {
          if (!diagnostic || typeof diagnostic !== "object") return "";
          const record = diagnostic as Record<string, unknown>;
          const error = record.error;
          if (error && typeof error === "object") {
            const nested = error as Record<string, unknown>;
            if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
          }
          if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
          return "";
        })
        .find((message) => message.length > 0) ?? ""
    : "";
  const text = direct || diagnostic;
  if (!text) return undefined;
  const formatted = text.startsWith("Error:") ? text : `Error: ${text}`;
  return truncateText(formatted, options.textLimit);
}

function parseMessageEvent(event: Record<string, unknown>, options: SessionTailParseOptions): SessionTailEntry[] {
  const message = event.message && typeof event.message === "object"
    ? event.message as Record<string, unknown>
    : undefined;
  if (!message) return [];

  const timestamp = optionalTimestamp(event, message);
  const role = message.role;
  const stopReason =
    typeof message.stopReason === "string"
      ? message.stopReason
      : event.type === "message_end"
        ? "message_end"
        : typeof event.stopReason === "string"
          ? event.stopReason
          : undefined;

  if (role === "assistant") {
    const entries: SessionTailEntry[] = [];
    const text = extractAssistantText(message.content, options);
    if (text) {
      entries.push(withTimestamp({
        kind: "assistant_text",
        text,
        ...(stopReason ? { stopReason } : {}),
      }, timestamp));
    }

    for (const toolCall of contentToolCalls(message.content)) {
      entries.push(withTimestamp({
        kind: "assistant_tool_call",
        ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
        ...(toolCall.name ? { toolName: toolCall.name } : {}),
        ...(toolCall.argumentsText ? { argumentsText: truncateText(toolCall.argumentsText, options.textLimit) } : {}),
        ...(stopReason ? { stopReason } : {}),
      }, timestamp));
    }

    const errorText = assistantErrorText(message, options);
    if (errorText) {
      entries.push(withTimestamp({
        kind: "assistant_error",
        errorText,
        ...(stopReason ? { stopReason } : {}),
      }, timestamp));
    }

    if (stopReason && stopReason !== "message_end") {
      entries.push(withTimestamp({ kind: "stop", stopReason }, timestamp));
    }

    return entries;
  }

  if (role === "toolResult") {
    const text = truncateText(textParts(message.content).join("\n").trim(), options.textLimit);
    if (!text) return [];
    return [
      withTimestamp({
        kind: "tool_result",
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
        text,
      }, timestamp),
    ];
  }

  return [];
}

export function parseSessionJsonlLine(
  line: string,
  options: SessionTailParseOptions = {},
): { entries: SessionTailEntry[]; malformed: boolean } {
  if (!line.trim()) return { entries: [], malformed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { entries: [], malformed: true };
  }

  if (!parsed || typeof parsed !== "object") return { entries: [], malformed: false };
  const event = parsed as Record<string, unknown>;
  const timestamp = optionalTimestamp(event);

  if (event.type === "session" && typeof event.id === "string") {
    return {
      entries: [withTimestamp({ kind: "session", sessionId: event.id }, timestamp)],
      malformed: false,
    };
  }

  if (event.type === "stop" && typeof event.stopReason === "string") {
    return {
      entries: [withTimestamp({ kind: "stop", stopReason: event.stopReason }, timestamp)],
      malformed: false,
    };
  }

  return { entries: parseMessageEvent(event, options), malformed: false };
}

export function readSessionTail(filePath: string, options: SessionTailReadOptions = {}): SessionTailReadResult {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES));
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  const stats = fs.statSync(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const length = stats.size - start;
  const buffer = Buffer.alloc(length);

  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  let content = buffer.toString("utf-8");
  const truncatedStart = start > 0;
  if (truncatedStart) {
    const firstNewline = content.indexOf("\n");
    content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
  }

  const availableLines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const truncatedLineCount = Math.max(0, availableLines.length - maxLines);
  const lines = truncatedLineCount > 0 ? availableLines.slice(-maxLines) : availableLines;

  const entries: SessionTailEntry[] = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    const parsed = parseSessionJsonlLine(line, options);
    if (parsed.malformed) malformedLineCount += 1;
    entries.push(...parsed.entries);
  }

  return { entries, malformedLineCount, bytesRead: length, truncatedStart, truncatedLineCount };
}

function entryPrefix(timestamp: string | undefined): string {
  return timestamp ? `[${timestamp}] ` : "";
}

function isToolUseStopReason(stopReason: string | undefined): boolean {
  return stopReason?.replace(/[^a-z0-9]/gi, "").toLowerCase() === "tooluse";
}

function isFinalAssistantTextCandidate(entries: SessionTailEntry[], index: number): boolean {
  const entry = entries[index];
  if (entry?.kind !== "assistant_text") return false;
  if (isToolUseStopReason(entry.stopReason)) return false;

  return !entries.slice(index + 1).some((later) =>
    later.kind === "assistant_tool_call" ||
    later.kind === "tool_result" ||
    (later.kind === "stop" && isToolUseStopReason(later.stopReason))
  );
}

export function formatSessionTail(entries: SessionTailEntry[], options: SessionTailFormatOptions = {}): string {
  const finalEligible = options.runStatus === "completed" || options.runStatus === "failed";
  const finalAssistantIndex = finalEligible
    ? entries.map((_, index) => isFinalAssistantTextCandidate(entries, index) ? index : -1).filter((index) => index >= 0).pop()
    : undefined;

  return entries.map((entry, index) => {
    const prefix = entryPrefix(entry.timestamp);
    if (entry.kind === "session") return `${prefix}session ${entry.sessionId}`;
    if (entry.kind === "assistant_text") {
      const label = index === finalAssistantIndex ? "assistant final" : "assistant";
      return `${prefix}${label}: ${entry.text}`;
    }
    if (entry.kind === "assistant_tool_call") {
      const name = entry.toolName ?? "tool";
      const id = entry.toolCallId ? ` ${entry.toolCallId}` : "";
      const args = entry.argumentsText ? `: ${entry.argumentsText}` : "";
      return `${prefix}assistant tool call ${name}${id}${args}`;
    }
    if (entry.kind === "assistant_error") {
      return `${prefix}assistant error: ${entry.errorText}`;
    }
    if (entry.kind === "tool_result") {
      const name = entry.toolName ?? "tool";
      const id = entry.toolCallId ? ` ${entry.toolCallId}` : "";
      return `${prefix}tool result ${name}${id}: ${entry.text}`;
    }
    return `${prefix}stop: ${entry.stopReason}`;
  }).join("\n");
}
