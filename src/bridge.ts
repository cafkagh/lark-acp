import type {
  SessionNotification, ContentBlock, RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import { log } from "./log.js";
import { agentPool, promptAborts, clearPersistedSessionId } from "./agents/client.js";
import { getBackend, getDefaultBackend } from "./agents/registry.js";
import type { AgentBackend } from "./agents/types.js";
import { agentForChat, modelPrefForChat } from "./state.js";
import { StreamingReplier } from "./streaming.js";

// Same idea as the original BOT_RELAY_SYSTEM_HINT — but injected per-prompt
// because ACP doesn't expose a standard "system prompt" slot, and we don't
// want to depend on backend-specific flags. Repeated each turn (tiny token
// cost, robust across resume / load).
export const BOT_RELAY_PREAMBLE = `
You are running inside a Feishu/Lark chat bot. When a user prompt is
prefixed with a "[Feishu ...]" tag it means the message arrived from a
Feishu chat, and the bot will automatically relay your text response
back to that same chat as the reply.

Rules when handling a [Feishu ...] prompt:
- Your text output IS the reply. Just answer directly.
- Do NOT call any lark / lark-im / Feishu send-message tool to reply to
  the SAME chat yourself — that will duplicate the message.
- Do NOT narrate actions like "已回复群里：..." or "I replied in the
  group with ..." — the text is the reply, not a report about it.
- Other Feishu tools (lark-doc, lark-sheet, lark-calendar, messaging to
  a DIFFERENT chat, etc.) are fine when the user explicitly asks for
  them.

If the tag contains "reply_to=<msg_id>", this message is a reply to that
earlier Feishu message in the same chat. Treat the replied-to message as
the likely subject when the user's instruction is short or has an unclear
referent (e.g. "分析下", "看看", "翻译", "为什么", "解释下", "改下").
To read its content, call:
  lark-cli im +messages-mget --message-ids <msg_id> --as bot
Do this BEFORE asking the user for clarification.

Prompts without the [Feishu ...] tag come from the CLI directly and
don't need these constraints.
`.trim();

function pickPreview(input: unknown, maxLen: number): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const keys = ["file_path", "path", "command", "pattern", "url", "description", "query"];
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v) {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > maxLen ? flat.slice(0, maxLen) + "…" : flat;
    }
  }
  return undefined;
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (item?.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
      return item.content.text;
    }
    if (item?.type === "diff") {
      const path = item.path ?? "?";
      return `diff @ ${path}`;
    }
    if (item?.type === "terminal" && item.terminalId) {
      return `terminal ${item.terminalId}`;
    }
  }
  return "";
}

function shortText(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLen ? flat.slice(0, maxLen) + "…" : flat;
}

export type AskAgentResult = {
  /** What got streamed into the card body. Same value the user sees. */
  body: string;
  /** ACP stop reason. "cancelled" / "refusal" mean the run ended unhappily. */
  stopReason: string;
  agentName: string;
};

export async function askAgent(opts: {
  chatId: string;
  cwd: string;
  prompt: string;
  replier: StreamingReplier;
  abort: AbortController;
  /** Preferred agent for this chat (defaults to whatever state has). */
  backendOverride?: string;
}): Promise<AskAgentResult> {
  const { chatId, cwd, prompt, replier, abort, backendOverride } = opts;

  const desiredName = backendOverride ?? agentForChat(chatId);
  const backend: AgentBackend = getBackend(desiredName) ?? getDefaultBackend();
  if (backend.name !== desiredName.toLowerCase()) {
    log(`[bridge] unknown agent "${desiredName}" for chat=${chatId}, falling back to ${backend.name}`);
  }

  const instance = agentPool.get(backend, chatId, cwd);

  let sessionId: string;
  try {
    sessionId = await instance.ensureSession(chatId);
  } catch (e: any) {
    throw new Error(`agent ${backend.name} session setup failed: ${e?.message ?? e}`);
  }

  // Apply persisted /model preference if it differs from the agent's current
  // pick. Best-effort — failures (capability missing, unknown model id after
  // an agent upgrade) are logged but don't block the prompt from running.
  const desiredModel = modelPrefForChat(chatId, backend.name);
  if (desiredModel) {
    const state = instance.getModelState(chatId);
    if (state && state.currentModelId !== desiredModel) {
      try {
        await instance.setModel(chatId, desiredModel);
      } catch (e: any) {
        log(`[bridge/${backend.name}] apply model pref "${desiredModel}" failed: ${e?.message ?? e}`);
      }
    }
  }

  // Surface active model in the card footer. Prefer the friendly ModelInfo
  // name (carries the version, e.g. "Opus 4.7 (1M context)") and fall back
  // to the bare modelId if the agent didn't supply a name.
  const finalState = instance.getModelState(chatId);
  if (finalState?.currentModelId) {
    const info = finalState.availableModels.find((m) => m.modelId === finalState.currentModelId);
    replier.setActiveModel(info?.name || finalState.currentModelId);
  }

  const finalPrompt = `${BOT_RELAY_PREAMBLE}\n\n${prompt}`;
  const blocks: ContentBlock[] = [{ type: "text", text: finalPrompt }];

  const cbs = {
    onUpdate(notif: SessionNotification) {
      const u: any = notif.update;
      const kind: string = u?.sessionUpdate;
      switch (kind) {
        case "agent_message_chunk": {
          const c = u.content;
          if (c?.type === "text" && typeof c.text === "string") {
            replier.feed(c.text);
          }
          break;
        }
        case "agent_thought_chunk": {
          const c = u.content;
          if (c?.type === "text" && typeof c.text === "string") {
            replier.onThought(c.text);
          }
          break;
        }
        case "tool_call": {
          const id = String(u.toolCallId);
          const title = String(u.title || "tool");
          const short = pickPreview(u.rawInput, 60);
          const long = pickPreview(u.rawInput, 250);
          replier.onToolStart(id, title, short, long);
          // tool_call may already include initial content (e.g. echo of input).
          if (u.content) {
            const txt = extractContentText(u.content);
            if (txt) replier.onToolUpdate(id, { result: shortText(txt, 60) });
          }
          break;
        }
        case "tool_call_update": {
          const id = String(u.toolCallId);
          const update: Parameters<StreamingReplier["onToolUpdate"]>[1] = {};
          if (typeof u.title === "string") update.title = u.title;
          if (u.status) update.status = u.status;
          if (u.rawInput) {
            update.preview = pickPreview(u.rawInput, 60);
            update.longPreview = pickPreview(u.rawInput, 250);
          }
          if (u.content) {
            const txt = extractContentText(u.content);
            if (txt) update.result = shortText(txt, 60);
          }
          replier.onToolUpdate(id, update);
          break;
        }
        case "usage_update": {
          replier.onUsage({
            contextSize: typeof u.size === "number" ? u.size : undefined,
            contextUsed: typeof u.used === "number" ? u.used : undefined,
            costUsd: typeof u.cost?.amount === "number" ? u.cost.amount : undefined,
          });
          break;
        }
        case "plan":
        case "current_mode_update":
        case "available_commands_update":
        case "session_info_update":
        case "config_option_update":
        case "user_message_chunk":
          // Don't render — these don't impact the user-visible answer.
          break;
        default:
          // Unknown update kind — log once for visibility.
          log(`[bridge/${backend.name}] unhandled update kind=${kind}`);
      }
    },
    async onPermission(req: RequestPermissionRequest): Promise<string | null> {
      // Auto-allow: pick the option whose kind starts with "allow". Same
      // posture as the original bypassPermissions. We log so misuse is
      // auditable.
      const opts = req.options ?? [];
      const allow = opts.find((o) => /^allow/i.test(o.kind)) ?? opts[0];
      const choice = allow?.optionId ?? null;
      log(
        `[bridge/${backend.name}] auto-allow permission tool=${(req.toolCall as any)?.title ?? "?"} ` +
        `option=${choice} (of ${opts.length})`,
      );
      return choice;
    },
  };

  let resp;
  try {
    resp = await instance.prompt(chatId, sessionId, blocks, cbs, abort.signal);
  } catch (e: any) {
    // Subprocess died mid-prompt or connection broke. Drop the cached
    // session id since the agent likely lost state.
    log(`[bridge/${backend.name}] prompt threw: ${e?.message ?? e} — clearing session`);
    instance.forgetSession(chatId);
    clearPersistedSessionId(chatId, backend.name);
    throw e;
  }

  // Final usage → bake into footer + add to per-chat cumulative cost.
  // ACP's `Usage` schema uses camelCase (inputTokens, outputTokens,
  // cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens). Snake
  // fallbacks keep this resilient to a future SDK version that flips back.
  // Note: PromptResponse.usage carries token counts only; cost arrives via
  // usage_update notifications instead.
  if (resp.usage) {
    const u: any = resp.usage;
    const output =
      (u.outputTokens ?? u.output_tokens ?? 0) +
      (u.thoughtTokens ?? u.thought_tokens ?? 0); // reasoning tokens billed as output
    replier.onResultUsage({
      tokens: {
        input: u.inputTokens ?? u.input_tokens ?? undefined,
        output: output || undefined,
        cacheRead: u.cachedReadTokens ?? u.cache_read_input_tokens ?? undefined,
        cacheWrite: u.cachedWriteTokens ?? u.cache_creation_input_tokens ?? undefined,
      },
    });
  }

  return {
    body: "", // body lives in the replier; bridge doesn't track it separately
    stopReason: resp.stopReason,
    agentName: backend.name,
  };
}
