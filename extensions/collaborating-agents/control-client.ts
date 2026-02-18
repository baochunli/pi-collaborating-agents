import * as net from "node:net";
import { join } from "node:path";
import type { RemoteTurnResult } from "./types.js";

interface RpcResponse {
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  id?: string;
}

interface RpcEvent {
  type: "event";
  event: string;
  data?: unknown;
  subscriptionId?: string;
}

interface RpcSendCommand {
  type: "send";
  message: string;
  mode?: "steer" | "follow_up";
  id?: string;
}

interface RpcSubscribeCommand {
  type: "subscribe";
  event: "turn_end";
  id?: string;
}

function socketPathFor(sessionId: string, socketDir: string): string {
  return join(socketDir, `${sessionId}.sock`);
}

export async function isSessionReachable(
  sessionId: string,
  socketDir: string,
  timeoutMs: number = 500,
): Promise<boolean> {
  const socketPath = socketPathFor(sessionId, socketDir);

  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timeout = setTimeout(() => {
      socket.destroy();
      done(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      done(true);
    });

    socket.once("error", () => {
      clearTimeout(timeout);
      done(false);
    });
  });
}

export async function sendPromptAndWaitTurnEnd(
  sessionId: string,
  message: string,
  socketDir: string,
  waitMs: number,
): Promise<RemoteTurnResult> {
  const socketPath = socketPathFor(sessionId, socketDir);

  return await new Promise<RemoteTurnResult>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");

    const sendId = `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const sendCmd: RpcSendCommand = { type: "send", message, mode: "steer", id: sendId };
    const subCmd: RpcSubscribeCommand = { type: "subscribe", event: "turn_end", id: subId };

    let buffer = "";
    let sendAcked = false;
    let pendingTurnEndData: { message?: { content?: string }; turnIndex?: number } | null = null;
    let settled = false;

    const done = (err?: Error, result?: RemoteTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(result ?? { assistantText: "" });
    };

    const finishFromTurnEnd = (data: { message?: { content?: string }; turnIndex?: number }) => {
      done(undefined, {
        assistantText: data.message?.content || "",
        turnIndex: data.turnIndex,
      });
    };

    const timeout = setTimeout(() => {
      done(new Error("Timed out waiting for remote turn completion"));
    }, waitMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(subCmd)}\n`);
      socket.write(`${JSON.stringify(sendCmd)}\n`);
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;

        let parsed: RpcResponse | RpcEvent | null = null;
        try {
          parsed = JSON.parse(line) as RpcResponse | RpcEvent;
        } catch {
          continue;
        }

        if (parsed.type === "response") {
          if (parsed.command === "send" && parsed.id === sendId) {
            if (!parsed.success) {
              done(new Error(parsed.error || "Remote session rejected message"));
              return;
            }
            sendAcked = true;
            if (pendingTurnEndData) {
              finishFromTurnEnd(pendingTurnEndData);
              return;
            }
          }
          continue;
        }

        if (parsed.type === "event" && parsed.event === "turn_end") {
          const data = (parsed.data || {}) as {
            message?: { content?: string };
            turnIndex?: number;
          };

          if (!sendAcked) {
            pendingTurnEndData = data;
            continue;
          }

          finishFromTurnEnd(data);
          return;
        }
      }
    });

    socket.on("error", (err) => {
      done(err instanceof Error ? err : new Error(String(err)));
    });

    socket.on("close", () => {
      if (!settled) done(new Error("Remote control socket closed before response"));
    });
  });
}
