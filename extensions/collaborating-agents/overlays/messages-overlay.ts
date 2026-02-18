import { existsSync } from "node:fs";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentRegistration, AgentRole, FocusState, MessageLogEvent } from "../types.js";

const AGENTS_TAB = "[agents]";
const RESERVATIONS_TAB = "[reservations]";
const ALL_TAB = "[all]";
const OVERLAY_WIDTH = 132;
const MESSAGE_AREA_HEIGHT = 24;

const DISPLAY_FIRST_WORDS = [
  "Amber",
  "Autumn",
  "Bright",
  "Calm",
  "Clear",
  "Dawn",
  "Deep",
  "Gentle",
  "Golden",
  "Grand",
  "Green",
  "Lively",
  "Mellow",
  "Mighty",
  "Quiet",
  "Rising",
  "Silver",
  "Steady",
  "Sunny",
  "Swift",
  "Warm",
  "Young",
] as const;

const DISPLAY_SECOND_WORDS = [
  "Anchor",
  "Breeze",
  "Brook",
  "Cloud",
  "Field",
  "Forest",
  "Garden",
  "Harbor",
  "Hill",
  "Lake",
  "Maple",
  "Meadow",
  "Moon",
  "Ocean",
  "Pine",
  "River",
  "Sparrow",
  "Stone",
  "Sun",
  "Thunder",
  "Valley",
  "Wave",
  "Willow",
] as const;

interface MessagesOverlayDeps {
  selfName: string;
  selfRole?: AgentRole;
  focus: FocusState;
  loadAgents: () => AgentRegistration[];
  loadSwitchTargets?: () => AgentRegistration[];
  loadReservationAgents: () => AgentRegistration[];
  loadMessages: (limit: number) => MessageLogEvent[];
  sendDirect: (to: string, text: string, urgent?: boolean) => { ok: boolean; error?: string };
  sendBroadcast: (text: string, urgent?: boolean) => { ok: boolean; delivered?: string[]; failed?: string[]; error?: string };
  onFocusLocal: () => void | Promise<void>;
  onFocusRemote: (target: AgentRegistration) => void | Promise<void>;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  done: () => void;
}

interface MentionCompletionState {
  candidates: string[];
  index: number;
}

export class MessagesOverlay implements Component, Focusable {
  readonly width = OVERLAY_WIDTH;
  focused = false;

  private selectedTab: string;
  private inputText = "";
  private scrollPosition = 0;
  private selectedAgentRow = 0;
  private refreshTimer: ReturnType<typeof setInterval>;
  private aliasCache = new Map<string, string>();
  private aliasInUse = new Map<string, string>();
  private mentionCompletion: MentionCompletionState | null = null;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private deps: MessagesOverlayDeps,
  ) {
    this.selectedTab = AGENTS_TAB;

    const agents = this.deps.loadAgents();
    const switchTargets = this.getSwitchTargets(agents);
    const focus = this.deps.focus;
    if (focus.mode === "remote") {
      const idx =
        switchTargets.findIndex((a) =>
          a.sessionId === focus.targetSessionId || a.name === focus.targetAgent,
        );
      this.selectedAgentRow = idx >= 0 ? idx : 0;
    }

    this.refreshTimer = setInterval(() => this.tui.requestRender(), 1000);
    this.refreshTimer.unref?.();
  }

  private getTabs(agents: AgentRegistration[]): string[] {
    const peerNames = agents.map((a) => a.name).filter((name) => name !== this.deps.selfName);
    return [AGENTS_TAB, RESERVATIONS_TAB, this.deps.selfName, ...peerNames, ALL_TAB];
  }

  private getSwitchTargets(agents: AgentRegistration[]): AgentRegistration[] {
    return this.deps.loadSwitchTargets?.() ?? agents;
  }

  private normalizeAgentDisplayName(name: string): string {
    return name.replace(/^worker(?:-agent)?-?/i, "").replace(/^subagent-?/i, "").trim();
  }

  private resolveRole(name: string, agents: AgentRegistration[]): AgentRole | undefined {
    if (name === this.deps.selfName) return this.deps.selfRole;
    return agents.find((agent) => agent.name === name)?.role;
  }

  private displayAgentLabel(name: string, _role: AgentRole | undefined): string {
    return this.displayAgentName(name);
  }

  private hashName(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private displayAgentName(name: string): string {
    const normalized = this.normalizeAgentDisplayName(name);
    const baseName = normalized || name;

    const callsign = baseName.match(/([A-Z][a-z]+[A-Z][A-Za-z]+)$/)?.[1];
    if (callsign) return callsign;

    const cached = this.aliasCache.get(name);
    if (cached) return cached;

    const base = this.hashName(baseName);
    const maxAttempts = DISPLAY_FIRST_WORDS.length * DISPLAY_SECOND_WORDS.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const first = DISPLAY_FIRST_WORDS[(base + attempt) % DISPLAY_FIRST_WORDS.length] ?? "Swift";
      const second =
        DISPLAY_SECOND_WORDS[(Math.floor(base / DISPLAY_FIRST_WORDS.length) + attempt) % DISPLAY_SECOND_WORDS.length] ??
        "River";
      const alias = `${first}${second}`;
      const owner = this.aliasInUse.get(alias);
      if (!owner || owner === name) {
        this.aliasInUse.set(alias, name);
        this.aliasCache.set(name, alias);
        return alias;
      }
    }

    const fallback = `SwiftRiver${base % 100}`;
    this.aliasCache.set(name, fallback);
    return fallback;
  }

  private resolveAgentInputName(input: string, agents: AgentRegistration[]): string | null {
    const normalizedInput = this.normalizeAgentDisplayName(input.trim()).toLowerCase();
    if (!normalizedInput) return null;

    const exactMatch = agents.find((a) => this.normalizeAgentDisplayName(a.name).toLowerCase() === normalizedInput);
    if (exactMatch) return exactMatch.name;

    const exactDisplay = agents.filter(
      (a) => this.displayAgentName(a.name).toLowerCase() === normalizedInput,
    );
    if (exactDisplay.length === 1) return exactDisplay[0]?.name ?? null;

    const compact = normalizedInput.replace(/\s+/g, "");
    const compactDisplay = agents.filter(
      (a) => this.displayAgentName(a.name).toLowerCase().replace(/\s+/g, "") === compact,
    );
    if (compactDisplay.length === 1) return compactDisplay[0]?.name ?? null;

    return null;
  }

  private resetMentionCompletion(): void {
    this.mentionCompletion = null;
  }

  private currentMentionToken(): string | null {
    const match = this.inputText.match(/^@([^\s]*)$/);
    return match ? (match[1] ?? "") : null;
  }

  private getMentionCandidates(agents: AgentRegistration[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const add = (candidate: string): void => {
      const value = candidate.trim();
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(value);
    };

    add("all");

    for (const agent of agents) {
      add(this.displayAgentName(agent.name));
      add(this.normalizeAgentDisplayName(agent.name));
    }

    return out;
  }

  private tryCompleteMention(agents: AgentRegistration[], direction: 1 | -1): boolean {
    const token = this.currentMentionToken();
    if (token === null) {
      this.resetMentionCompletion();
      return false;
    }

    const candidatePool = this.getMentionCandidates(agents);
    if (candidatePool.length === 0) {
      this.resetMentionCompletion();
      return false;
    }

    const lowerToken = token.toLowerCase();
    const active = this.mentionCompletion;
    if (active && active.candidates.length > 0) {
      const current = active.candidates[active.index];
      const currentMatchesInput = current?.toLowerCase() === lowerToken;
      const stillValid = active.candidates.every((candidate) =>
        candidatePool.some((value) => value.toLowerCase() === candidate.toLowerCase()),
      );

      if (currentMatchesInput && stillValid) {
        const nextIndex = (active.index + direction + active.candidates.length) % active.candidates.length;
        active.index = nextIndex;
        this.inputText = `@${active.candidates[nextIndex]}`;
        this.tui.requestRender();
        return true;
      }
    }

    const matches = candidatePool.filter((candidate) => candidate.toLowerCase().startsWith(lowerToken));
    if (matches.length === 0) {
      this.resetMentionCompletion();
      return false;
    }

    const index = direction === 1 ? 0 : matches.length - 1;
    this.mentionCompletion = { candidates: matches, index };
    this.inputText = `@${matches[index]}`;

    if (matches.length === 1) {
      this.inputText += " ";
      this.resetMentionCompletion();
    }

    this.tui.requestRender();
    return true;
  }

  private totalAgentRows(agents: AgentRegistration[]): number {
    return agents.length;
  }

  private clampAgentSelection(agents: AgentRegistration[]): void {
    const maxRow = Math.max(0, this.totalAgentRows(agents) - 1);
    this.selectedAgentRow = Math.max(0, Math.min(maxRow, this.selectedAgentRow));
  }

  private currentAgentRow(agents: AgentRegistration[]): { type: "remote"; agent: AgentRegistration } | null {
    this.clampAgentSelection(agents);
    const agent = agents[this.selectedAgentRow];
    return agent ? { type: "remote", agent } : null;
  }

  private activateAgentSelection(agents: AgentRegistration[]): void {
    const row = this.currentAgentRow(agents);
    if (!row) return;

    void Promise.resolve(this.deps.onFocusRemote(row.agent)).catch(() => {
      // best effort
    });
    this.deps.done();
  }

  private cycleTab(delta: number, agents: AgentRegistration[], switchTargets: AgentRegistration[]): void {
    const tabs = this.getTabs(agents);
    const current = tabs.indexOf(this.selectedTab);
    const idx = current === -1 ? 0 : current;
    const next = (idx + delta + tabs.length) % tabs.length;
    this.selectedTab = tabs[next] ?? AGENTS_TAB;
    this.scrollPosition = 0;
    this.clampAgentSelection(switchTargets);
    this.resetMentionCompletion();
  }

  private getMessages(limit: number): MessageLogEvent[] {
    const all = this.deps.loadMessages(limit);
    if (this.selectedTab === ALL_TAB) return all;
    if (this.selectedTab === AGENTS_TAB || this.selectedTab === RESERVATIONS_TAB) return [];

    const peer = this.selectedTab;
    return all.filter((m) => {
      if (m.kind === "direct") {
        return m.from === peer || m.to === peer;
      }

      if (m.kind === "broadcast") {
        if (m.from === peer) return true;
        if (Array.isArray(m.recipients) && m.recipients.includes(peer)) return true;
      }

      return false;
    });
  }

  private sendFromInput(agents: AgentRegistration[]): void {
    let text = this.inputText.trim();
    if (!text) return;

    let explicitTarget: string | null = null;
    let broadcast = false;

    if (text.startsWith("@all ")) {
      broadcast = true;
      text = text.slice(5).trim();
    } else if (text.startsWith("@")) {
      const spaceIdx = text.indexOf(" ");
      if (spaceIdx > 1) {
        const candidate = text.slice(1, spaceIdx);
        const resolved = this.resolveAgentInputName(candidate, agents);
        if (resolved) {
          explicitTarget = resolved;
          text = text.slice(spaceIdx + 1).trim();
        }
      }
    }

    if (!text) return;

    let urgent = false;
    if (text.startsWith("!! ")) {
      urgent = true;
      text = text.slice(3).trim();
    }

    if (!text) return;

    if (
      broadcast ||
      this.selectedTab === ALL_TAB ||
      this.selectedTab === AGENTS_TAB ||
      this.selectedTab === RESERVATIONS_TAB
    ) {
      const r = this.deps.sendBroadcast(text, urgent);
      if (!r.ok) {
        this.deps.notify(r.error || "Failed to broadcast", "error");
        return;
      }
      this.inputText = "";
      this.scrollPosition = 0;
      this.resetMentionCompletion();
      this.tui.requestRender();
      return;
    }

    const target = explicitTarget ?? this.selectedTab;
    const r = this.deps.sendDirect(target, text, urgent);
    if (!r.ok) {
      this.deps.notify(r.error || `Failed to send to ${target}`, "error");
      return;
    }

    this.inputText = "";
    this.scrollPosition = 0;
    this.resetMentionCompletion();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const agents = this.deps.loadAgents();
    const switchTargets = this.getSwitchTargets(agents);

    if (matchesKey(data, "escape")) {
      this.deps.done();
      return;
    }

    if (matchesKey(data, "tab")) {
      if (this.currentMentionToken() !== null) {
        this.tryCompleteMention(agents, 1);
        return;
      }
      this.cycleTab(1, agents, switchTargets);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "shift+tab")) {
      if (this.currentMentionToken() !== null) {
        this.tryCompleteMention(agents, -1);
        return;
      }
      this.cycleTab(-1, agents, switchTargets);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "right")) {
      this.cycleTab(1, agents, switchTargets);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "left")) {
      this.cycleTab(-1, agents, switchTargets);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.selectedTab === AGENTS_TAB) {
        this.selectedAgentRow = Math.max(0, this.selectedAgentRow - 1);
      } else {
        this.scrollPosition = Math.max(0, this.scrollPosition - 1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedTab === AGENTS_TAB) {
        this.selectedAgentRow = Math.min(this.totalAgentRows(switchTargets) - 1, this.selectedAgentRow + 1);
      } else {
        this.scrollPosition += 1;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      if (this.selectedTab === AGENTS_TAB) {
        this.selectedAgentRow = 0;
      } else {
        this.scrollPosition = 0;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      if (this.selectedTab === AGENTS_TAB) {
        this.selectedAgentRow = this.totalAgentRows(switchTargets) - 1;
      } else {
        this.scrollPosition = Number.MAX_SAFE_INTEGER;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.selectedTab === AGENTS_TAB && this.inputText.trim().length === 0) {
        this.activateAgentSelection(switchTargets);
      } else {
        this.sendFromInput(agents);
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.inputText.length > 0) {
        this.inputText = this.inputText.slice(0, -1);
        this.resetMentionCompletion();
        this.tui.requestRender();
      }
      return;
    }

    if (data.length > 0 && data.charCodeAt(0) >= 32) {
      this.inputText += data;
      this.resetMentionCompletion();
      this.tui.requestRender();
    }
  }

  render(_width: number): string[] {
    const width = Math.min(this.width, Math.max(60, _width - 2));
    const innerWidth = width - 2;
    const agents = this.deps.loadAgents();
    const switchTargets = this.getSwitchTargets(agents);

    const tabs = this.getTabs(agents);
    if (!tabs.includes(this.selectedTab)) {
      this.selectedTab = ALL_TAB;
      this.scrollPosition = 0;
    }

    this.clampAgentSelection(switchTargets);

    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border("│") + pad(" " + content, innerWidth) + border("│");
    const emptyRow = () => border("│") + " ".repeat(innerWidth) + border("│");

    const lines: string[] = [];

    const title = `${this.theme.fg("accent", "Agents and Messages")} ─ ${this.theme.fg("dim", this.displayAgentLabel(this.deps.selfName, this.deps.selfRole))} ─ ${this.focusLabel(agents)}`;
    const titleText = ` ${title} `;
    const titleLen = visibleWidth(title) + 2;
    const borderLen = Math.max(0, innerWidth - titleLen);
    const left = Math.floor(borderLen / 2);
    const right = borderLen - left;

    lines.push(border("╭" + "─".repeat(left)) + titleText + border("─".repeat(right) + "╮"));
    lines.push(emptyRow());
    const tabLines = this.renderTabBarLines(innerWidth - 2, agents);
    for (const tabLine of tabLines) lines.push(row(tabLine));
    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));

    const messageAreaHeight = MESSAGE_AREA_HEIGHT;
    const messageLines =
      this.selectedTab === AGENTS_TAB
        ? this.renderAgentsView(innerWidth - 2, messageAreaHeight, switchTargets)
        : this.selectedTab === RESERVATIONS_TAB
          ? this.renderReservationsView(innerWidth - 2, messageAreaHeight)
          : this.renderMessagesView(innerWidth - 2, messageAreaHeight, agents);

    for (const line of messageLines) lines.push(row(line));

    lines.push(border("├" + "─".repeat(innerWidth) + "┤"));
    lines.push(row(this.renderInputBar(innerWidth - 2, agents)));
    lines.push(border("╰" + "─".repeat(innerWidth) + "╯"));

    return lines;
  }

  private focusLabel(agents: AgentRegistration[]): string {
    if (this.deps.focus.mode === "local") return this.theme.fg("dim", "focus: local");
    const role = this.resolveRole(this.deps.focus.targetAgent, agents);
    return this.theme.fg("warning", `focus: ${this.displayAgentLabel(this.deps.focus.targetAgent, role)}`);
  }

  private renderTabBarLines(width: number, agents: AgentRegistration[]): string[] {
    const tabs = this.getTabs(agents);
    const parts: string[] = [];

    for (const tab of tabs) {
      const selected = this.selectedTab === tab;
      const label =
        tab === AGENTS_TAB
          ? "Agents"
          : tab === RESERVATIONS_TAB
            ? "File reservations"
            : tab === ALL_TAB
              ? "All messages"
              : this.displayAgentLabel(tab, this.resolveRole(tab, agents));
      const prefix = selected ? "▸ " : "";
      parts.push(prefix + this.theme.fg(selected ? "accent" : "muted", label));
    }

    const rows: string[] = [];
    let current = "";

    for (const part of parts) {
      const next = current ? `${current} │ ${part}` : part;
      if (visibleWidth(next) <= width) {
        current = next;
        continue;
      }

      if (current) rows.push(current);
      current = visibleWidth(part) <= width ? part : truncateToWidth(part, width);
    }

    if (current) rows.push(current);
    return rows.length > 0 ? rows : [""];
  }

  private renderAgentsView(
    width: number,
    height: number,
    agents: AgentRegistration[],
  ): string[] {
    const out: string[] = [];
    const focus = this.deps.focus;

    out.push(this.theme.fg("dim", "Choose focus target (Enter to switch)"));
    out.push("");

    const headerRows = out.length;
    const bodyHeight = Math.max(1, height - headerRows);

    if (agents.length === 0) {
      out.push(this.theme.fg("dim", "No other active agents"));
    } else {
      const maxTop = Math.max(0, agents.length - bodyHeight);
      const top = Math.max(0, Math.min(maxTop, this.selectedAgentRow - Math.floor(bodyHeight / 2)));

      for (let row = 0; row < bodyHeight; row++) {
        const idx = top + row;
        const agent = agents[idx];
        if (!agent) {
          out.push("");
          continue;
        }

        const selected = this.selectedAgentRow === idx;
        const focused =
          focus.mode === "remote" &&
          (focus.targetAgent === agent.name ||
            (focus.targetSessionId !== undefined && focus.targetSessionId === agent.sessionId));
        const name = this.displayAgentLabel(agent.name, agent.role);
        const canSwitch = !!agent.sessionFile && existsSync(agent.sessionFile);
        const isCompleted = agent.pid <= 0;
        const availability = isCompleted ? " • completed" : canSwitch ? "" : " • session pending";
        const line = `${selected ? "▸" : " "} ${name} • ${agent.model} • ${agent.cwd.split("/").pop() || agent.cwd}${focused ? " • focused" : ""}${availability}`;
        out.push(truncateToWidth(line, width));
      }
    }

    while (out.length < height) out.push("");
    return out.slice(0, height);
  }

  private renderReservationsView(width: number, height: number): string[] {
    const out: string[] = [];
    const reservationAgents = this.deps.loadReservationAgents();
    const reservations = reservationAgents
      .flatMap((agent) =>
        (agent.reservations ?? []).map((reservation) => ({
          agent,
          reservation,
        })),
      )
      .sort((a, b) => {
        const byAgent = a.agent.name.localeCompare(b.agent.name);
        if (byAgent !== 0) return byAgent;
        return a.reservation.pattern.localeCompare(b.reservation.pattern);
      });

    out.push(this.theme.fg("dim", "Active file reservations (write/edit locks)"));
    out.push("");

    const headerRows = out.length;
    const bodyHeight = Math.max(1, height - headerRows);

    if (reservations.length === 0) {
      out.push(this.theme.fg("dim", "No active reservations."));
    } else {
      const maxTop = Math.max(0, reservations.length - bodyHeight);
      const top = Math.max(0, Math.min(maxTop, this.scrollPosition));
      this.scrollPosition = top;

      for (let row = 0; row < bodyHeight; row++) {
        const idx = top + row;
        const item = reservations[idx];
        if (!item) {
          out.push("");
          continue;
        }

        const name = this.displayAgentLabel(item.agent.name, item.agent.role);
        const reason = item.reservation.reason ? ` • ${item.reservation.reason}` : "";
        const line = `${name} • ${item.reservation.pattern}${reason}`;
        out.push(truncateToWidth(line, width));
      }
    }

    while (out.length < height) out.push("");
    return out.slice(0, height);
  }

  private renderMessagesView(width: number, height: number, agents: AgentRegistration[]): string[] {
    const messages = this.getMessages(600);

    if (messages.length === 0) {
      const empty = [this.theme.fg("dim", "No messages yet")];
      while (empty.length < height) empty.push("");
      return empty;
    }

    const ordered = [...messages].reverse(); // newest first
    const maxVisibleMessages = Math.max(1, Math.floor(height / 4));
    const maxScroll = Math.max(0, ordered.length - maxVisibleMessages);
    const safeScroll = Math.min(this.scrollPosition, maxScroll);
    const visible = ordered.slice(safeScroll, safeScroll + maxVisibleMessages);

    const lines: string[] = [];
    for (const msg of visible) {
      lines.push(...this.renderMessage(msg, width - 2, agents));
    }

    if (lines.length > height) return lines.slice(0, height);
    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderMessage(msg: MessageLogEvent, width: number, agents: AgentRegistration[]): string[] {
    const fromSelf = msg.from === this.deps.selfName;
    const actorLabel = fromSelf
      ? "You"
      : this.displayAgentLabel(msg.from, this.resolveRole(msg.from, agents));
    const actor = fromSelf ? this.theme.fg("accent", actorLabel) : this.theme.fg("warning", actorLabel);

    const selectedPeer =
      this.selectedTab !== AGENTS_TAB &&
      this.selectedTab !== RESERVATIONS_TAB &&
      this.selectedTab !== ALL_TAB
        ? this.selectedTab
        : null;
    const selectedPeerLabel = selectedPeer
      ? this.displayAgentLabel(selectedPeer, this.resolveRole(selectedPeer, agents))
      : null;

    const isBroadcastToPeer =
      msg.to === "all" &&
      Boolean(selectedPeer) &&
      msg.from !== selectedPeer &&
      Array.isArray(msg.recipients) &&
      msg.recipients.includes(selectedPeer);

    const targetName = String(msg.to);
    const targetLabel =
      msg.to === "all"
        ? selectedPeerLabel && msg.from !== selectedPeer
          ? `${selectedPeerLabel} (broadcast)`
          : "all"
        : targetName === this.deps.selfName
          ? "You"
          : this.displayAgentLabel(targetName, this.resolveRole(targetName, agents));
    const target = this.theme.fg("muted", targetLabel);

    const ts = this.theme.fg("dim", new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

    const direction = selectedPeer
      ? msg.to === selectedPeer || isBroadcastToPeer
        ? "→"
        : msg.from === selectedPeer
          ? "←"
          : fromSelf
            ? "→"
            : "←"
      : fromSelf
        ? "→"
        : "←";

    const urgentTag = msg.urgent ? ` ${this.theme.fg("warning", "[urgent]")}` : "";
    const headerRaw = `${direction} ${actor} ${this.theme.fg("dim", "to")} ${target}${urgentTag} ${ts}`;
    const header = truncateToWidth(headerRaw, width);

    const textLines = this.wrapText(msg.text, width);

    const out: string[] = [header];
    for (const line of textLines.slice(0, 3)) out.push(this.theme.fg("toolOutput", line));
    if (textLines.length > 3) out.push(this.theme.fg("dim", "..."));
    out.push("");
    return out;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (!text) return [""];
    const words = text.split(/\s+/g);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (visibleWidth(next) <= maxWidth) {
        current = next;
      } else {
        if (current) lines.push(current);
        if (visibleWidth(word) > maxWidth) {
          lines.push(truncateToWidth(word, maxWidth));
          current = "";
        } else {
          current = word;
        }
      }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
  }

  private renderInputBar(width: number, agents: AgentRegistration[]): string {
    const prompt = this.theme.fg("accent", "> ");
    const hintLabel = "Navigate [Tab] Send [Enter] Exit [Esc]";
    const hint = this.theme.fg("dim", hintLabel);
    const hintLen = visibleWidth(hintLabel);

    let placeholder = "@name msg or @all msg";
    if (this.selectedTab === AGENTS_TAB) {
      placeholder = "Press Enter to switch focus (or type a message to broadcast)";
    } else if (this.selectedTab === RESERVATIONS_TAB) {
      placeholder = "Viewing reservations. Type a message to broadcast (use !! for urgent).";
    } else if (this.selectedTab !== ALL_TAB) {
      placeholder = `Message ${this.displayAgentLabel(this.selectedTab, this.resolveRole(this.selectedTab, agents))}... (use !! for urgent)`;
    } else if (this.selectedTab === ALL_TAB) {
      placeholder = "Broadcast to all active agents (prefix with !! for urgent)";
    }

    const text = this.inputText || this.theme.fg("dim", placeholder);
    const maxTextLen = Math.max(1, width - 2 - hintLen - 1);
    const display = truncateToWidth(text, maxTextLen);
    const padLen = Math.max(0, width - 2 - visibleWidth(display) - hintLen);
    return `${prompt}${display}${" ".repeat(padLen)}${hint}`;
  }

  invalidate(): void {
    // no-op
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
  }
}
