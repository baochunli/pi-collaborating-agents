import * as fs from "node:fs";

export type SessionTailEntry =
  | { kind: "session"; sessionId: string; timestamp?: string }
  | {
      kind: "assistant";
      text: string;
      final: boolean;
      stopReason?: string;
      timestamp?: string;
    }
  | {
      kind: "tool-use";
      name: string;
      toolCallId?: string;
      args?: unknown;
      compactArgs?: string;
      paths?: string[];
      timestamp?: string;
    }
  | {
      kind: "tool-result";
      name?: string;
      toolCallId?: string;
      summary: string;
      isError?: boolean;
      timestamp?: string;
    }
  | { kind: "stop"; stopReason: string; timestamp?: string };

export interface ParseSessionJsonlLineResult {
  entries: SessionTailEntry[];
  malformed: boolean;
}

export interface ReadSessionTailOptions {
  limit?: number;
  maxBytes?: number;
}

export interface ReadSessionTailResult {
  entries: SessionTailEntry[];
  malformedLineCount: number;
  bytesRead: number;
  truncatedStart: boolean;
}

export interface FormatSessionTailOptions {
  raw?: boolean;
  textLimit?: number;
}

const DEFAULT_TAIL_LIMIT = 30;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TEXT_LIMIT = 120;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getTimestamp(event: JsonRecord, message?: JsonRecord): string | undefined {
  const value = event.timestamp ?? event.createdAt ?? message?.timestamp ?? message?.createdAt;
  return typeof value === "string" ? value : undefined;
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : undefined;
    if (type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.join("\n").trim();
}

function extractToolText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") parts.push(item.text);
    else if (typeof item.content === "string") parts.push(item.content);
  }
  return parts.join("\n").trim();
}

function getToolName(part: JsonRecord): string | undefined {
  const candidates = [part.name, part.toolName, part.tool_name, part.functionName, part.function_name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  if (isRecord(part.function) && typeof part.function.name === "string") return part.function.name;
  return undefined;
}

function getToolCallId(part: JsonRecord): string | undefined {
  const candidates = [part.id, part.toolCallId, part.tool_call_id, part.callId, part.call_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function getToolArgs(part: JsonRecord): unknown {
  if ("arguments" in part) return part.arguments;
  if ("args" in part) return part.args;
  if ("input" in part) return part.input;
  if (isRecord(part.function) && "arguments" in part.function) return part.function.arguments;
  return undefined;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeArgs(args: unknown): unknown {
  if (typeof args === "string") return parseJsonString(args);
  return args;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/[/.]/.test(value) && !value.includes("\n") && value.length < 300) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
    return out;
  }
  if (!isRecord(value)) return out;

  for (const [key, nested] of Object.entries(value)) {
    if (/path|file/i.test(key) && typeof nested === "string") out.push(nested);
    else collectPaths(nested, out);
  }
  return out;
}

function compactArgs(args: unknown): string | undefined {
  const normalized = normalizeArgs(args);
  if (normalized === undefined) return undefined;
  if (!isRecord(normalized)) return compactValue(normalized);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(normalized)) {
    parts.push(`${key}=${compactValue(value)}`);
  }
  return parts.join(" ");
}

function isToolUseContent(part: JsonRecord): boolean {
  const type = typeof part.type === "string" ? part.type : "";
  return ["toolCall", "toolUse", "tool_use", "tool-call", "function_call"].includes(type);
}

function parseMessageEvent(event: JsonRecord): SessionTailEntry[] {
  const messageValue = event.message ?? event.delta ?? event.data;
  if (!isRecord(messageValue)) return [];

  const message = messageValue;
  const role = typeof message.role === "string" ? message.role : undefined;
  const timestamp = getTimestamp(event, message);
  const stopReasonValue = message.stopReason ?? message.stop_reason ?? event.stopReason ?? event.stop_reason;
  const stopReason = typeof stopReasonValue === "string" ? stopReasonValue : undefined;
  const entries: SessionTailEntry[] = [];

  if (role === "assistant") {
    const text = extractAssistantText(message.content);
    if (text) {
      entries.push({
        kind: "assistant",
        text,
        final: stopReason !== "toolUse" && stopReason !== "tool_use",
        stopReason,
        timestamp,
      });
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!isRecord(part) || !isToolUseContent(part)) continue;
        const name = getToolName(part);
        if (!name) continue;
        const args = normalizeArgs(getToolArgs(part));
        const paths = [...new Set(collectPaths(args))];
        entries.push({
          kind: "tool-use",
          name,
          toolCallId: getToolCallId(part),
          args,
          compactArgs: compactArgs(args),
          paths: paths.length > 0 ? paths : undefined,
          timestamp,
        });
      }
    }

    if (!text && stopReason) entries.push({ kind: "stop", stopReason, timestamp });
    return entries;
  }

  if (role === "toolResult" || role === "tool" || role === "tool_result") {
    const summary = extractToolText(message.content) || extractToolText(message.result) || "(empty result)";
    entries.push({
      kind: "tool-result",
      name: typeof message.toolName === "string" ? message.toolName : typeof message.name === "string" ? message.name : undefined,
      toolCallId: getToolCallId(message),
      summary,
      isError: typeof message.isError === "boolean" ? message.isError : undefined,
      timestamp,
    });
  }

  return entries;
}

function parseDirectToolEvent(event: JsonRecord): SessionTailEntry[] {
  const timestamp = getTimestamp(event);
  const type = typeof event.type === "string" ? event.type : "";

  if (["tool_call", "toolUse", "tool_use"].includes(type)) {
    const name = getToolName(event);
    if (!name) return [];
    const args = normalizeArgs(getToolArgs(event));
    const paths = [...new Set(collectPaths(args))];
    return [
      {
        kind: "tool-use",
        name,
        toolCallId: getToolCallId(event),
        args,
        compactArgs: compactArgs(args),
        paths: paths.length > 0 ? paths : undefined,
        timestamp,
      },
    ];
  }

  if (["tool_result", "toolResult"].includes(type)) {
    const summary = extractToolText(event.content) || extractToolText(event.result) || "(empty result)";
    return [
      {
        kind: "tool-result",
        name: getToolName(event),
        toolCallId: getToolCallId(event),
        summary,
        isError: typeof event.isError === "boolean" ? event.isError : undefined,
        timestamp,
      },
    ];
  }

  return [];
}

export function parseSessionJsonlLine(line: string): ParseSessionJsonlLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { entries: [], malformed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { entries: [], malformed: true };
  }

  if (!isRecord(parsed)) return { entries: [], malformed: true };

  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  const timestamp = getTimestamp(parsed);

  if (type === "session") {
    const id = parsed.id ?? parsed.sessionId ?? parsed.session_id;
    if (typeof id === "string") {
      return { entries: [{ kind: "session", sessionId: id, timestamp }], malformed: false };
    }
  }

  if (type === "message" || type === "message_end") {
    return { entries: parseMessageEvent(parsed), malformed: false };
  }

  const directToolEntries = parseDirectToolEvent(parsed);
  if (directToolEntries.length > 0) return { entries: directToolEntries, malformed: false };

  const stopReasonValue = parsed.stopReason ?? parsed.stop_reason;
  if (typeof stopReasonValue === "string") {
    return { entries: [{ kind: "stop", stopReason: stopReasonValue, timestamp }], malformed: false };
  }

  return { entries: [], malformed: false };
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_TAIL_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) return DEFAULT_MAX_BYTES;
  return Math.max(1, Math.floor(maxBytes));
}

export function readSessionTail(sessionFile: string, options: ReadSessionTailOptions = {}): ReadSessionTailResult {
  const limit = normalizeLimit(options.limit);
  const maxBytes = normalizeMaxBytes(options.maxBytes);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(sessionFile);
  } catch {
    return { entries: [], malformedLineCount: 0, bytesRead: 0, truncatedStart: false };
  }

  const bytesRead = Math.min(stats.size, maxBytes);
  const truncatedStart = stats.size > bytesRead;
  const buffer = Buffer.alloc(bytesRead);

  try {
    const fd = fs.openSync(sessionFile, "r");
    try {
      fs.readSync(fd, buffer, 0, bytesRead, stats.size - bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { entries: [], malformedLineCount: 0, bytesRead: 0, truncatedStart: false };
  }

  let text = buffer.toString("utf-8");
  if (truncatedStart) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }

  const entries: SessionTailEntry[] = [];
  let malformedLineCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSessionJsonlLine(line);
    if (parsed.malformed) malformedLineCount += 1;
    entries.push(...parsed.entries);
  }

  return {
    entries: entries.slice(-limit),
    malformedLineCount,
    bytesRead,
    truncatedStart,
  };
}

function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function truncateText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function formatSessionTail(entries: SessionTailEntry[], options: FormatSessionTailOptions = {}): string {
  if (options.raw) return JSON.stringify(entries, null, 2);
  const textLimit = Math.max(16, Math.floor(options.textLimit ?? DEFAULT_TEXT_LIMIT));

  return entries
    .map((entry) => {
      const time = formatTime(entry.timestamp);
      if (entry.kind === "session") return `${time} session ${entry.sessionId}`;
      if (entry.kind === "assistant") {
        const final = entry.final ? " final" : "";
        const stop = entry.stopReason ? ` (${entry.stopReason})` : "";
        return `${time} assistant${final}${stop}: ${truncateText(entry.text, textLimit)}`;
      }
      if (entry.kind === "tool-use") {
        const args = entry.compactArgs ? ` ${truncateText(entry.compactArgs, textLimit)}` : "";
        return `${time} tool ${entry.name}${args}`;
      }
      if (entry.kind === "tool-result") {
        const name = entry.name ? ` ${entry.name}` : "";
        const error = entry.isError ? " error" : "";
        return `${time} toolResult${name}${error}: ${truncateText(entry.summary, textLimit)}`;
      }
      return `${time} stop ${entry.stopReason}`;
    })
    .join("\n");
}
