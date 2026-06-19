import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

function expectSessionInspectionDocs(content: string): void {
  expect(content).toContain('agent_message({ action: "sessions" })');
  expect(content).toContain('agent_message({ action: "sessions", includeCompleted: false })');
  expect(content).toContain('agent_message({ action: "session", runId:');
  expect(content).toContain('agent_message({ action: "tail", runId:');
  expect(content).toContain("Do not scan `~/.pi/agent/sessions` manually");
  expect(content).toContain("display name");
  expect(content).toContain("canonical name");
  expect(content).toContain("child run id");
  expect(content).toContain("recordId");
  expect(content).toContain("batch id");
  expect(content).toContain("session id prefix");
  expect(content).toContain("`latest`");
  expect(content).toContain("runs/");
  expect(content).toContain("Process-mode session file unavailable until child registration or fallback discovery provides one.");
}

describe("collaborating-agents public docs", () => {
  test("README documents subagent session inspection workflow and validation", () => {
    const readme = readRepoFile("README.md");

    expectSessionInspectionDocs(readme);
    expect(readme).toContain("bun test extensions/collaborating-agents/index.test.ts --test-name-pattern");
    expect(readme).toContain("bun test extensions/collaborating-agents/session-tail.test.ts");
    expect(readme).toContain("npm pack --dry-run");
    expect(readme).toContain("Manual smoke: process mode");
    expect(readme).toContain("Manual smoke: parallel ambiguity");
    expect(readme).toContain("Manual smoke: cmux mode");
  });

  test("bundled skill documents coordinator session inspection workflow", () => {
    const skill = readRepoFile("skills/collaborating-agents-system/SKILL.md");

    expectSessionInspectionDocs(skill);
    expect(skill).toContain("Prefer `bun test` for validation");
    expect(skill).toContain("npm pack --dry-run");
  });
});
