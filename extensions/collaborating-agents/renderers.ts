import type { ExtensionAPI, MessageRenderer } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

function readRawText(message: Parameters<MessageRenderer>[0]): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

function resolveLabel(message: Parameters<MessageRenderer>[0]): string | null {
  const details = (message as { details?: unknown }).details;
  const detailsObj = details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;

  if (message.customType === "collab_inbox_message") {
    return null;
  }

  if (message.customType === "collab_remote_reply") {
    const agent = typeof detailsObj?.agent === "string" ? detailsObj.agent : undefined;
    return agent ? `Reply from ${agent}` : "Remote Agent Reply";
  }

  if (message.customType === "collab_focus_status") {
    const mode = typeof detailsObj?.mode === "string" ? detailsObj.mode : undefined;
    if (mode === "subagent") return null;
    if (mode === "subagent_launch") return "Subagent Launch";
    return "Session & Subagent Status";
  }

  return message.customType;
}

const defaultRenderer: MessageRenderer = (message, { expanded }, theme) => {
  const raw = readRawText(message);

  const details = (message as { details?: unknown }).details;
  const detailsObj = details && typeof details === "object" ? (details as Record<string, unknown>) : undefined;
  const mode = typeof detailsObj?.mode === "string" ? detailsObj.mode : undefined;
  const keepFullByDefault =
    message.customType === "collab_focus_status" &&
    (mode === "subagent" || mode === "subagent_launch");

  const text = expanded || keepFullByDefault ? raw : raw.split("\n").slice(0, 8).join("\n");
  const label = resolveLabel(message);

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  if (label) {
    box.addChild(new Text(theme.fg("customMessageLabel", `[${label}]`), 0, 0));
    box.addChild(new Spacer(1));
  }
  box.addChild(new Markdown(text || "(no content)", 0, 0, getMarkdownTheme()));
  return box;
};

export function registerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("collab_inbox_message", defaultRenderer);
  pi.registerMessageRenderer("collab_remote_reply", defaultRenderer);
  pi.registerMessageRenderer("collab_focus_status", defaultRenderer);
}
