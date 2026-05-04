import { larkApi } from "./lark.js";
import { log } from "./log.js";
import { recordBotMsg } from "./state.js";

// Per-chat cumulative cost (live, resets on restart). Used by /status footer.
export const chatCostUsd = new Map<string, number>();

export function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export type CardOpts = { cancelChatId?: string; cancelOwner?: string };

export function cardPayload(markdown: string, opts?: CardOpts) {
  const elements: unknown[] = [{ tag: "markdown", content: markdown || "▌" }];
  if (opts?.cancelChatId) {
    elements.push({
      tag: "button",
      element_id: "btn_cancel",
      text: { tag: "plain_text", content: "取消" },
      type: "danger",
      behaviors: [{
        type: "callback",
        value: {
          action: "cancel",
          chat_id: opts.cancelChatId,
          owner: opts.cancelOwner ?? "",
        },
      }],
    });
  }
  return { schema: "2.0", body: { elements } };
}

export async function replyCard(messageId: string, markdown: string, opts?: CardOpts) {
  return larkApi("POST", `/open-apis/im/v1/messages/${messageId}/reply`, {
    msg_type: "interactive",
    content: JSON.stringify(cardPayload(markdown, opts)),
  });
}

export async function updateCard(messageId: string, markdown: string, opts?: CardOpts) {
  return larkApi("PATCH", `/open-apis/im/v1/messages/${messageId}`, {
    content: JSON.stringify(cardPayload(markdown, opts)),
  });
}

export class StreamingReplier {
  private bodyText = "";
  private toolEntries: Array<{
    id: string;
    name: string;
    preview?: string;
    longPreview?: string;
    startMs: number;
    endMs?: number;
    status?: "in_progress" | "completed" | "failed";
    result?: string;
  }> = [];
  private thinking = false;
  // Last short snippet of thought, shown as live status when no body yet.
  private thinkingPreview = "";
  private finalText: string | null = null;
  private lastSent = "";
  private lastSentHadButton = false;
  private msgId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private flushing = Promise.resolve();
  private closed = false;
  private readonly startedAt = Date.now();
  private readonly FIRST_DELAY_MS = Number(process.env.STREAM_FIRST_DELAY_MS ?? 150);
  private readonly INTERVAL_MS = Number(process.env.STREAM_INTERVAL_MS ?? 800);
  private readonly HEARTBEAT_MS = Number(process.env.STREAM_HEARTBEAT_MS ?? 5000);
  private readonly TOOL_HISTORY_MAX = Number(process.env.STREAM_TOOL_HISTORY_MAX ?? 12);

  // Active model display string for the footer. Bridge passes the friendly
  // human name (e.g. "Opus 4.7 (1M context)" / "GPT-5.5 (medium)") rather
  // than the bare modelId, so the version is visible at a glance.
  private activeModel = "";

  constructor(
    private readonly userMessageId: string,
    private readonly chatId: string,
    private readonly senderId: string = "",
    private readonly agentLabel: string = "",
  ) {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      this.scheduleFlush();
    }, this.HEARTBEAT_MS);
  }

  setActiveModel(display: string) {
    if (!display || this.activeModel === display) return;
    this.activeModel = display;
    if (!this.closed) this.scheduleFlush();
  }

  feed(text: string) {
    if (this.closed || !text) return;
    this.bodyText += text;
    // Once we have body text, the agent isn't actively "thinking" — it's
    // committed to a response. Drop the indicator.
    if (this.thinking) this.thinking = false;
    this.scheduleFlush();
  }

  onThought(text: string) {
    if (this.closed || !text) return;
    this.thinking = true;
    // Keep just the tail so the indicator preview doesn't bloat the card.
    const TAIL = 200;
    const next = (this.thinkingPreview + text).replace(/\s+/g, " ");
    this.thinkingPreview = next.length > TAIL ? next.slice(-TAIL) : next;
    this.scheduleFlush();
  }

  onToolStart(id: string, name: string, preview?: string, longPreview?: string) {
    if (this.closed) return;
    this.toolEntries.push({
      id, name, preview, longPreview,
      startMs: Date.now(),
      status: "in_progress",
    });
    if (this.toolEntries.length > this.TOOL_HISTORY_MAX) {
      this.toolEntries.shift();
    }
    // A new tool call also implies thinking has finished.
    if (this.thinking) this.thinking = false;
    this.scheduleFlush();
  }

  onToolUpdate(id: string, opts: {
    status?: "in_progress" | "completed" | "failed";
    title?: string;
    preview?: string;
    longPreview?: string;
    result?: string;
  }) {
    if (this.closed) return;
    const e = this.toolEntries.find((x) => x.id === id);
    if (!e) return;
    if (opts.title) e.name = opts.title;
    if (opts.preview !== undefined) e.preview = opts.preview;
    if (opts.longPreview !== undefined) e.longPreview = opts.longPreview;
    if (opts.result !== undefined) e.result = opts.result;
    if (opts.status) {
      e.status = opts.status;
      if (opts.status === "completed" || opts.status === "failed") {
        if (!e.endMs) e.endMs = Date.now();
      }
    }
    this.scheduleFlush();
  }

  async close(finalText?: string, opts?: { footer?: boolean }) {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopHeartbeat();
    if (finalText !== undefined) {
      if (opts?.footer && this.bodyText) {
        this.finalText = `${this.bodyText}\n\n---\n${finalText}`;
      } else {
        this.finalText = finalText;
      }
    }
    this.flushing = this.flushing.then(() => this.flush());
    await this.flushing;
  }

  private stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleFlush() {
    if (this.timer) return;
    const delay = this.msgId ? this.INTERVAL_MS : this.FIRST_DELAY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushing = this.flushing.then(() => this.flush());
    }, delay);
  }

  // ---------- usage / cost ----------
  // ACP gives us a usage_update event mid-stream and a final usage on
  // PromptResponse. We accept both via onUsage() and remember the latest
  // values for the footer. ContextSize is "size" (window cap) and "used".
  private contextSize = 0;
  private contextUsed = 0;
  private liveTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private finalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  private liveCostUsd = 0;
  private finalCostUsd = 0;

  onUsage(opts: {
    contextSize?: number;
    contextUsed?: number;
    /** Optional cost (cumulative for the session). */
    costUsd?: number;
    /** Optional finer-grained tokens broken down by kind. */
    tokens?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  }): void {
    if (opts.contextSize) this.contextSize = opts.contextSize;
    if (opts.contextUsed) this.contextUsed = opts.contextUsed;
    if (typeof opts.costUsd === "number" && opts.costUsd >= 0) {
      this.liveCostUsd = opts.costUsd;
    }
    if (opts.tokens) {
      for (const k of Object.keys(opts.tokens) as Array<keyof typeof this.liveTokens>) {
        const v = opts.tokens[k];
        if (typeof v === "number") this.liveTokens[k] = v;
      }
    }
    this.scheduleFlush();
  }

  /**
   * Final usage from PromptResponse. Pinned and added into the per-chat
   * cumulative cost map.
   */
  onResultUsage(opts: {
    tokens?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
    costUsd?: number;
  }): void {
    if (opts.tokens) {
      this.finalTokens = {
        input: opts.tokens.input ?? this.liveTokens.input,
        output: opts.tokens.output ?? this.liveTokens.output,
        cacheRead: opts.tokens.cacheRead ?? this.liveTokens.cacheRead,
        cacheWrite: opts.tokens.cacheWrite ?? this.liveTokens.cacheWrite,
      };
    }
    if (typeof opts.costUsd === "number" && opts.costUsd >= 0) {
      this.finalCostUsd = opts.costUsd;
      const prev = chatCostUsd.get(this.chatId) || 0;
      chatCostUsd.set(this.chatId, prev + opts.costUsd);
    }
  }

  private renderFooter(): string {
    const tokens = this.finalTokens ?? (
      this.liveTokens.input || this.liveTokens.output ||
      this.liveTokens.cacheRead || this.liveTokens.cacheWrite
        ? this.liveTokens : null
    );
    const haveAny =
      this.agentLabel || this.contextUsed > 0 || tokens ||
      this.finalCostUsd > 0 || this.liveCostUsd > 0;
    if (!haveAny) {
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      return elapsed > 0 ? `_⌛ ${elapsed}s_` : "";
    }
    const bits: string[] = [];
    if (this.agentLabel) {
      // Agent label + active model in one bit. Compact form
      // `🤖 Claude Code · opus[1m]`. Model omitted when unknown.
      bits.push(this.activeModel
        ? `🤖 ${this.agentLabel} · ${this.activeModel}`
        : `🤖 ${this.agentLabel}`);
    } else if (this.activeModel) {
      bits.push(`🤖 ${this.activeModel}`);
    }
    if (this.contextUsed > 0) {
      bits.push(this.contextSize > 0
        ? `📊 ${fmtTokens(this.contextUsed)}/${fmtTokens(this.contextSize)}`
        : `📊 ${fmtTokens(this.contextUsed)}`);
    }
    if (tokens) {
      const inSum = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
      bits.push(`🪙 ↑${fmtTokens(inSum)} ↓${fmtTokens(tokens.output ?? 0)}`);
    }
    const queryCost = this.finalCostUsd || this.liveCostUsd;
    if (queryCost > 0 || chatCostUsd.has(this.chatId)) {
      const sessionTotal = (chatCostUsd.get(this.chatId) || 0) +
        (this.finalCostUsd > 0 ? 0 : queryCost); // already added if final
      if (queryCost > 0) {
        bits.push(`💰 ${fmtUsd(queryCost)} · 累计 ${fmtUsd(sessionTotal + (this.finalCostUsd || 0))}`);
      } else if (sessionTotal > 0) {
        bits.push(`💰 累计 ${fmtUsd(sessionTotal)}`);
      }
    }
    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
    if (elapsed > 0) bits.push(`⌛ ${elapsed}s`);
    return bits.length ? `_${bits.join(" · ")}_` : "";
  }

  // Small hint shown on the FINAL render (after close) so users discover
  // the reaction-based recall path. Quiet italic so it doesn't compete
  // with the substantive footer.
  private recallHint(): string {
    return "_🗑️ 反应可撤回_";
  }

  private render(): string {
    if (this.finalText !== null) {
      const footer = this.renderFooter();
      const hint = this.recallHint();
      const tail = [footer, hint].filter(Boolean).join(" · ");
      return tail
        ? `${this.finalText || "▌"}\n\n${tail}`
        : (this.finalText || "▌");
    }

    const parts: string[] = [];

    if (this.toolEntries.length) {
      const now = Date.now();
      const lines = this.toolEntries.slice(-this.TOOL_HISTORY_MAX).map((e) => {
        const running = e.status === "in_progress" || (!e.status && !e.endMs);
        const failed = e.status === "failed";
        const tick = failed ? "✗" : running ? "▶" : "✓";
        const shown = running ? (e.longPreview ?? e.preview) : e.preview;
        const arg = shown ? ` \`${shown}\`` : "";
        const res = e.result ? ` → ${e.result}` : "";
        const dur = e.endMs
          ? ` _(${((e.endMs - e.startMs) / 1000).toFixed(1)}s)_`
          : ` _(${Math.round((now - e.startMs) / 1000)}s, running…)_`;
        return `${tick} 🔧 **${e.name}**${arg}${res}${dur}`;
      });
      parts.push(lines.join("\n"));
    }

    if (this.bodyText) {
      parts.push(this.bodyText);
    } else {
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      const icon = this.thinking ? "🤔" : "⏱";
      const verb = this.thinking ? "thinking" : "working";
      const n = this.toolEntries.length;
      const tc = n > 0 ? ` · ${n} tool${n > 1 ? "s" : ""}` : "";
      let line = `${icon} ${verb}… (${elapsed}s${tc})`;
      if (this.thinking && this.thinkingPreview) {
        line += `\n_${this.thinkingPreview}_`;
      }
      parts.push(line);
    }

    const footer = this.renderFooter();
    if (footer) parts.push(footer);
    // Streaming branch: show recall hint only after we've emitted real
    // content (avoid clutter on the first heartbeat blip). Inline with
    // footer so the hint doesn't add a whole new paragraph.
    if (this.bodyText || this.toolEntries.length) {
      parts[parts.length - 1] = `${parts[parts.length - 1]} · ${this.recallHint()}`;
    }

    return parts.join("\n\n") || "▌";
  }

  private async flush() {
    const text = this.render();
    const withButton = !this.closed && this.finalText === null;
    if (text === this.lastSent && withButton === this.lastSentHadButton) return;
    const opts: CardOpts | undefined = withButton
      ? { cancelChatId: this.chatId, cancelOwner: this.senderId }
      : undefined;
    try {
      if (!this.msgId) {
        const resp = await replyCard(this.userMessageId, text, opts);
        this.msgId = resp?.data?.message_id ?? null;
        // Track for reaction-driven recall. senderId is the user whose
        // prompt produced this card; only they (or an admin) can recall.
        if (this.msgId) {
          recordBotMsg(this.chatId, {
            msgId: this.msgId,
            sentAt: Date.now(),
            kind: "card",
            triggerOpenId: this.senderId,
            brief: (this.bodyText || this.finalText || "").slice(0, 80).replace(/\s+/g, " "),
          });
        }
      } else {
        await updateCard(this.msgId, text, opts);
      }
      this.lastSent = text;
      this.lastSentHadButton = withButton;
    } catch (e: any) {
      log(`stream flush err: ${e?.message ?? e}`);
    }
  }
}
