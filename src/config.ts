import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

// ---------- paths ----------
// Fixed home for all bot state (logs, chat configs, ACP session bindings,
// restart notify file). Defaults to ~/.lark-acp; override with
// LARK_ACP_HOME=/abs/path. Mirrors how Claude Code uses ~/.claude.
export const BOT_HOME = process.env.LARK_ACP_HOME ?? join(homedir(), ".lark-acp");
mkdirSync(BOT_HOME, { recursive: true });

// Default working directory used as a chat's agent cwd before any /new has
// pinned one. Falls back to wherever the bot was launched from — that's the
// most useful default for "I cd'd into /project and started the bot, so any
// new chat should default to running agents in /project". Override with
// LARK_ACP_DEFAULT_WORKDIR=/abs/path if you want it decoupled from launch cwd.
export const DEFAULT_CHAT_WORKDIR = process.env.LARK_ACP_DEFAULT_WORKDIR ?? process.cwd();

export const SESS_DIR = join(BOT_HOME, "lark-acp-sessions");
// PID lock stays in /tmp — it's a system-wide single-instance guard, not
// per-user state.
export const PID_FILE = "/tmp/lark-acp-pipeline.pid";
export const LEGACY_LOCK_DIR = "/tmp/lark-acp-pipeline.lock";
export const RESTART_NOTIFY_FILE = ".restart-notify.json";

// ---------- timing & limits ----------
export const RESTART_DRAIN_MS = Number(process.env.RESTART_DRAIN_MS ?? 10_000);
export const RESTART_EXIT_CODE = 99;
export const SHELL_TIMEOUT_MS = Number(process.env.SHELL_TIMEOUT ?? 60) * 1000;
export const SHELL_OUTPUT_LIMIT = Number(process.env.SHELL_OUTPUT_LIMIT ?? 3500);

// ACP request timeout: the original lark-bot-ts had CLAUDE_TIMEOUT defaulting
// to 0 (unbounded). For ACP we keep the same semantics — a long-running agent
// turn can take many minutes (codex/claude doing real work, multi-file edits,
// MCP calls, etc.). The ONLY interrupt path is /cancel, the Cancel button, or
// /restart. Setting AGENT_TIMEOUT=<seconds> to a positive value enables a hard
// cap; otherwise we let it run forever.
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT ?? 0) * 1000;

// Idle subprocess eviction: an ACP server kept alive between user messages
// holds memory + an open API session. Evict if no prompt in this many seconds.
// 0 disables eviction (subprocess only dies on /restart or shutdown).
export const AGENT_IDLE_EVICT_SECS = Number(process.env.AGENT_IDLE_EVICT_SECS ?? 900);
// Grace period after sending session/cancel before we kill the subprocess.
export const AGENT_CANCEL_GRACE_MS = Number(process.env.AGENT_CANCEL_GRACE_MS ?? 4_000);

export const TYPING_EMOJI = process.env.TYPING_EMOJI ?? "Typing";

// ---------- reply mode ----------
export type ReplyMode = "strict" | "owner" | "all";
const DEFAULT_REPLY_MODE_RAW = (process.env.REPLY_MODE ?? "strict").toLowerCase();
export const DEFAULT_REPLY_MODE: ReplyMode =
  DEFAULT_REPLY_MODE_RAW === "all" ? "all"
  : DEFAULT_REPLY_MODE_RAW === "owner" ? "owner"
  : "strict";
export const REPLY_MODE = DEFAULT_REPLY_MODE;

// ---------- bot / owner identity ----------
export let BOT_OPEN_ID: string | null = process.env.BOT_OPEN_ID ?? null;
export function setBotOpenId(id: string | null): void { BOT_OPEN_ID = id; }
export const OWNER_OPEN_ID: string | null = process.env.OWNER_OPEN_ID ?? null;

// Our own Feishu app_id. Used as a self-loop guard when accepting bot-sender
// messages: if a message arrives whose sender.app_id == BOT_APP_ID we drop
// it so this bot doesn't reply to its own outbound messages on chats that
// echo back. Auto-discovered at startup via /open-apis/bot/v3/info; can be
// pre-seeded via env if you want the guard active before the API succeeds.
export let BOT_APP_ID: string | null = process.env.BOT_APP_ID ?? null;
export function setBotAppId(id: string | null): void { BOT_APP_ID = id; }

// ---------- ACL ----------
// ACP servers run with full filesystem/terminal capability and the bot
// auto-approves any permission request — same security posture as the
// original (bypassPermissions). The allowlist is the ONLY thing standing
// between the open chat surface and shell access. Treat it as required.
export const ALLOWED_OPEN_IDS: Set<string> = new Set(
  (process.env.ALLOWED_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (ALLOWED_OPEN_IDS.size === 0 && OWNER_OPEN_ID) ALLOWED_OPEN_IDS.add(OWNER_OPEN_ID);
export const ACL_ENABLED = ALLOWED_OPEN_IDS.size > 0;

// ---------- agent backend selection ----------
export const AGENT_DEFAULT = (process.env.AGENT_DEFAULT ?? "codex").toLowerCase();
