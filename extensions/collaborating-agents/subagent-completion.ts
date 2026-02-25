import type { SpawnResult } from "./subagent-spawn.js";

export interface SubagentCompletionToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface SubagentCompletionMessagePayload {
  customType: "collab_focus_status";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

export interface PendingSubagentCompletionUpdate {
  payload: SubagentCompletionMessagePayload;
  targetSessionFile?: string;
}

function formatAgentDisplayName(agentName: string): string {
  const callsignMatch = agentName.match(/-([A-Z][a-z]+[A-Z][A-Za-z]+)$/);
  if (callsignMatch?.[1]) return callsignMatch[1];
  return agentName;
}

export function collectSpawnResults(details: Record<string, unknown>): SpawnResult[] {
  const singleResult =
    typeof details.result === "object" && details.result
      ? (details.result as SpawnResult)
      : undefined;

  const parallelResults = Array.isArray(details.results)
    ? (details.results as SpawnResult[])
    : undefined;

  if (parallelResults && parallelResults.length > 0) return parallelResults;
  return singleResult ? [singleResult] : [];
}

export function buildSubagentCompletionMessagePayload(
  result: SubagentCompletionToolResult,
): SubagentCompletionMessagePayload {
  const spawnResults = collectSpawnResults(result.details);

  let intro: string;
  let body: string;

  if (spawnResults.length > 1) {
    const successCount = spawnResults.filter((r) => r.exitCode === 0).length;
    intro = result.isError
      ? `Received final results from ${spawnResults.length} subagents (${successCount} succeeded, ${spawnResults.length - successCount} failed).`
      : `Received final results from ${spawnResults.length} subagents.`;

    const sections = spawnResults.map((r, index) => {
      const displayName = formatAgentDisplayName(r.name);
      const status = r.exitCode === 0 ? "ok" : "failed";
      const output = (r.output || "(no output)").trim() || "(no output)";
      return [`### ${index + 1}. ${displayName} (${status})`, "", output].join("\n");
    });

    body = sections.join("\n\n");
  } else {
    const singleResult = spawnResults[0];
    const runtimeLabel = singleResult?.name ? formatAgentDisplayName(singleResult.name) : "the subagent";
    intro = result.isError
      ? `Received an error from ${runtimeLabel}.`
      : `Received final results from ${runtimeLabel}.`;

    body = (singleResult?.output || result.content[0]?.text || "(no output)").trim() || "(no output)";
  }

  return {
    customType: "collab_focus_status",
    content: `${intro}\n\n${body}`,
    display: true,
    details: result.details,
  };
}

export function shouldDeferSubagentCompletionUpdate(args: {
  targetSessionFile?: string;
  activeSessionFile?: string;
}): boolean {
  if (!args.targetSessionFile) return false;
  if (!args.activeSessionFile) return true;
  return args.targetSessionFile !== args.activeSessionFile;
}

export function partitionPendingSubagentCompletionUpdates(
  pending: PendingSubagentCompletionUpdate[],
  currentSessionFile: string | undefined,
): { deliverable: PendingSubagentCompletionUpdate[]; deferred: PendingSubagentCompletionUpdate[] } {
  const deliverable: PendingSubagentCompletionUpdate[] = [];
  const deferred: PendingSubagentCompletionUpdate[] = [];

  for (const item of pending) {
    if (
      shouldDeferSubagentCompletionUpdate({
        targetSessionFile: item.targetSessionFile,
        activeSessionFile: currentSessionFile,
      })
    ) {
      deferred.push(item);
      continue;
    }

    deliverable.push(item);
  }

  return { deliverable, deferred };
}
