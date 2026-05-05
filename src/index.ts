import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import {
  BOT_HOME, SESS_DIR, RESTART_NOTIFY_FILE,
  RESTART_DRAIN_MS, RESTART_EXIT_CODE,
  AGENT_TIMEOUT_MS, TYPING_EMOJI,
  REPLY_MODE,
  BOT_OPEN_ID, setBotOpenId, OWNER_OPEN_ID,
  BOT_APP_ID, setBotAppId,
  ALLOWED_OPEN_IDS, ACL_ENABLED,
  AGENT_DEFAULT,
  RECALL_EMOJI, RECALL_MAX_AGE_MS,
} from "./config.js";
import {
  larkApi, replyText, addReaction, delReaction,
  parseMessagePayload, rememberChatName, chatNameOf,
  recallMessage,
} from "./lark.js";
import { StreamingReplier } from "./streaming.js";
import { acquireLock, releaseLock } from "./lock.js";
import { startSubscribe, sweepOrphanLarkCli } from "./subscribe.js";
import {
  chatWorkdirs, workdirFor, modeForChat, isAllowedIn, agentForChat,
  isBotAllowedIn, findBotMsg, removeBotMsg,
} from "./state.js";
import { COMMANDS, registerShutdown } from "./commands.js";
import {
  askAgent,
} from "./bridge.js";
import {
  agentPool, promptAborts,
  readPersistedSessionId, writePersistedSessionId,
} from "./agents/client.js";
import { getBackend, getDefaultBackend, listBackends } from "./agents/registry.js";

if (!acquireLock()) process.exit(1);
mkdirSync(SESS_DIR, { recursive: true });

log(`pipeline started pid=${process.pid} bot_home=${BOT_HOME} chats=${Object.keys(chatWorkdirs).length}`);

// ---------- bot identity auto-discovery ----------
// /open-apis/bot/v3/info gives both open_id (per our app namespace) and the
// global app_id. open_id powers @-mention detection; app_id powers the
// self-loop guard for sender_type=app messages.
if (!BOT_OPEN_ID || !BOT_APP_ID) {
  try {
    const resp = await larkApi("GET", "/open-apis/bot/v3/info");
    const bot = resp?.bot ?? resp?.data?.bot ?? {};
    if (!BOT_OPEN_ID) setBotOpenId(bot.open_id ?? null);
    if (!BOT_APP_ID) setBotAppId(bot.app_id ?? bot.appid ?? null);
  } catch (e: any) {
    log(`bot info fetch failed: ${e?.message ?? e}`);
  }
}
log(`reply_mode=${REPLY_MODE} bot_open_id=${BOT_OPEN_ID ?? "(unknown)"} bot_app_id=${BOT_APP_ID ?? "(unknown)"} owner_open_id=${OWNER_OPEN_ID ?? "(unset)"}`);
log(`agent_default=${AGENT_DEFAULT} backends=${listBackends().map((b) => b.name).join(",")}`);
if (ACL_ENABLED) {
  log(`acl: enabled (${ALLOWED_OPEN_IDS.size} allowed open_id${ALLOWED_OPEN_IDS.size > 1 ? "s" : ""})`);
} else {
  const warning = "⚠️  SECURITY: ALLOWED_OPEN_IDS and OWNER_OPEN_ID are both empty — " +
    "bot runs in INSECURE mode. ACP servers run with full filesystem/terminal access " +
    "and the bot auto-approves any permission request. Set ALLOWED_OPEN_IDS=ou_xxx,ou_yyy " +
    "to lock it down.";
  log(warning);
  console.error(`[lark-acp] ${warning}`);
}

// ---------- restart-notify ----------
const NOTIFY_PATH = join(BOT_HOME, RESTART_NOTIFY_FILE);
if (existsSync(NOTIFY_PATH)) {
  try {
    const notif = JSON.parse(readFileSync(NOTIFY_PATH, "utf8"));
    rmSync(NOTIFY_PATH, { force: true });
    const age = notif?.at ? Date.now() - Number(notif.at) : NaN;
    if (notif?.messageId && (Number.isNaN(age) || age < 120_000)) {
      const secs = Number.isNaN(age) ? "?" : `${Math.max(1, Math.round(age / 100) / 10)}s`;
      replyText(notif.messageId, `✅ restarted (${secs})${notif.reason ? ` [${notif.reason}]` : ""}`)
        .catch((e: any) => log(`notify reply failed: ${e?.message}`));
      log(`restart-notify sent to ${notif.chatId ?? "?"} age=${secs}`);
    } else {
      log(`restart-notify stale or empty, skipped`);
    }
  } catch (e: any) {
    log(`restart-notify read err: ${e?.message}`);
  }
}

// ---------- in-flight tracking + graceful shutdown ----------
let shuttingDown = false;
const inflight = new Set<Promise<unknown>>();
// Per-chat serialization (same reasoning as original): two messages from one
// chat arriving together would race the same session. Chain handlers per
// chat. /cancel bypasses the lock so it can interrupt the running prompt.
const chatLocks = new Map<string, Promise<void>>();
const SEEN_EVENT_TYPES = new Set<string>();

function dispatchLine(line: string): void {
  let chatId = "";
  let peekText = "";
  let rawParsed: any = null;
  try {
    rawParsed = JSON.parse(line);
    const eventType: string = rawParsed?.header?.event_type ?? "";
    if (eventType && !SEEN_EVENT_TYPES.has(eventType)) {
      SEEN_EVENT_TYPES.add(eventType);
      log(`[event] first sight: ${eventType}`);
    }
    if (eventType === "card.action.trigger") {
      const p = handleCardAction(rawParsed).catch((e) =>
        log(`card-action crash: ${e?.stack ?? e}`));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      return;
    }
    if (eventType === "im.message.reaction.created_v1") {
      const p = handleReactionEvent(rawParsed).catch((e) =>
        log(`reaction crash: ${e?.stack ?? e}`));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      return;
    }
    chatId = rawParsed?.event?.message?.chat_id ?? "";
    const rawContent: string = rawParsed?.event?.message?.content ?? "";
    if (rawContent) {
      try { peekText = (JSON.parse(rawContent)?.text ?? "").trim(); } catch {}
    }
  } catch {}

  const run = () =>
    handleEvent(line).catch((e) => log(`handleEvent crash: ${e?.stack ?? e}`));

  const peekNoMentions = peekText.replace(/^(?:@_user_\d+\s+)+/, "").trim();
  const isCancel = /^\/(cancel|stop|abort)\s*$/.test(peekNoMentions);

  let p: Promise<void>;
  if (chatId && !isCancel) {
    const prev = chatLocks.get(chatId) ?? Promise.resolve();
    p = prev.then(run, run);
    chatLocks.set(chatId, p);
    p.finally(() => {
      if (chatLocks.get(chatId) === p) chatLocks.delete(chatId);
    });
  } else {
    p = run();
  }
  inflight.add(p);
  p.finally(() => inflight.delete(p));
}

const subscriber = startSubscribe({
  onLine: dispatchLine,
  isShuttingDown: () => shuttingDown,
});

async function shutdown(opts: {
  restart: boolean;
  reason: string;
  notify?: { messageId: string; chatId: string };
}): Promise<never> {
  if (shuttingDown) {
    await new Promise(() => {});
    process.exit(0);
  }
  shuttingDown = true;
  log(`shutdown: ${opts.reason} restart=${opts.restart} inflight=${inflight.size}`);

  if (opts.restart && opts.notify) {
    try {
      writeFileSync(NOTIFY_PATH, JSON.stringify({
        messageId: opts.notify.messageId,
        chatId: opts.notify.chatId,
        reason: opts.reason,
        at: Date.now(),
      }));
    } catch (e: any) {
      log(`restart-notify write err: ${e?.message}`);
    }
  }

  subscriber.closeRl();
  subscriber.killGroup("SIGTERM");
  await subscriber.waitForExit(3_000, 6_000);
  sweepOrphanLarkCli();

  if (inflight.size > 0) {
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => setTimeout(r, RESTART_DRAIN_MS)),
    ]);
  }

  // Tear down all spawned ACP server subprocesses. Without this they'd
  // outlive the bot and accumulate as orphans, holding API sessions open.
  await agentPool.disposeAll(opts.restart ? "restart" : "shutdown");

  if (opts.restart) await new Promise((r) => setTimeout(r, 500));

  releaseLock();
  process.exit(opts.restart ? RESTART_EXIT_CODE : 0);
}

registerShutdown(shutdown);

async function handleCardAction(raw: any): Promise<void> {
  const event = raw?.event;
  const action = event?.action;
  const value = action?.value ?? {};
  const operatorId: string = event?.operator?.open_id ?? "";
  const chatId: string = value.chat_id ?? event?.context?.open_chat_id ?? "";
  const owner: string = value.owner ?? "";
  const act = String(value.action ?? "");

  log(`[card-action] received action=${act} chat=${chatId} operator=${operatorId} owner=${owner}`);

  if (!chatId) {
    log(`[card-action] missing chat_id in value, dropping`);
    return;
  }

  if (ACL_ENABLED && operatorId && !isAllowedIn(chatId, operatorId)) {
    log(`⛔ card-action acl-denied operator=${operatorId} chat=${chatId}`);
    return;
  }

  if (act === "cancel") {
    if (owner && operatorId && owner !== operatorId) {
      log(`[cancel button] ${chatId} denied: operator=${operatorId} is not owner=${owner}`);
      return;
    }
    const ctrl = promptAborts.get(chatId);
    if (ctrl) {
      log(`[cancel button] ${chatId} by ${operatorId} (owner=${owner}) → aborting`);
      ctrl.abort("cancel");
    } else {
      log(`[cancel button] ${chatId} by ${operatorId} (nothing in-flight)`);
    }
    return;
  }
  log(`[card-action] unknown action=${act} chat=${chatId}`);
}

// Reaction-driven recall: user reacts with RECALL_EMOJI on a bot message
// → bot deletes that message via Feishu API. Permission: only the user
// whose prompt produced the message (triggerOpenId) or any global ACL
// admin can recall. Other reactions are no-ops.
async function handleReactionEvent(raw: any): Promise<void> {
  const event = raw?.event;
  // Reaction event payload shape (v1):
  //   message_id: "om_xxx"
  //   reaction_type: { emoji_type: "TrashCan" }
  //   operator_type: "user"
  //   user_id: { open_id: "ou_xxx", ... }   (or operator.open_id depending on version)
  // Be tolerant of either shape — Feishu has shipped both.
  const msgId: string = event?.message_id ?? "";
  const emoji: string = event?.reaction_type?.emoji_type ?? "";
  const operatorId: string =
    event?.user_id?.open_id ?? event?.operator?.open_id ?? "";
  if (!msgId || !emoji || !operatorId) {
    log(`[reaction] dropped: missing fields msg=${msgId} emoji=${emoji} op=${operatorId}`);
    return;
  }
  if (emoji !== RECALL_EMOJI) {
    // Not the recall trigger — ignore quietly.
    return;
  }
  const found = findBotMsg(msgId);
  if (!found) {
    // Reaction on a message we don't track (old card past ring buffer,
    // or non-bot message). Nothing to do.
    return;
  }
  const { chatId, entry } = found;
  // Recall permission is tighter than general ACL: only the user whose
  // prompt produced this bot reply (triggerer), or the configured OWNER,
  // can delete it. Other allowlist members can use the bot but can't
  // retract messages that aren't theirs.
  const isOwner = !!OWNER_OPEN_ID && operatorId === OWNER_OPEN_ID;
  const isTrigger = !!entry.triggerOpenId && operatorId === entry.triggerOpenId;
  if (!isOwner && !isTrigger) {
    log(`[recall] ${chatId} denied: operator=${operatorId} is not trigger=${entry.triggerOpenId} nor owner=${OWNER_OPEN_ID}`);
    return;
  }
  const ageMs = Date.now() - entry.sentAt;
  if (ageMs > RECALL_MAX_AGE_MS) {
    log(`[recall] ${chatId} expired: msg=${msgId} age=${Math.round(ageMs / 1000)}s`);
    return;
  }
  const r = await recallMessage(msgId);
  if (r.ok) {
    removeBotMsg(msgId);
    log(`[recall] ${chatId} ok msg=${msgId} by ${operatorId} (${entry.kind} age=${Math.round(ageMs / 1000)}s)`);
  } else {
    // API failure (likely message_too_old or permission issue) — keep the
    // entry; user can retry. Log so admins can see why.
    log(`[recall] ${chatId} FAILED msg=${msgId} by ${operatorId}: ${r.error}`);
  }
}

async function handleEvent(line: string) {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return; }

  const msg = raw?.event?.message;
  const sndr = raw?.event?.sender;
  if (!msg || !sndr) return;

  const messageId: string = msg.message_id ?? "";
  const chatId: string = msg.chat_id ?? "";
  const chatType: string = msg.chat_type ?? "";
  const msgType: string = msg.message_type ?? "";
  const mentions: any[] = Array.isArray(msg.mentions) ? msg.mentions : [];
  const rawContent: string = msg.content ?? "";
  const parentId: string = msg.parent_id ?? "";
  if (!messageId || !chatId) return;

  // Sender routing: user → existing path with global ACL.
  //                 app  → /bots per-chat opt-in (and self-loop guard).
  //                 anything else (system/etc) → drop.
  const senderType: string = sndr.sender_type ?? "";
  const senderUserOpenId: string = sndr.sender_id?.open_id ?? "";
  const senderAppId: string = sndr.sender_id?.app_id ?? "";
  let senderId: string;
  let senderKind: "user" | "app";
  if (senderType === "user") {
    senderKind = "user";
    senderId = senderUserOpenId;
    if (ACL_ENABLED && !isAllowedIn(chatId, senderId)) {
      log(`⛔ acl-denied sender=${senderId} chat=${chatId}`);
      return;
    }
  } else if (senderType === "app") {
    senderKind = "app";
    senderId = senderAppId;
    // Self-loop guard: never react to our own outbound messages echoed back.
    if (BOT_APP_ID && senderAppId === BOT_APP_ID) {
      log(`⛔ self-loop drop app=${senderAppId} chat=${chatId}`);
      return;
    }
    if (!senderAppId || !isBotAllowedIn(chatId, senderAppId)) {
      log(`⛔ bot-sender drop app=${senderAppId || "?"} chat=${chatId} (not in /bots allowlist)`);
      return;
    }
  } else {
    return; // system / unknown sender_type
  }

  const mentionedIds: string[] = mentions
    .map((m: any) => m?.id?.open_id)
    .filter((x: any): x is string => !!x);
  const mentionedBot = BOT_OPEN_ID ? mentionedIds.includes(BOT_OPEN_ID) : false;
  const mentionedOwner = OWNER_OPEN_ID ? mentionedIds.includes(OWNER_OPEN_ID) : false;

  const chatMode = modeForChat(chatId);
  if (chatMode !== "all") {
    const isP2P = chatType === "p2p";
    // App senders can never trigger owner-mode bypass — owner is a person.
    const senderIsOwner = senderKind === "user" && !!OWNER_OPEN_ID && senderId === OWNER_OPEN_ID;

    let ownerBypass = chatMode === "owner" && senderIsOwner;
    if (ownerBypass && mentionedIds.length > 0 && !mentionedBot) {
      const mentionedSomeoneElse = mentionedIds.some(
        (id) => id !== BOT_OPEN_ID && id !== OWNER_OPEN_ID,
      );
      if (mentionedSomeoneElse) {
        ownerBypass = false;
        log(`skip [${chatId}] owner @'d someone else, not the bot`);
        return;
      }
    }

    if (!isP2P && !ownerBypass && !mentionedBot && !mentionedOwner) {
      log(`skip [${chatId}] (${chatType}, mode=${chatMode}, no @bot/@owner)`);
      return;
    }
  }

  const chatWorkdir = workdirFor(chatId);

  const parsed = await parseMessagePayload(msgType, rawContent, messageId, chatId, chatWorkdir);
  if (!parsed) return;
  let content = parsed.text;
  const attachmentsPrompt = parsed.attachmentsPrompt;
  if (!content && !attachmentsPrompt) return;

  for (const m of mentions) {
    if (m?.id?.open_id === BOT_OPEN_ID && m?.key) {
      content = content.split(m.key).join("").trim();
    }
  }

  if (attachmentsPrompt) content = attachmentsPrompt + content;

  log(`<- [${chatId} wd=${chatWorkdir} type=${msgType}] ${senderId}: ${content.slice(0, 200)}`);

  // sessFile is computed lazily in commands; we pass the path to the
  // currently-active agent's persisted session file so cmdStatus etc. can
  // display it without re-deriving the layout.
  const curAgent = agentForChat(chatId);
  const sessFile = join(SESS_DIR, chatId, curAgent);

  for (const cmd of COMMANDS) {
    const match = content.match(cmd.pattern);
    if (match) {
      await cmd.handle({
        chatId, messageId, senderId,
        content, chatWorkdir, sessFile,
        match, mentions,
      });
      return;
    }
  }

  // ===== normal message → ACP agent =====
  const rid = await addReaction(messageId, TYPING_EMOJI);
  log(`[react] ${chatId} rid=${rid}`);

  const backend = getBackend(curAgent) ?? getDefaultBackend();

  rememberChatName(chatId);
  const chatName = chatNameOf(chatId);

  // Source tag: distinguish user vs app sender so the agent knows whether
  // the originator is a person or a peer bot (different reply expectations).
  const senderField = senderKind === "user"
    ? (senderId ? `sender=${senderId}` : null)
    : (senderId ? `sender_app=${senderId} sender_kind=app` : `sender_kind=app`);
  const tagBits = [
    `chat_type=${chatType}`,
    chatName ? `chat="${chatName}"` : `chat=${chatId}`,
    chatName ? `chat_id=${chatId}` : null,
    senderField,
    parentId ? `reply_to=${parentId}` : null,
  ].filter(Boolean).join(" ");
  const sourceTag = `[Feishu ${tagBits}]`;
  const fullPrompt = `${sourceTag}\n${content}`;

  // Cancel-button owner: for user senders we lock to the originating user
  // (only they can cancel). For bot senders the originator can't click the
  // button anyway — leave owner empty so anyone in global ACL can cancel.
  const cancelOwner = senderKind === "user" ? senderId : "";
  const replier = new StreamingReplier(messageId, chatId, cancelOwner, backend.label);
  const abort = new AbortController();
  promptAborts.set(chatId, abort);

  // Optional client-side hard timeout. Default is 0 (unbounded) — ACP
  // requests are long-running by design (multi-minute tool chains).
  const timer = AGENT_TIMEOUT_MS > 0
    ? setTimeout(() => abort.abort("timeout"), AGENT_TIMEOUT_MS)
    : null;

  try {
    const result = await askAgent({
      chatId,
      cwd: chatWorkdir,
      prompt: fullPrompt,
      replier,
      abort,
      backendOverride: curAgent,
    });

    if (result.stopReason === "cancelled") {
      await replier.close("❌ 已取消 · 发送\"继续\"可续写", { footer: true });
      log(`CANCELLED [${chatId}] by stop_reason`);
    } else if (result.stopReason === "refusal") {
      await replier.close("⚠️ agent refused this turn", { footer: true });
      log(`REFUSED [${chatId}]`);
    } else {
      // Body has already streamed in; just close. If body is empty something
      // weird happened (agent returned end_turn with no message) — surface it.
      await replier.close();
      const sid = readPersistedSessionId(chatId, result.agentName) ?? "";
      log(`-> [${chatId} agent=${result.agentName} sid=${sid} stop=${result.stopReason}]`);
    }
  } catch (e: any) {
    const reason = abort.signal.reason;
    if (reason === "cancel") {
      await replier.close("❌ 已取消 · 发送\"继续\"可续写", { footer: true });
      log(`CANCELLED [${chatId}]`);
    } else if (reason === "timeout") {
      await replier.close(
        `⚠️ 超时 (>${AGENT_TIMEOUT_MS / 1000}s) · 发送"继续"可续写`,
        { footer: true },
      );
      log(`TIMEOUT [${chatId}]`);
    } else {
      await replier.close(`⚠️ agent 出错: ${e?.message ?? e}`, { footer: true });
      log(`agent err [${chatId}]: ${e?.stack ?? e}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (promptAborts.get(chatId) === abort) promptAborts.delete(chatId);
    await delReaction(messageId, rid);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown({ restart: false, reason: `signal ${sig}` }).catch(() => {});
  });
}
process.on("exit", releaseLock);
