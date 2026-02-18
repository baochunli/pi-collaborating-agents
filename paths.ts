import { homedir } from "node:os";
import { join } from "node:path";
import type { Dirs } from "./types.js";

export function resolveDirs(): Dirs {
  const base = process.env.COLLABORATING_AGENTS_DIR || join(homedir(), ".pi", "agent", "collaborating-agents");
  return {
    base,
    registry: join(base, "registry"),
    inbox: join(base, "inbox"),
    messageLog: join(base, "messages.jsonl"),
  };
}
