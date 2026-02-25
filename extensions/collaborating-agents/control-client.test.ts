import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { isSessionReachable, sendPromptAndWaitTurnEnd } from "./control-client.ts";

interface RpcLike {
  type?: string;
  command?: string;
  success?: boolean;
  event?: string;
  id?: string;
  data?: unknown;
  error?: string;
}

function createTempSocketDir(prefix: string): string {
  // Unix socket paths are length-limited (~104 chars on macOS); keep test paths short.
  const root = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

async function listenOnSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }
}

function attachJsonLineHandler(socket: net.Socket, onLine: (msg: RpcLike) => void): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string | Buffer) => {
    buffer += chunk.toString();

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;

      try {
        onLine(JSON.parse(line) as RpcLike);
      } catch {
        // ignore malformed input in tests
      }
    }
  });
}

describe("control-client reachability", () => {
  test("isSessionReachable returns true for active socket and false for missing socket", async () => {
    const socketDir = createTempSocketDir("collab-control-reachable");
    const sessionId = "reachable-session";
    const socketPath = path.join(socketDir, `${sessionId}.sock`);

    const server = net.createServer(() => {
      // No protocol handling needed for reachability checks
    });

    try {
      await listenOnSocket(server, socketPath);

      expect(await isSessionReachable(sessionId, socketDir, 250)).toBe(true);
      expect(await isSessionReachable("missing-session", socketDir, 100)).toBe(false);
    } finally {
      await closeServer(server, socketPath);
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});

describe("control-client turn completion protocol", () => {
  test("sendPromptAndWaitTurnEnd accepts turn_end that arrives before send ack", async () => {
    const socketDir = createTempSocketDir("collab-control-early-turn-end");
    const sessionId = "early-turn-end";
    const socketPath = path.join(socketDir, `${sessionId}.sock`);

    const server = net.createServer((socket) => {
      attachJsonLineHandler(socket, (msg) => {
        if (msg.type === "subscribe" && typeof msg.id === "string") {
          socket.write(
            `${JSON.stringify({ type: "response", command: "subscribe", success: true, id: msg.id })}\n`,
          );
          return;
        }

        if (msg.type === "send" && typeof msg.id === "string") {
          socket.write(
            `${JSON.stringify({
              type: "event",
              event: "turn_end",
              data: { message: { content: "done before ack" }, turnIndex: 7 },
            })}\n`,
          );

          setTimeout(() => {
            socket.write(`${JSON.stringify({ type: "response", command: "send", success: true, id: msg.id })}\n`);
          }, 5);
        }
      });
    });

    try {
      await listenOnSocket(server, socketPath);

      const result = await sendPromptAndWaitTurnEnd(sessionId, "hello", socketDir, 1_000);
      expect(result).toEqual({
        assistantText: "done before ack",
        turnIndex: 7,
      });
    } finally {
      await closeServer(server, socketPath);
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  test("sendPromptAndWaitTurnEnd rejects when remote send command fails", async () => {
    const socketDir = createTempSocketDir("collab-control-send-fail");
    const sessionId = "send-fails";
    const socketPath = path.join(socketDir, `${sessionId}.sock`);

    const server = net.createServer((socket) => {
      attachJsonLineHandler(socket, (msg) => {
        if (msg.type === "send" && typeof msg.id === "string") {
          socket.write(
            `${JSON.stringify({
              type: "response",
              command: "send",
              success: false,
              id: msg.id,
              error: "rejected by test server",
            })}\n`,
          );
        }
      });
    });

    try {
      await listenOnSocket(server, socketPath);

      await expect(sendPromptAndWaitTurnEnd(sessionId, "hello", socketDir, 500)).rejects.toThrow(
        "rejected by test server",
      );
    } finally {
      await closeServer(server, socketPath);
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  test("sendPromptAndWaitTurnEnd times out when turn_end is never received", async () => {
    const socketDir = createTempSocketDir("collab-control-timeout");
    const sessionId = "no-turn-end";
    const socketPath = path.join(socketDir, `${sessionId}.sock`);

    const server = net.createServer((socket) => {
      attachJsonLineHandler(socket, (msg) => {
        if (msg.type === "send" && typeof msg.id === "string") {
          socket.write(`${JSON.stringify({ type: "response", command: "send", success: true, id: msg.id })}\n`);
        }
      });
    });

    try {
      await listenOnSocket(server, socketPath);

      await expect(sendPromptAndWaitTurnEnd(sessionId, "hello", socketDir, 120)).rejects.toThrow(
        "Timed out waiting for remote turn completion",
      );
    } finally {
      await closeServer(server, socketPath);
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
