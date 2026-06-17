import * as fs from "node:fs";

export type SessionTailEntry =
  | SessionTailSessionEntry
  | SessionTailAssistantEntry
  | SessionTailToolUseEntry
  | SessionTailToolResultEntry
  | SessionTailStopEntry;

export interface SessionTailSessionEntry {
  kind: "session";
  sessionId: string;
  timestamp?: string;
}

export interface SessionTailAssistantEntry {
  kind: "assistant";
  text: string;
  final: boolean;
  stopReason?: string;
  timestamp?: string;
}

export interface SessionTailToolUseEntry {
  kind: "tool-use";
  name: string;
  toolCallId?: string;
  args?: unknown;
  compactArgs?: string;
  paths?: string[];
  timestamp?: string;
}

export interface SessionTailToolResultEntry {
  kind: "tool-result";
  name?: string;
  toolCallId?: string;
  summary: string;
  isError?: boolean;
  timestamp?: string;
}

export interface SessionTailStopEntry {
  kind: "stop";
  stopReason: string;
  timestamp?: string;
}

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
  limit?: number;
  textLimit?: number;
  argLimit?: number;
  raw?: boolean;
  structured?: boolean;
}

const DEFAULT_ENTRY_LIMIT = 40;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TEXT_LIMIT = 180;
const DEFAULT_ARG_LIMIT = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEventType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[-_]/g, "").toLowerCase() : "";
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.max(0, Math.floor(value));
}

function timestampFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      const millis = value < 10_000_000_000 ? value * 1000 : value;
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

function addTimestamp<T extends SessionTailEntry>(entry: T, timestamp?: string): T {
  if (timestamp) return { ...entry, timestamp };
  return entry;
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function getStopReason(...records: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = getString(record, ["stopReason", "stop_reason", "finishReason", "finish_reason"]);
    if (value) return value;
  }
  return undefined;
}

function isToolUseStopReason(stopReason: string | undefined): boolean {
  return stopReason?.replace(/[-_]/g, "").toLowerCase() === "tooluse";
}

function stableStringify(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value) ?? String(value);

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    ordered[key] = value[key];
  }
  return JSON.stringify(ordered) ?? String(value);
}

function truncate(value: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1)}…`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    if (/^[^\s"']+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (typeof value === "undefined") return "undefined";
  return stableStringify(value);
}

function normalizeArgs(rawArgs: unknown): unknown {
  if (typeof rawArgs !== "string") return rawArgs;
  const trimmed = rawArgs.trim();
  if (!trimmed) return rawArgs;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return rawArgs;
  }
}

function compactArgs(args: unknown, maxChars: number = DEFAULT_ARG_LIMIT): string | undefined {
  if (typeof args === "undefined") return undefined;

  if (!isRecord(args)) {
    const formatted = oneLine(formatArgValue(args));
    return formatted ? truncate(formatted, maxChars) : undefined;
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "undefined") continue;
    parts.push(`${key}=${formatArgValue(value)}`);
  }

  const compact = oneLine(parts.join(" "));
  return compact ? truncate(compact, maxChars) : undefined;
}

function collectPathValues(value: unknown, keyHint: string | undefined, out: string[]): void {
  if (typeof value === "string") {
    if (keyHint && /(?:^|_|-)(path|paths|file|files|filename|filenames|filepath|filepaths|dir|directory|cwd)(?:$|_|-)/i.test(keyHint)) {
      out.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, keyHint, out);
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    collectPathValues(nested, key, out);
  }
}

function extractPaths(args: unknown): string[] | undefined {
  const paths: string[] = [];
  collectPathValues(args, undefined, paths);

  const unique = [...new Set(paths.map((value) => value.trim()).filter(Boolean))];
  return unique.length > 0 ? unique : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (isRecord(item)) {
        if (typeof item.text === "string") parts.push(item.text);
        else if (typeof item.content === "string") parts.push(item.content);
      }
    }
    return parts.join("\n").trim();
  }
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
    return stableStringify(content);
  }
  if (typeof content === "undefined" || content === null) return "";
  return String(content).trim();
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      if (typeof item.text === "string" && (!item.type || item.type === "text")) parts.push(item.text);
    }
    return parts.join("\n").trim();
  }

  if (isRecord(content) && typeof content.text === "string" && (!content.type || content.type === "text")) {
    return content.text.trim();
  }

  return "";
}

function parseToolUseBlock(block: Record<string, unknown>, timestamp?: string): SessionTailToolUseEntry | undefined {
  const type = normalizeEventType(block.type);
  if (type !== "toolcall" && type !== "tooluse" && type !== "functioncall") return undefined;

  const functionRecord = isRecord(block.function) ? block.function : undefined;
  const name = getString(block, ["name", "toolName"]) ?? (functionRecord ? getString(functionRecord, ["name"]) : undefined);
  if (!name) return undefined;

  const rawArgs =
    block.arguments ??
    block.input ??
    block.args ??
    block.parameters ??
    (functionRecord ? functionRecord.arguments : undefined);
  const args = normalizeArgs(rawArgs);
  const compact = compactArgs(args);
  const paths = extractPaths(args);
  const toolCallId = getString(block, ["id", "toolCallId", "toolUseId"]);

  const entry: SessionTailToolUseEntry = { kind: "tool-use", name };
  if (toolCallId) entry.toolCallId = toolCallId;
  if (typeof args !== "undefined") entry.args = args;
  if (compact) entry.compactArgs = compact;
  if (paths) entry.paths = paths;
  return addTimestamp(entry, timestamp);
}

function parseToolResultBlock(block: Record<string, unknown>, timestamp?: string): SessionTailToolResultEntry | undefined {
  const type = normalizeEventType(block.type);
  if (type !== "toolresult") return undefined;

  const summary = contentToText(block.content ?? block.result ?? block.output);
  const entry: SessionTailToolResultEntry = {
    kind: "tool-result",
    summary,
  };

  const name = getString(block, ["name", "toolName"]);
  const toolCallId = getString(block, ["id", "toolCallId", "toolUseId"]);
  if (name) entry.name = name;
  if (toolCallId) entry.toolCallId = toolCallId;
  if (typeof block.isError === "boolean") entry.isError = block.isError;

  return addTimestamp(entry, timestamp);
}

function parseAssistantMessage(message: Record<string, unknown>, timestamp?: string, event?: Record<string, unknown>): SessionTailEntry[] {
  const entries: SessionTailEntry[] = [];
  const content = message.content;
  const stopReason = getStopReason(message, event);
  const text = extractAssistantText(content);

  if (text) {
    const entry: SessionTailAssistantEntry = {
      kind: "assistant",
      text,
      final: Boolean(stopReason && !isToolUseStopReason(stopReason)),
    };
    if (stopReason) entry.stopReason = stopReason;
    entries.push(addTimestamp(entry, timestamp));
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const toolUse = parseToolUseBlock(block, timestamp);
      if (toolUse) {
        entries.push(toolUse);
        continue;
      }
      const toolResult = parseToolResultBlock(block, timestamp);
      if (toolResult) entries.push(toolResult);
    }
  }

  if (entries.length === 0 && stopReason) {
    entries.push(addTimestamp({ kind: "stop", stopReason }, timestamp));
  }

  return entries;
}

function parseToolResultMessage(message: Record<string, unknown>, timestamp?: string, event?: Record<string, unknown>): SessionTailEntry[] {
  const summary = contentToText(message.content ?? message.result ?? message.output ?? event?.content ?? event?.result);
  const entry: SessionTailToolResultEntry = {
    kind: "tool-result",
    summary,
  };

  const name = getString(message, ["toolName", "name"]) ?? (event ? getString(event, ["toolName", "name"]) : undefined);
  const toolCallId =
    getString(message, ["toolCallId", "toolUseId", "id"]) ??
    (event ? getString(event, ["toolCallId", "toolUseId"]) : undefined);
  const isError = typeof message.isError === "boolean" ? message.isError : event?.isError;

  if (name) entry.name = name;
  if (toolCallId) entry.toolCallId = toolCallId;
  if (typeof isError === "boolean") entry.isError = isError;

  return [addTimestamp(entry, timestamp)];
}

function parseMessageEvent(event: Record<string, unknown>): SessionTailEntry[] {
  const message = isRecord(event.message) ? event.message : event;
  const role = getString(message, ["role"]) ?? getString(event, ["role"]);
  const timestamp = timestampFrom(event.timestamp, event.createdAt, message.timestamp, message.createdAt);

  if (role === "assistant") return parseAssistantMessage(message, timestamp, event);

  const normalizedRole = normalizeEventType(role);
  if (normalizedRole === "toolresult" || normalizedRole === "tool") {
    return parseToolResultMessage(message, timestamp, event);
  }

  return [];
}

export function parseSessionJsonlLine(line: string): ParseSessionJsonlLineResult {
  const trimmed = line.trim();
  if (!trimmed) return { entries: [], malformed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { entries: [], malformed: true };
  }

  if (!isRecord(parsed)) return { entries: [], malformed: false };

  const eventType = normalizeEventType(parsed.type);
  const timestamp = timestampFrom(parsed.timestamp, parsed.createdAt);

  if (eventType === "session") {
    const sessionId = getString(parsed, ["id", "sessionId", "session_id"]);
    if (!sessionId) return { entries: [], malformed: false };
    return {
      entries: [addTimestamp({ kind: "session", sessionId }, timestamp)],
      malformed: false,
    };
  }

  if (eventType === "toolcall" || eventType === "tooluse" || eventType === "functioncall") {
    const entry = parseToolUseBlock(parsed, timestamp);
    return { entries: entry ? [entry] : [], malformed: false };
  }

  if (eventType === "toolresult") {
    const entry = parseToolResultBlock(parsed, timestamp);
    if (entry) return { entries: [entry], malformed: false };
    return { entries: parseMessageEvent(parsed), malformed: false };
  }

  if (eventType === "message" || eventType === "messageend") {
    return { entries: parseMessageEvent(parsed), malformed: false };
  }

  const stopReason = getStopReason(parsed);
  if (stopReason) return { entries: [addTimestamp({ kind: "stop", stopReason }, timestamp)], malformed: false };

  if (getString(parsed, ["role"])) {
    return { entries: parseMessageEvent(parsed), malformed: false };
  }

  return { entries: [], malformed: false };
}

export function readSessionTail(sessionFile: string, options: ReadSessionTailOptions = {}): ReadSessionTailResult {
  const limit = normalizeLimit(options.limit, DEFAULT_ENTRY_LIMIT);
  const maxBytes = normalizeMaxBytes(options.maxBytes);

  let size = 0;
  try {
    size = fs.statSync(sessionFile).size;
  } catch {
    return { entries: [], malformedLineCount: 0, bytesRead: 0, truncatedStart: false };
  }

  const bytesRead = Math.min(size, maxBytes);
  const start = Math.max(0, size - bytesRead);
  const truncatedStart = start > 0;
  let content = "";

  if (bytesRead > 0) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(sessionFile, "r");
      const buffer = Buffer.alloc(bytesRead);
      fs.readSync(fd, buffer, 0, bytesRead, start);
      content = buffer.toString("utf-8");
    } catch {
      return { entries: [], malformedLineCount: 0, bytesRead: 0, truncatedStart: false };
    } finally {
      if (typeof fd === "number") fs.closeSync(fd);
    }
  }

  if (truncatedStart) {
    const firstNewline = content.indexOf("\n");
    content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
  }

  const entries: SessionTailEntry[] = [];
  let malformedLineCount = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSessionJsonlLine(line);
    if (parsed.malformed) malformedLineCount += 1;
    entries.push(...parsed.entries);
  }

  return {
    entries: limit === 0 ? [] : entries.slice(-limit),
    malformedLineCount,
    bytesRead,
    truncatedStart,
  };
}

function timeLabel(timestamp: string | undefined): string {
  if (!timestamp) return "--:--";
  const isoMatch = timestamp.match(/T(\d{2}):(\d{2})/);
  if (isoMatch?.[1] && isoMatch[2]) return `${isoMatch[1]}:${isoMatch[2]}`;

  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) {
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  return "--:--";
}

function formatEntry(entry: SessionTailEntry, options: Required<Pick<FormatSessionTailOptions, "textLimit" | "argLimit">>): string {
  const prefix = timeLabel(entry.timestamp);

  if (entry.kind === "session") return `${prefix} session ${entry.sessionId}`;

  if (entry.kind === "assistant") {
    const label = entry.final ? "assistant final" : "assistant";
    const stop = entry.stopReason ? ` (${entry.stopReason})` : "";
    return `${prefix} ${label}${stop}: ${truncate(oneLine(entry.text), options.textLimit)}`;
  }

  if (entry.kind === "tool-use") {
    const args = entry.compactArgs
      ? truncate(oneLine(entry.compactArgs), options.argLimit)
      : entry.paths && entry.paths.length > 0
        ? truncate(entry.paths.join(", "), options.argLimit)
        : "";
    return `${prefix} tool ${entry.name}${args ? ` ${args}` : ""}`;
  }

  if (entry.kind === "tool-result") {
    const name = entry.name ? ` ${entry.name}` : "";
    const status = entry.isError ? " error" : "";
    const summary = truncate(oneLine(entry.summary), options.textLimit);
    return `${prefix} toolResult${name}${status}: ${summary}`;
  }

  return `${prefix} stop ${entry.stopReason}`;
}

export function formatSessionTail(
  input: SessionTailEntry[] | ReadSessionTailResult,
  options: FormatSessionTailOptions = {},
): string {
  const sourceEntries = Array.isArray(input) ? input : input.entries;
  const limit = typeof options.limit === "number" ? normalizeLimit(options.limit, sourceEntries.length) : sourceEntries.length;
  const entries = limit === 0 ? [] : sourceEntries.slice(-limit);

  if (options.raw || options.structured) return JSON.stringify(entries, null, 2);
  if (entries.length === 0) return "(no transcript entries)";

  return entries
    .map((entry) =>
      formatEntry(entry, {
        textLimit: normalizeLimit(options.textLimit, DEFAULT_TEXT_LIMIT) || DEFAULT_TEXT_LIMIT,
        argLimit: normalizeLimit(options.argLimit, DEFAULT_ARG_LIMIT) || DEFAULT_ARG_LIMIT,
      }),
    )
    .join("\n");
}
