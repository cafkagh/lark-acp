import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { log } from "./log.js";
import {
  BOT_HOME, DEFAULT_CHAT_WORKDIR,
  ALLOWED_OPEN_IDS, DEFAULT_REPLY_MODE, ReplyMode,
  AGENT_DEFAULT,
} from "./config.js";
import { atomicWriteFile } from "./lock.js";

// ---------- chat_id → agent workdir (anchor; set by /new) ----------
const CHAT_WORKDIR_FILE = join(BOT_HOME, "chat-workdirs.json");
function loadChatWorkdirs(): Record<string, string> {
  if (!existsSync(CHAT_WORKDIR_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CHAT_WORKDIR_FILE, "utf8")) ?? {};
  } catch (e: any) {
    log(`chat-workdirs parse err: ${e?.message}`);
    return {};
  }
}
export const chatWorkdirs = loadChatWorkdirs();
export function saveChatWorkdirs() {
  atomicWriteFile(CHAT_WORKDIR_FILE, JSON.stringify(chatWorkdirs, null, 2));
}
export function workdirFor(chatId: string): string {
  return chatWorkdirs[chatId] ?? DEFAULT_CHAT_WORKDIR;
}

// ---------- chat_id → reply mode (per-chat /mode override) ----------
const CHAT_MODES_FILE = join(BOT_HOME, "chat-modes.json");
function loadChatModes(): Record<string, ReplyMode> {
  if (!existsSync(CHAT_MODES_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(CHAT_MODES_FILE, "utf8")) ?? {};
    const out: Record<string, ReplyMode> = {};
    for (const [k, v] of Object.entries(obj)) {
      const s = String(v).toLowerCase();
      if (s === "strict" || s === "owner" || s === "all") out[k] = s as ReplyMode;
    }
    return out;
  } catch (e: any) {
    log(`chat-modes parse err: ${e?.message}`);
    return {};
  }
}
export const chatModes = loadChatModes();
export function saveChatModes() {
  atomicWriteFile(CHAT_MODES_FILE, JSON.stringify(chatModes, null, 2));
}
export function modeForChat(chatId: string): ReplyMode {
  return chatModes[chatId] ?? DEFAULT_REPLY_MODE;
}

// ---------- chat_id → bot-sender allowlist (per-chat opt-in) ----------
// By default lark-acp drops messages from any other bot (sender_type=app) to
// avoid bot-to-bot loops. Per-chat you can opt-in specific app_ids — e.g.
// "let cli_xxxxxxxxxxxxxxxx drive me in this chat". Modification is gated
// to global ALLOWED_OPEN_IDS members (same as /acl) since granting a peer
// bot the ability to drive us is privileged.
const CHAT_BOT_ALLOWLIST_FILE = join(BOT_HOME, "chat-bot-allowlist.json");
function loadChatBotAllowlist(): Record<string, string[]> {
  if (!existsSync(CHAT_BOT_ALLOWLIST_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(CHAT_BOT_ALLOWLIST_FILE, "utf8")) ?? {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
    }
    return out;
  } catch (e: any) {
    log(`chat-bot-allowlist parse err: ${e?.message}`);
    return {};
  }
}
export const chatBotAllowlist = loadChatBotAllowlist();
export function saveChatBotAllowlist() {
  atomicWriteFile(CHAT_BOT_ALLOWLIST_FILE, JSON.stringify(chatBotAllowlist, null, 2));
}
export function isBotAllowedIn(chatId: string, appId: string): boolean {
  return (chatBotAllowlist[chatId] ?? []).includes(appId);
}

// ---------- chat_id → ACL additions (additive on top of global) ----------
const CHAT_ACL_FILE = join(BOT_HOME, "chat-acl.json");
function loadChatAcl(): Record<string, string[]> {
  if (!existsSync(CHAT_ACL_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(CHAT_ACL_FILE, "utf8")) ?? {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
    }
    return out;
  } catch (e: any) {
    log(`chat-acl parse err: ${e?.message}`);
    return {};
  }
}
export const chatAcl = loadChatAcl();
export function saveChatAcl() {
  atomicWriteFile(CHAT_ACL_FILE, JSON.stringify(chatAcl, null, 2));
}
export function isAllowedIn(chatId: string, openId: string): boolean {
  if (ALLOWED_OPEN_IDS.has(openId)) return true;
  return (chatAcl[chatId] ?? []).includes(openId);
}

// ---------- chat_id → shell-cwd (separate from agent workdir) ----------
const SHELL_CWD_FILE = join(BOT_HOME, "chat-shellcwds.json");
function loadShellCwds(): Record<string, string> {
  if (!existsSync(SHELL_CWD_FILE)) return {};
  try { return JSON.parse(readFileSync(SHELL_CWD_FILE, "utf8")) ?? {}; }
  catch (e: any) { log(`chat-shellcwds parse err: ${e?.message}`); return {}; }
}
export const shellCwds = loadShellCwds();
export function saveShellCwds() {
  atomicWriteFile(SHELL_CWD_FILE, JSON.stringify(shellCwds, null, 2));
}
export function shellCwdFor(chatId: string): string {
  return shellCwds[chatId] ?? workdirFor(chatId);
}
export function setShellCwd(chatId: string, cwd: string) {
  shellCwds[chatId] = cwd;
  saveShellCwds();
}

// ---------- chat_id → preferred model id (per agent) ----------
// Persists `/model <id>` so it survives /restart and idle eviction. The
// preference is applied lazily in the bridge after ensureSession (and only
// when it differs from what the agent currently reports). One slot per
// (chat, agent) so switching agents doesn't trample each other's pick.
const CHAT_MODEL_FILE = join(BOT_HOME, "chat-models.json");
function loadChatModelPrefs(): Record<string, Record<string, string>> {
  if (!existsSync(CHAT_MODEL_FILE)) return {};
  try {
    const obj = JSON.parse(readFileSync(CHAT_MODEL_FILE, "utf8")) ?? {};
    const out: Record<string, Record<string, string>> = {};
    for (const [chat, byAgent] of Object.entries(obj)) {
      if (byAgent && typeof byAgent === "object") {
        const inner: Record<string, string> = {};
        for (const [a, m] of Object.entries(byAgent as Record<string, unknown>)) {
          if (typeof m === "string" && m) inner[a] = m;
        }
        if (Object.keys(inner).length) out[chat] = inner;
      }
    }
    return out;
  } catch (e: any) {
    log(`chat-models parse err: ${e?.message}`);
    return {};
  }
}
export const chatModelPrefs = loadChatModelPrefs();
export function saveChatModelPrefs() {
  atomicWriteFile(CHAT_MODEL_FILE, JSON.stringify(chatModelPrefs, null, 2));
}
export function modelPrefForChat(chatId: string, agent: string): string | undefined {
  return chatModelPrefs[chatId]?.[agent];
}
export function setModelPrefForChat(chatId: string, agent: string, modelId: string) {
  if (!chatModelPrefs[chatId]) chatModelPrefs[chatId] = {};
  chatModelPrefs[chatId][agent] = modelId;
  saveChatModelPrefs();
}
export function clearModelPrefForChat(chatId: string, agent: string) {
  if (!chatModelPrefs[chatId]) return;
  delete chatModelPrefs[chatId][agent];
  if (Object.keys(chatModelPrefs[chatId]).length === 0) delete chatModelPrefs[chatId];
  saveChatModelPrefs();
}

// ---------- chat_id → chosen agent backend name ----------
// New for lark-acp: each chat picks one backend (codex / claude / future).
// Defaults to AGENT_DEFAULT. Switching agents does NOT touch the per-agent
// session bindings — each agent keeps its own session id under
// $BOT_HOME/lark-acp-sessions/<chatId>/<agent>.
const CHAT_AGENT_FILE = join(BOT_HOME, "chat-agents.json");
function loadChatAgents(): Record<string, string> {
  if (!existsSync(CHAT_AGENT_FILE)) return {};
  try { return JSON.parse(readFileSync(CHAT_AGENT_FILE, "utf8")) ?? {}; }
  catch (e: any) { log(`chat-agents parse err: ${e?.message}`); return {}; }
}
export const chatAgents = loadChatAgents();
export function saveChatAgents() {
  atomicWriteFile(CHAT_AGENT_FILE, JSON.stringify(chatAgents, null, 2));
}
export function agentForChat(chatId: string): string {
  return chatAgents[chatId] ?? AGENT_DEFAULT;
}
export function setAgentForChat(chatId: string, agent: string) {
  chatAgents[chatId] = agent;
  saveChatAgents();
}

// ---------- path helpers ----------
export function expandPath(p: string, base: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolvePath(base, p);
}
