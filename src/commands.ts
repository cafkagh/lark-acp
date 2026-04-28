import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import {
  BOT_HOME, ALLOWED_OPEN_IDS, ACL_ENABLED,
  DEFAULT_REPLY_MODE, ReplyMode,
  AGENT_TIMEOUT_MS, SHELL_TIMEOUT_MS, SHELL_OUTPUT_LIMIT, TYPING_EMOJI,
  AGENT_DEFAULT,
} from "./config.js";
import {
  chatWorkdirs, saveChatWorkdirs,
  chatModes, saveChatModes, modeForChat,
  chatAcl, saveChatAcl,
  chatBotAllowlist, saveChatBotAllowlist,
  shellCwdFor, setShellCwd,
  expandPath,
  agentForChat, setAgentForChat,
  modelPrefForChat, setModelPrefForChat, clearModelPrefForChat,
} from "./state.js";
import {
  SessionInfo, projDirFor,
  findSessionGlobally, listSessions, fmtMtime,
} from "./sessions.js";
import { replyText, addReaction, delReaction } from "./lark.js";
import { StreamingReplier } from "./streaming.js";
import { execShellWithCwd, truncate } from "./shell.js";
import {
  emptyUsage, aggregateUsageFromJsonl, renderUsage,
  PROCESS_STARTED_AT, fmtUptime,
} from "./usage.js";
import {
  promptAborts, agentPool, writePersistedSessionId, clearPersistedSessionId,
  readPersistedSessionId,
} from "./agents/client.js";
import { listBackends, getBackend, getDefaultBackend, isKnownBackend } from "./agents/registry.js";

// ---------- shutdown registration ----------
type ShutdownOpts = {
  restart: boolean;
  reason: string;
  notify?: { messageId: string; chatId: string };
};
type ShutdownFn = (opts: ShutdownOpts) => Promise<never>;
let _shutdown: ShutdownFn | null = null;
export function registerShutdown(fn: ShutdownFn): void { _shutdown = fn; }

// ---------- help text + regexes ----------
export const HELP_TEXT = `命令列表：
/help                       查看本帮助
/pwd                        显示当前会话绑定的 workdir
/agent [name]               查看/切换本会话使用的 agent backend
/model [id|reset]           查看/切换当前 agent 的模型（运行时热切，依赖 agent 支持）
/resume                     列出当前 workdir 下的所有 session
/resume <编号|sid 前缀>     绑定到当前 workdir 下的某个 session
/bind <sid|sid 前缀>        绑定到任意 session（自动切到它的 workdir）
/new [路径]                 开新会话；不传路径就用 !shell cwd（如不同），传路径则切到该目录
/cancel, /stop, /abort      中断当前会话正在跑的查询
/update                     拉 origin/main 最新代码（ff-only），然后自动重启
/restart                    直接重启 bot
/status [all]               查看机器人 / 当前会话 / 用量；加 all 看本 workdir 累计（仅 claude）
/usage [all]                /status [all] 的别名
/mode [strict|owner|all|reset]   查看/设置本会话的回复模式（reset 恢复默认）
/acl [list|add|rm|clear]    查看/改本会话的额外允许名单（只有全局名单成员能改）
/bots [list|add|rm|clear] [app_id]   查看/改本会话允许哪些机器人（cli_xxx）触发我（默认拒绝所有 bot 发的消息）

Shell：
!<命令>                     在 shell 里执行（cwd 按会话持久化，cd / pushd 都生效）
!                           只显示当前 shell cwd，不执行

全局默认 REPLY_MODE：${DEFAULT_REPLY_MODE}（私聊永远回复）
全局默认 AGENT：${AGENT_DEFAULT}
ACP 超时：${AGENT_TIMEOUT_MS > 0 ? `${AGENT_TIMEOUT_MS / 1000}s` : "∞（已禁用，靠 /cancel 中断）"}
代码改动需要 /restart 才会生效（未开启文件热重载）。`;

const BANG_RE = /^!([\s\S]*)$/;
const HELP_RE = /^\/help\s*$/;
const PWD_RE = /^\/pwd\s*$/;
const RESTART_RE = /^\/restart\s*$/;
const STATUS_RE = /^\/status(?:\s+(\S+))?\s*$/;
const MODE_RE = /^\/mode(?:\s+(\S+))?\s*$/;
const ACL_RE = /^\/acl(?:\s+(.+))?\s*$/;
const USAGE_RE = /^\/usage(?:\s+(\S+))?\s*$/;
const NEW_RE = /^\/new(?:\s+(.+?))?\s*$/;
const CANCEL_RE = /^\/(cancel|stop|abort)\s*$/;
const UPDATE_RE = /^\/update\s*$/;
const BIND_RE = /^\/bind(?:\s+(\S+))?\s*$/;
const RESUME_RE = /^\/resume(?:\s+(\S+))?\s*$/;
const AGENT_RE = /^\/agent(?:\s+(\S+))?\s*$/;
const MODEL_RE = /^\/model(?:\s+(.+?))?\s*$/;
const BOTS_RE = /^\/bots(?:\s+(.+))?\s*$/;
const LIST_LIMIT = Number(process.env.RESUME_LIST_LIMIT ?? 20);

// ---------- command dispatch ----------
export type CmdContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  content: string;
  chatWorkdir: string;
  /** Path to the persisted ACP session id file for this (chat, current agent). */
  sessFile: string;
  match: RegExpMatchArray;
  mentions: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
};

export type Command = {
  name: string;
  pattern: RegExp;
  handle: (ctx: CmdContext) => Promise<void>;
};

async function cmdShell(ctx: CmdContext): Promise<void> {
  const cmd = (ctx.match[1] ?? "").trim();
  const curCwd = shellCwdFor(ctx.chatId);
  if (!cmd) {
    await replyText(ctx.messageId, `usage: !<shell command>\nshell cwd: ${curCwd}`);
    return;
  }
  const rid = await addReaction(ctx.messageId, TYPING_EMOJI);
  try {
    const res = await execShellWithCwd(cmd, curCwd);
    if (res.newCwd !== curCwd && existsSync(res.newCwd)) setShellCwd(ctx.chatId, res.newCwd);
    const parts: string[] = [`**\`$ ${cmd.replace(/`/g, "\\`")}\`**`];
    const out = res.stdout.replace(/\n+$/, "");
    const err = res.stderr.replace(/\n+$/, "");
    if (out) parts.push("```\n" + truncate(out, SHELL_OUTPUT_LIMIT) + "\n```");
    if (err) parts.push("**stderr:**\n```\n" + truncate(err, SHELL_OUTPUT_LIMIT) + "\n```");
    if (!out && !err) parts.push("_(no output)_");
    const tail: string[] = [];
    if (res.timedOut) tail.push(`⏱ timed out (>${SHELL_TIMEOUT_MS / 1000}s, killed)`);
    else if (res.exitCode !== 0) tail.push(`exit ${res.exitCode}`);
    if (res.newCwd !== curCwd) tail.push(`cwd → ${res.newCwd}`);
    if (tail.length) parts.push("_" + tail.join(" · ") + "_");
    const r = new StreamingReplier(ctx.messageId, ctx.chatId);
    await r.close(parts.join("\n"));
    log(`[!] ${ctx.chatId} exit=${res.exitCode} cwd=${res.newCwd} cmd=${cmd.slice(0, 80)}`);
  } catch (e: any) {
    await replyText(ctx.messageId, `❌ shell error: ${e?.message ?? e}`);
    log(`[!] ${ctx.chatId} error: ${e?.stack ?? e}`);
  } finally {
    await delReaction(ctx.messageId, rid);
  }
}

async function cmdHelp(ctx: CmdContext): Promise<void> {
  await replyText(ctx.messageId, HELP_TEXT);
}

async function cmdPwd(ctx: CmdContext): Promise<void> {
  const shellCwd = shellCwdFor(ctx.chatId);
  const lines = [
    `Agent workdir (for /bind, /resume, new messages): ${ctx.chatWorkdir}`,
    shellCwd === ctx.chatWorkdir
      ? `shell cwd (for !cmd):  (same as agent workdir)`
      : `shell cwd (for !cmd):  ${shellCwd}`,
  ];
  if (shellCwd !== ctx.chatWorkdir) {
    lines.push("");
    lines.push("⚠️ 两者已分叉 — /new 改 agent cwd（也可用 !shell cwd 隐式切）；!cd 只改 shell cwd。");
  }
  await replyText(ctx.messageId, lines.join("\n"));
}

async function cmdAgent(ctx: CmdContext): Promise<void> {
  const arg = (ctx.match[1] ?? "").trim().toLowerCase();
  const cur = agentForChat(ctx.chatId);
  if (!arg) {
    const all = listBackends().map((b) => {
      const star = b.name === cur ? " ←" : "";
      return `- \`${b.name}\` (${b.label})${star}`;
    }).join("\n");
    await replyText(
      ctx.messageId,
      `**当前 agent**: \`${cur}\`\n**全局默认**: \`${AGENT_DEFAULT}\`\n\n**可用 agents**:\n${all}\n\n用法：\`/agent <name>\` 切换；\`/agent reset\` 恢复默认。`,
    );
    return;
  }
  if (arg === "reset" || arg === "default") {
    setAgentForChat(ctx.chatId, AGENT_DEFAULT);
    await replyText(ctx.messageId, `✅ 本会话 agent 恢复默认：\`${AGENT_DEFAULT}\``);
    log(`[agent] ${ctx.chatId} reset → ${AGENT_DEFAULT}`);
    return;
  }
  if (!isKnownBackend(arg)) {
    const known = listBackends().map((b) => `\`${b.name}\``).join(", ");
    await replyText(ctx.messageId, `❌ 未知 agent：\`${arg}\`。可选：${known}`);
    return;
  }
  setAgentForChat(ctx.chatId, arg);
  await replyText(
    ctx.messageId,
    `✅ 本会话 agent 已切到：\`${arg}\`\n（不同 agent 各自维护 session；切换不会清掉旧 agent 的 session）`,
  );
  log(`[agent] ${ctx.chatId} → ${arg}`);
}

async function cmdModel(ctx: CmdContext): Promise<void> {
  const curAgent = agentForChat(ctx.chatId);
  const backend = getBackend(curAgent) ?? getDefaultBackend();
  const arg = (ctx.match[1] ?? "").trim();
  const pref = modelPrefForChat(ctx.chatId, curAgent);

  // Need a live AgentInstance to know what models are available — that
  // info comes back in the newSession/loadSession response. Spawning is
  // cheap; ensureSession will resume the existing session if one exists.
  const inst = agentPool.get(backend, ctx.chatId, ctx.chatWorkdir);
  let sid: string;
  try {
    sid = await inst.ensureSession(ctx.chatId);
  } catch (e: any) {
    await replyText(ctx.messageId, `❌ 无法初始化 ${curAgent} session: ${e?.message ?? e}`);
    return;
  }
  const state = inst.getModelState(ctx.chatId);

  if (!arg) {
    if (!state) {
      await replyText(
        ctx.messageId,
        `**当前 agent**: \`${curAgent}\` (${backend.label})\n\n⚠️ agent 没暴露可选模型（init 时没返回 models 块）。\n` +
        `这个 backend 不支持运行时切模型，去改它的原生配置文件后 \`/restart\`。`,
      );
      return;
    }
    const lines = state.availableModels.map((m) => {
      const star = m.modelId === state.currentModelId ? " ← 当前" : "";
      const desc = m.description ? `\n     _${m.description}_` : "";
      return `- \`${m.modelId}\` (${m.name})${star}${desc}`;
    }).join("\n");
    const prefLine = pref
      ? `\n本会话偏好：\`${pref}\`（每次新 session 会自动应用）`
      : `\n本会话偏好：（未设置，跟随 agent 默认）`;
    await replyText(
      ctx.messageId,
      `**${backend.label} 可选模型** (sid \`${sid.slice(0, 8)}\`)\n${lines}${prefLine}\n\n` +
      `用法：\`/model <modelId>\` 切换；\`/model reset\` 清掉偏好。`,
    );
    return;
  }

  if (arg === "reset" || arg === "default") {
    clearModelPrefForChat(ctx.chatId, curAgent);
    const cur = state?.currentModelId ?? "(unknown)";
    await replyText(
      ctx.messageId,
      `✅ 本会话 ${curAgent} 模型偏好已清除（agent 当前在 \`${cur}\`，下次新 session 跟随默认）`,
    );
    log(`[model] ${ctx.chatId} agent=${curAgent} reset`);
    return;
  }

  if (!state) {
    await replyText(ctx.messageId, `❌ agent \`${curAgent}\` 不支持运行时切模型`);
    return;
  }

  try {
    await inst.setModel(ctx.chatId, arg);
    setModelPrefForChat(ctx.chatId, curAgent, arg);
    await replyText(
      ctx.messageId,
      `✅ ${backend.label} 模型已切到 \`${arg}\`（已保存为本会话偏好）`,
    );
    log(`[model] ${ctx.chatId} agent=${curAgent} → ${arg}`);
  } catch (e: any) {
    await replyText(ctx.messageId, `❌ 切换失败: ${e?.message ?? e}`);
    log(`[model] ${ctx.chatId} agent=${curAgent} set ${arg} FAILED: ${e?.message}`);
  }
}

async function cmdAcl(ctx: CmdContext): Promise<void> {
  const isGlobalAdmin = ALLOWED_OPEN_IDS.has(ctx.senderId);

  const raw = (ctx.match[1] ?? "").trim();
  const perChat = chatAcl[ctx.chatId] ?? [];

  if (!raw || raw === "list" || raw === "ls") {
    const global = Array.from(ALLOWED_OPEN_IDS).map((id) => `  · \`${id}\``).join("\n") || "  _(无)_";
    const local = perChat.length
      ? perChat.map((id) => `  · \`${id}\``).join("\n")
      : "  _(无)_";
    await replyText(
      ctx.messageId,
      `**当前 chat 的 ACL 状态**\n\n全局允许（env \`ALLOWED_OPEN_IDS\`，可修改 ACL）：\n${global}\n\n本会话额外允许（仅可使用 bot，不可改 ACL）：\n${local}\n\n用法：\n\`/acl add @某人\`   加人（可以 @，也可以直接给 open_id）\n\`/acl rm  @某人\`   删人\n\`/acl clear\`     清空本会话额外名单`,
    );
    return;
  }

  if (!isGlobalAdmin) {
    await replyText(ctx.messageId, `❌ 只有全局允许名单里的成员才能修改 ACL（你 ou_${ctx.senderId.slice(3, 11)}… 不在）`);
    return;
  }

  if (raw === "clear") {
    if (chatAcl[ctx.chatId]) {
      delete chatAcl[ctx.chatId];
      saveChatAcl();
    }
    await replyText(ctx.messageId, `✅ 已清空本会话的额外允许名单`);
    log(`[acl] ${ctx.chatId} cleared by ${ctx.senderId}`);
    return;
  }
  const m = raw.match(/^(add|rm|remove|del|delete)\s+(.+)$/i);
  if (!m) {
    await replyText(ctx.messageId, `❌ 用法：\`/acl add @某人\` | \`/acl rm @某人\` | \`/acl clear\` | \`/acl list\``);
    return;
  }
  const action = m[1].toLowerCase();
  const targetStr = m[2].trim();

  let targetId: string | undefined;
  const mKey = targetStr.match(/@_user_\d+/)?.[0];
  if (mKey) {
    targetId = ctx.mentions.find((x) => x.key === mKey)?.id?.open_id;
  } else if (/^ou_[a-zA-Z0-9]+$/.test(targetStr)) {
    targetId = targetStr;
  } else {
    const hit = ctx.mentions.find((x) => x.name && targetStr.includes(x.name));
    if (hit) targetId = hit.id?.open_id;
  }

  if (!targetId) {
    await replyText(
      ctx.messageId,
      `❌ 没识别出目标用户。请 @ 目标（例如 \`/acl add @张三\`）或给完整 open_id（\`/acl add ou_xxxx\`）`,
    );
    return;
  }

  const list = chatAcl[ctx.chatId] ?? [];
  if (action === "add") {
    if (list.includes(targetId)) {
      await replyText(ctx.messageId, `ℹ️ \`${targetId}\` 已经在本会话的允许名单里`);
      return;
    }
    chatAcl[ctx.chatId] = [...list, targetId];
    saveChatAcl();
    await replyText(ctx.messageId, `✅ 已在本会话允许 \`${targetId}\`（可以用 bot，但不能改 ACL）`);
    log(`[acl] ${ctx.chatId} + ${targetId} by ${ctx.senderId}`);
  } else {
    if (!list.includes(targetId)) {
      await replyText(ctx.messageId, `ℹ️ \`${targetId}\` 不在本会话的额外名单里`);
      return;
    }
    const next = list.filter((id) => id !== targetId);
    if (next.length) chatAcl[ctx.chatId] = next;
    else delete chatAcl[ctx.chatId];
    saveChatAcl();
    await replyText(ctx.messageId, `✅ 已在本会话移除 \`${targetId}\``);
    log(`[acl] ${ctx.chatId} - ${targetId} by ${ctx.senderId}`);
  }
}

async function cmdBots(ctx: CmdContext): Promise<void> {
  // Modify gate: same as /acl — only global allowlist members can change.
  // Read (`/bots` / `/bots list`) is open to anyone who could even reach
  // this handler (i.e. already passed user-ACL or bot-allowlist).
  const isGlobalAdmin = ALLOWED_OPEN_IDS.has(ctx.senderId);
  const raw = (ctx.match[1] ?? "").trim();
  const list = chatBotAllowlist[ctx.chatId] ?? [];

  if (!raw || raw === "list" || raw === "ls") {
    const items = list.length
      ? list.map((id) => `  · \`${id}\``).join("\n")
      : "  _(无 — 默认所有 bot 发的消息都被丢弃)_";
    await replyText(
      ctx.messageId,
      `**本会话的 bot 触发允许名单**\n\n${items}\n\n` +
      `用法（仅全局允许名单成员可改）：\n` +
      `\`/bots add cli_xxx\`   允许该 app_id 的机器人触发本会话\n` +
      `\`/bots rm  cli_xxx\`   移除\n` +
      `\`/bots clear\`         清空\n\n` +
      `_自我循环防护永远开着 —— 本 bot 自己发的消息绝不会被自己接收，无关名单设置。_`,
    );
    return;
  }

  if (!isGlobalAdmin) {
    await replyText(ctx.messageId, `❌ 只有全局允许名单（ALLOWED_OPEN_IDS）成员才能改 /bots 名单`);
    return;
  }

  if (raw === "clear") {
    if (chatBotAllowlist[ctx.chatId]) {
      delete chatBotAllowlist[ctx.chatId];
      saveChatBotAllowlist();
    }
    await replyText(ctx.messageId, `✅ 已清空本会话的 bot 触发名单`);
    log(`[bots] ${ctx.chatId} cleared by ${ctx.senderId}`);
    return;
  }

  const m = raw.match(/^(add|rm|remove|del|delete)\s+(\S+)$/i);
  if (!m) {
    await replyText(ctx.messageId, `❌ 用法：\`/bots add cli_xxx\` | \`/bots rm cli_xxx\` | \`/bots clear\` | \`/bots list\``);
    return;
  }
  const action = m[1].toLowerCase();
  const targetAppId = m[2].trim();
  if (!/^cli_[a-zA-Z0-9]+$/.test(targetAppId)) {
    await replyText(ctx.messageId, `❌ app_id 形如 \`cli_xxxxxxxxxxxxxxxx\`（机器人在飞书开放平台的 App ID）`);
    return;
  }

  if (action === "add") {
    if (list.includes(targetAppId)) {
      await replyText(ctx.messageId, `ℹ️ \`${targetAppId}\` 已经在本会话的 bot 名单里`);
      return;
    }
    chatBotAllowlist[ctx.chatId] = [...list, targetAppId];
    saveChatBotAllowlist();
    await replyText(ctx.messageId, `✅ 已允许 \`${targetAppId}\` 触发本会话（如果它发消息且经过 reply mode 过滤）`);
    log(`[bots] ${ctx.chatId} + ${targetAppId} by ${ctx.senderId}`);
  } else {
    if (!list.includes(targetAppId)) {
      await replyText(ctx.messageId, `ℹ️ \`${targetAppId}\` 不在本会话的 bot 名单里`);
      return;
    }
    const next = list.filter((id) => id !== targetAppId);
    if (next.length) chatBotAllowlist[ctx.chatId] = next;
    else delete chatBotAllowlist[ctx.chatId];
    saveChatBotAllowlist();
    await replyText(ctx.messageId, `✅ 已移除 \`${targetAppId}\``);
    log(`[bots] ${ctx.chatId} - ${targetAppId} by ${ctx.senderId}`);
  }
}

async function cmdMode(ctx: CmdContext): Promise<void> {
  const arg = (ctx.match[1] ?? "").trim().toLowerCase();
  const cur = modeForChat(ctx.chatId);
  if (!arg) {
    const override = chatModes[ctx.chatId];
    const line = override
      ? `当前会话回复模式：\`${cur}\`（本会话覆盖）`
      : `当前会话回复模式：\`${cur}\`（跟随全局默认）`;
    await replyText(ctx.messageId,
      `${line}\n\n用法：\`/mode strict|owner|all\`\n- strict：所有人都必须 @bot 或 @owner\n- owner：群成员要 @；owner 自己不用 @\n- all：所有消息都回\n- \`/mode reset\` 恢复使用全局默认 \`${DEFAULT_REPLY_MODE}\``);
    return;
  }
  if (arg === "reset" || arg === "default") {
    if (ctx.chatId in chatModes) {
      delete chatModes[ctx.chatId];
      saveChatModes();
    }
    await replyText(ctx.messageId, `✅ 本会话已恢复使用全局默认：\`${DEFAULT_REPLY_MODE}\``);
    log(`[mode] ${ctx.chatId} reset → ${DEFAULT_REPLY_MODE}`);
    return;
  }
  if (arg !== "strict" && arg !== "owner" && arg !== "all") {
    await replyText(ctx.messageId, `❌ 无效模式：\`${arg}\`。支持 strict / owner / all / reset`);
    return;
  }
  chatModes[ctx.chatId] = arg as ReplyMode;
  saveChatModes();
  await replyText(ctx.messageId, `✅ 本会话回复模式已设为：\`${arg}\``);
  log(`[mode] ${ctx.chatId} → ${arg}`);
}

async function cmdRestart(ctx: CmdContext): Promise<void> {
  await replyText(ctx.messageId, "♻️ restarting...");
  log(`[restart] requested by ${ctx.chatId}`);
  setImmediate(() => {
    _shutdown?.({
      restart: true,
      reason: `/restart from ${ctx.chatId}`,
      notify: { messageId: ctx.messageId, chatId: ctx.chatId },
    }).catch(() => {});
  });
}

async function cmdStatus(ctx: CmdContext): Promise<void> {
  const curAgent = agentForChat(ctx.chatId);
  const backend = getBackend(curAgent) ?? getDefaultBackend();

  const shellCwd = shellCwdFor(ctx.chatId);
  const uptime = fmtUptime(Date.now() - PROCESS_STARTED_AT);
  const inflightN = promptAborts.size;
  const wantAll = (ctx.match[1] ?? "").trim() === "all";

  const sid = readPersistedSessionId(ctx.chatId, curAgent) ?? "";

  const sections: string[] = [];

  sections.push([
    `**🤖 机器人**`,
    `- 进程 PID：\`${process.pid}\``,
    `- 运行时长：${uptime}`,
    `- bot 主目录：\`${BOT_HOME}\``,
    `- 进行中查询：${inflightN}`,
    `- 回复模式：\`${modeForChat(ctx.chatId)}\`（全局默认：\`${DEFAULT_REPLY_MODE}\`）`,
    `- ACP 超时：${AGENT_TIMEOUT_MS > 0 ? `${AGENT_TIMEOUT_MS / 1000}s` : "∞（已禁用）"}`,
    `- ACL：${ACL_ENABLED ? `${ALLOWED_OPEN_IDS.size} 个允许的 open_id` : "关闭"}`,
  ].join("\n"));

  const agentList = listBackends().map((b) => {
    const star = b.name === curAgent ? " ←" : "";
    return `  · \`${b.name}\`${star}`;
  }).join("\n");
  sections.push([
    `**⚙️ Agent**`,
    `- 当前：\`${curAgent}\` (${backend.label})`,
    `- 全局默认：\`${AGENT_DEFAULT}\``,
    `- 可用：`,
    agentList,
  ].join("\n"));

  sections.push([
    `**💬 当前会话**`,
    `- chat_id：\`${ctx.chatId}\``,
    `- 工作目录：\`${ctx.chatWorkdir}\``,
    `- shell 目录：\`${shellCwd}\``,
    `- ACP session：\`${sid || "(未绑定 / 下条消息会创建)"}\``,
  ].join("\n"));

  // jsonl-aggregated usage only meaningful for claude.
  const projDir = projDirFor(ctx.chatWorkdir);
  if (curAgent === "claude") {
    if (sid) {
      const sessJsonl = join(projDir, `${sid}.jsonl`);
      if (existsSync(sessJsonl)) {
        const u = emptyUsage();
        aggregateUsageFromJsonl(sessJsonl, u);
        sections.push(renderUsage(`📊 本 session 用量 \`${sid.slice(0, 8)}\``, u));
      } else {
        sections.push(`**📊 本 session 用量**\n_(jsonl 不存在)_`);
      }
    } else {
      sections.push(`**📊 本 session 用量**\n_(未绑定 session)_`);
    }
    if (wantAll) {
      if (!existsSync(projDir)) {
        sections.push(`**🗂 workdir 累计**\n_(目录不存在: ${projDir})_`);
      } else {
        const files = readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
        const u = emptyUsage();
        for (const f of files) aggregateUsageFromJsonl(join(projDir, f), u);
        sections.push(renderUsage(`🗂 workdir 累计（${files.length} 个 session）`, u));
      }
    } else {
      sections.push(`_提示：发 \`/status all\` 看本 workdir 全部 session 累计_`);
    }
  } else {
    sections.push(`**📊 本 session 用量**\n_(non-claude agent — usage 由卡片 footer 实时显示，无 jsonl 累计)_`);
  }

  const body = sections.join("\n\n");
  const r = new StreamingReplier(ctx.messageId, ctx.chatId, ctx.senderId);
  await r.close(body);
}

async function cmdUsage(ctx: CmdContext): Promise<void> {
  await cmdStatus(ctx);
}

async function cmdNew(ctx: CmdContext): Promise<void> {
  const arg = ctx.match[1]?.trim();
  const shellCwd = shellCwdFor(ctx.chatId);

  let target: string;
  let source: "explicit" | "shell" | "same";
  if (arg) {
    target = expandPath(arg, shellCwdFor(ctx.chatId));
    source = "explicit";
  } else if (shellCwd && shellCwd !== ctx.chatWorkdir) {
    target = shellCwd;
    source = "shell";
  } else {
    target = ctx.chatWorkdir;
    source = "same";
  }

  if (!existsSync(target) || !statSync(target).isDirectory()) {
    await replyText(ctx.messageId, `❌ 不是目录: ${target}`);
    return;
  }

  const workdirChanged = target !== ctx.chatWorkdir;
  const curAgent = agentForChat(ctx.chatId);

  if (workdirChanged) {
    chatWorkdirs[ctx.chatId] = target;
    saveChatWorkdirs();
  }
  // Forget the ACP session for current agent at OLD workdir AND new workdir,
  // both as in-memory map entry (so the next prompt issues newSession) and
  // on-disk file. Other backends keep their bindings.
  const oldInst = agentPool.find(
    getBackend(curAgent) ?? getDefaultBackend(),
    ctx.chatId,
    ctx.chatWorkdir,
  );
  if (oldInst) oldInst.forgetSession(ctx.chatId);
  clearPersistedSessionId(ctx.chatId, curAgent);

  const lines: string[] = [];
  if (workdirChanged) {
    const why = source === "shell" ? "（来自 !shell cwd）" : "";
    lines.push(`✅ workdir 已切到：\n\`${target}\` ${why}`);
  } else {
    lines.push(`workdir 不变：\`${target}\``);
  }
  lines.push(`agent=${curAgent} 的 session 已清除，下条消息开新 session`);
  lines.push(`（其它 agent 的 session 不受影响）`);
  await replyText(ctx.messageId, lines.join("\n"));
  log(`[new] ${ctx.chatId} target=${target} source=${source} agent=${curAgent}`);
}

async function cmdCancel(ctx: CmdContext): Promise<void> {
  const ctrl = promptAborts.get(ctx.chatId);
  if (!ctrl) {
    log(`[cancel] ${ctx.chatId} by ${ctx.senderId} (nothing in-flight)`);
    await replyText(ctx.messageId, "(nothing to cancel — no in-flight query)");
    return;
  }
  log(`[cancel] ${ctx.chatId} by ${ctx.senderId} → aborting in-flight query`);
  ctrl.abort("cancel");
  await replyText(ctx.messageId, "❌ cancelling…");
}

function runGit(projDir: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", ["-C", projDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (c) => resolve({ stdout, stderr, code: c ?? 1 }));
    child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 1 }));
  });
}

async function cmdUpdate(ctx: CmdContext): Promise<void> {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const projDir = dirname(srcDir);
  if (!existsSync(join(projDir, ".git"))) {
    await replyText(ctx.messageId, `❌ not a git repo: ${projDir}`);
    return;
  }

  await replyText(ctx.messageId, `⬇️ fetching origin/main (${projDir})…`);

  const fetched = await runGit(projDir, ["fetch", "origin", "main"]);
  if (fetched.code !== 0) {
    await replyText(ctx.messageId, `❌ fetch failed (exit ${fetched.code})\n${(fetched.stderr || fetched.stdout).slice(0, 600)}`);
    log(`[update] ${ctx.chatId} fetch rc=${fetched.code}`);
    return;
  }

  const br = await runGit(projDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = br.stdout.trim();

  if (branch !== "main") {
    const co = await runGit(projDir, ["checkout", "main"]);
    if (co.code !== 0) {
      await replyText(ctx.messageId, `❌ cannot checkout main from '${branch}'\n${(co.stderr || co.stdout).slice(0, 500)}`);
      log(`[update] ${ctx.chatId} checkout main failed from ${branch}`);
      return;
    }
  }

  const merged = await runGit(projDir, ["merge", "--ff-only", "origin/main"]);
  const combined = [merged.stdout, merged.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
  if (merged.code !== 0) {
    await replyText(ctx.messageId, `❌ merge --ff-only origin/main failed (exit ${merged.code})\n${combined.slice(0, 600)}`);
    log(`[update] ${ctx.chatId} merge rc=${merged.code}`);
    return;
  }

  const upToDate = /already up to date/i.test(combined) || combined === "";
  if (upToDate && branch === "main") {
    await replyText(ctx.messageId, "ℹ️ already up to date (on main)");
    log(`[update] ${ctx.chatId} up-to-date`);
    return;
  }

  const branchSwitch = branch === "main" ? "" : `\nswitched: ${branch} → main`;
  const depsChanged = /package(-lock)?\.json/.test(combined);
  const depsHint = depsChanged ? "\n⚠️ package*.json changed — may need npm install" : "";

  await replyText(
    ctx.messageId,
    `✅ updated, restarting…${branchSwitch}\n${combined.slice(0, 400)}${depsHint}`,
  );
  log(`[update] ${ctx.chatId} updated from ${branch}, restarting (depsChanged=${depsChanged})`);

  setImmediate(() => {
    _shutdown?.({
      restart: true,
      reason: `/update from ${ctx.chatId}`,
      notify: { messageId: ctx.messageId, chatId: ctx.chatId },
    }).catch(() => {});
  });
}

// Generic shape so cmdResume can render claude jsonl entries and ACP entries
// through the same code path.
type ResumeEntry = {
  sid: string;
  mtime: Date | null;
  preview: string;  // human-readable hint shown in the listing
  cwd?: string | null;
};

async function cmdResume(ctx: CmdContext): Promise<void> {
  const curAgent = agentForChat(ctx.chatId);
  const backend = getBackend(curAgent) ?? getDefaultBackend();
  const target = ctx.match[1];

  let entries: ResumeEntry[] = [];
  let source: "claude-jsonl" | "acp-list" | "unsupported" = "unsupported";

  if (curAgent === "claude") {
    source = "claude-jsonl";
    const sessions: SessionInfo[] = listSessions(ctx.chatWorkdir);
    entries = sessions.map((s) => ({
      sid: s.sid,
      mtime: s.mtime,
      preview: s.firstPrompt || "_(empty)_",
    }));
  } else {
    // Non-claude: try ACP listSessions (need to spawn the agent to ask).
    const inst = agentPool.get(backend, ctx.chatId, ctx.chatWorkdir);
    try {
      const acp = await inst.listAllSessions({ cwd: ctx.chatWorkdir });
      source = "acp-list";
      entries = acp.map((s) => ({
        sid: s.sessionId,
        mtime: s.updatedAt ? new Date(s.updatedAt) : null,
        preview: s.title || "_(no title)_",
        cwd: s.cwd,
      }));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Not a capability → tell the user why; otherwise surface the error.
      if (/does not advertise listSessions/i.test(msg)) {
        await replyText(
          ctx.messageId,
          `❌ /resume 不支持当前 agent (\`${curAgent}\`) — 它没有声明 \`session/list\` 能力。\n切换：\`/agent claude\``,
        );
      } else {
        await replyText(ctx.messageId, `❌ listSessions 失败: ${msg}`);
      }
      return;
    }
  }

  if (entries.length === 0) {
    const where = source === "claude-jsonl"
      ? ctx.chatWorkdir
      : `agent=${curAgent} cwd=${ctx.chatWorkdir}`;
    await replyText(ctx.messageId, `(no sessions in ${where})`);
    return;
  }

  // Most-recent-first when we have timestamps.
  entries.sort((a, b) => {
    const ta = a.mtime?.getTime() ?? 0;
    const tb = b.mtime?.getTime() ?? 0;
    return tb - ta;
  });

  if (!target) {
    const lines = entries.slice(0, LIST_LIMIT).map((s, i) => {
      const when = s.mtime ? fmtMtime(s.mtime) : "(no ts)";
      const prev = s.preview.length > 60 ? s.preview.slice(0, 60) + "…" : s.preview;
      return `**${i + 1}.** \`${s.sid.slice(0, 8)}\`  ${when}\n   ${prev}`;
    });
    const more = entries.length > LIST_LIMIT
      ? `\n\n_(+${entries.length - LIST_LIMIT} older not shown)_`
      : "";
    const tag = source === "acp-list" ? `agent=${curAgent}, ACP listSessions` : "claude jsonl";
    const md = `**Sessions in \`${ctx.chatWorkdir}\`** (${entries.length}, ${tag})\n\n${lines.join("\n\n")}${more}\n\n_use \`/resume <number>\` or \`/resume <sid-prefix>\`_`;
    const r = new StreamingReplier(ctx.messageId, ctx.chatId);
    await r.close(md);
    log(`[resume-list] ${ctx.chatId} agent=${curAgent} count=${entries.length}`);
    return;
  }

  let chosen: ResumeEntry | undefined;
  const num = Number(target);
  if (Number.isInteger(num) && num >= 1 && num <= entries.length) {
    chosen = entries[num - 1];
  } else {
    const matches = entries.filter((s) => s.sid.startsWith(target));
    if (matches.length === 1) chosen = matches[0];
    else if (matches.length > 1) {
      await replyText(ctx.messageId, `❌ ambiguous prefix "${target}" matches ${matches.length} sessions`);
      return;
    }
  }
  if (!chosen) {
    await replyText(ctx.messageId, `❌ no session matching "${target}"\nuse \`/resume\` to list`);
    return;
  }
  // Bind: write persisted file + forget any current in-memory mapping so the
  // next prompt does session/load with the new sid.
  writePersistedSessionId(ctx.chatId, curAgent, chosen.sid);
  const inst = agentPool.find(backend, ctx.chatId, ctx.chatWorkdir);
  if (inst) inst.forgetSession(ctx.chatId);
  const previewShort = chosen.preview.length > 100 ? chosen.preview.slice(0, 100) + "…" : chosen.preview;
  await replyText(
    ctx.messageId,
    `✅ bound ${curAgent} session\n${chosen.sid}\nworkdir: ${ctx.chatWorkdir}\n${source === "claude-jsonl" ? "first prompt" : "title"}: ${previewShort}`,
  );
  log(`[resume] ${ctx.chatId} agent=${curAgent} sid=${chosen.sid} OK`);
}

// Generic shape used by both claude jsonl search and ACP listSessions paths.
type GlobalMatch = { sid: string; cwd: string | null; preview?: string };

async function cmdBind(ctx: CmdContext): Promise<void> {
  const curAgent = agentForChat(ctx.chatId);
  const backend = getBackend(curAgent) ?? getDefaultBackend();
  const target = ctx.match[1];
  if (!target) {
    await replyText(ctx.messageId, `usage: /bind <session-id>\n(current agent: ${curAgent}, workdir: ${ctx.chatWorkdir})`);
    log(`[bind] ${ctx.chatId} missing arg`);
    return;
  }

  // Source the global pool of candidate sessions for this backend.
  let matches: GlobalMatch[] = [];
  let source: "claude-jsonl" | "acp-list" = "claude-jsonl";

  if (curAgent === "claude") {
    matches = findSessionGlobally(target).map((m) => ({ sid: m.sid, cwd: m.cwd }));
  } else {
    source = "acp-list";
    const inst = agentPool.get(backend, ctx.chatId, ctx.chatWorkdir);
    let acp;
    try {
      // No cwd filter — agent should return all sessions it knows about.
      acp = await inst.listAllSessions();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/does not advertise listSessions/i.test(msg)) {
        await replyText(
          ctx.messageId,
          `❌ /bind 不支持当前 agent (\`${curAgent}\`) — 它没有声明 \`session/list\` 能力。\n切换：\`/agent claude\``,
        );
      } else {
        await replyText(ctx.messageId, `❌ listSessions 失败: ${msg}`);
      }
      return;
    }
    matches = acp
      .filter((s) => s.sessionId === target || s.sessionId.startsWith(target))
      .map((s) => ({ sid: s.sessionId, cwd: s.cwd, preview: s.title ?? undefined }));
    // Prefer exact match if both exact and prefix exist.
    const exact = matches.filter((m) => m.sid === target);
    if (exact.length > 0) matches = exact;
  }

  if (matches.length === 0) {
    const where = source === "claude-jsonl"
      ? "~/.claude/projects/"
      : `agent ${curAgent}'s session store`;
    await replyText(ctx.messageId, `❌ no session found matching "${target}"\n(searched ${where})`);
    log(`[bind] ${ctx.chatId} agent=${curAgent} sid=${target} NOT_FOUND`);
    return;
  }
  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map((m) => `• \`${m.sid}\`  ${m.cwd ?? "(cwd unknown)"}`)
      .join("\n");
    const more = matches.length > 5 ? `\n…(+${matches.length - 5} more)` : "";
    await replyText(
      ctx.messageId,
      `❌ ambiguous "${target}" matches ${matches.length} sessions:\n${list}${more}\n\n_use a longer prefix or the full sid_`,
    );
    log(`[bind] ${ctx.chatId} agent=${curAgent} sid=${target} AMBIGUOUS count=${matches.length}`);
    return;
  }
  const m = matches[0];
  const oldWorkdir = ctx.chatWorkdir;
  let workdirNote = `\nworkdir: ${m.cwd ?? oldWorkdir}`;
  let cwdOk = true;
  if (m.cwd && m.cwd !== oldWorkdir) {
    let isDir = false;
    try { isDir = existsSync(m.cwd) && statSync(m.cwd).isDirectory(); } catch {}
    if (isDir) {
      chatWorkdirs[ctx.chatId] = m.cwd;
      saveChatWorkdirs();
      workdirNote = `\nworkdir auto-switched: ${oldWorkdir} → ${m.cwd}`;
    } else {
      cwdOk = false;
      workdirNote =
        `\n⚠️ session's cwd no longer exists: ${m.cwd}` +
        `\nkept current workdir: ${oldWorkdir}` +
        `\n_(agent will run here; session may not line up with files)_`;
    }
  } else if (!m.cwd) {
    workdirNote = `\nworkdir: ${oldWorkdir} _(session has no cwd; kept current)_`;
  }
  writePersistedSessionId(ctx.chatId, curAgent, m.sid);
  // Forget the in-memory mapping at the (potentially new) workdir so the
  // next prompt freshly does session/load.
  const inst = agentPool.find(
    backend,
    ctx.chatId,
    chatWorkdirs[ctx.chatId] ?? ctx.chatWorkdir,
  );
  if (inst) inst.forgetSession(ctx.chatId);
  await replyText(ctx.messageId, `✅ bound ${curAgent} session\n${m.sid}${workdirNote}`);
  log(`[bind] ${ctx.chatId} agent=${curAgent} sid=${m.sid} OK (cwd=${m.cwd ?? "unknown"}, cwd_ok=${cwdOk})`);
}

// First matching pattern wins.
export const COMMANDS: Command[] = [
  { name: "shell",   pattern: BANG_RE,    handle: cmdShell },
  { name: "help",    pattern: HELP_RE,    handle: cmdHelp },
  { name: "pwd",     pattern: PWD_RE,     handle: cmdPwd },
  { name: "agent",   pattern: AGENT_RE,   handle: cmdAgent },
  { name: "model",   pattern: MODEL_RE,   handle: cmdModel },
  { name: "restart", pattern: RESTART_RE, handle: cmdRestart },
  { name: "status",  pattern: STATUS_RE,  handle: cmdStatus },
  { name: "mode",    pattern: MODE_RE,    handle: cmdMode },
  { name: "acl",     pattern: ACL_RE,     handle: cmdAcl },
  { name: "bots",    pattern: BOTS_RE,    handle: cmdBots },
  { name: "usage",   pattern: USAGE_RE,   handle: cmdUsage },
  { name: "new",     pattern: NEW_RE,     handle: cmdNew },
  { name: "cancel",  pattern: CANCEL_RE,  handle: cmdCancel },
  { name: "update",  pattern: UPDATE_RE,  handle: cmdUpdate },
  { name: "resume",  pattern: RESUME_RE,  handle: cmdResume },
  { name: "bind",    pattern: BIND_RE,    handle: cmdBind },
];
