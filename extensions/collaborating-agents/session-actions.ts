import { formatAgentDisplayName } from "./store.js";
import type { ResolveSubagentRunRecordResult, SubagentRunRecord } from "./types.js";

export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) return "pending";
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}...` : sessionId;
}

export function formatSubagentRunLine(record: SubagentRunRecord): string {
  const displayName = formatAgentDisplayName(record.name);
  const sessionFile = record.sessionFile ?? "session file pending";
  return `- ${displayName} ${record.type} ${record.status} • run ${shortRunId(record.runId)} • session ${shortSessionId(record.sessionId)} • ${sessionFile}`;
}

export function formatSubagentSessions(records: SubagentRunRecord[]): string {
  if (records.length === 0) return "No subagent sessions found.";
  return `Subagent sessions:\n${records.map(formatSubagentRunLine).join("\n")}`;
}

export function formatSubagentSession(record: SubagentRunRecord): string {
  return [
    formatAgentDisplayName(record.name),
    `Status: ${record.status}`,
    `Run ID: ${record.runId}`,
    `Session ID: ${record.sessionId ?? "pending"}`,
    `Session file: ${record.sessionFile ?? "pending"}`,
    `CWD: ${record.cwd}`,
    `Model: ${record.model ?? "unknown"}`,
    `Type: ${record.type}`,
    `Launch mode: ${record.launchMode}`,
    `Started: ${record.startedAt}`,
    record.completedAt ? `Completed: ${record.completedAt}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatSubagentRunResolutionError(result: Exclude<ResolveSubagentRunRecordResult, { ok: true }>): string {
  const candidateLines = result.candidates.length > 0
    ? `\n\nCandidates:\n${result.candidates.map(formatSubagentRunLine).join("\n")}`
    : "";
  return `${result.message}${candidateLines}`;
}
