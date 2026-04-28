# lark-acp

> [English](README.md) · 中文

把飞书 / Lark 群聊 / 私聊桥接到 **ACP-compatible coding agent**（Codex / Claude Code / 任意实现 [Agent Client Protocol](https://agentclientprotocol.com/) 的 server）。流式卡片、按 chat 切 agent + 模型、ACL、systemd 部署、机器人之间联动。

## 已支持的 Agent

| Backend | npm 包 | 鉴权 |
|---|---|---|
| `codex` | `@zed-industries/codex-acp` | ChatGPT 登录 / `OPENAI_API_KEY` / `CODEX_API_KEY` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | `~/.claude/settings.json` 里的 `env.ANTHROPIC_*` |

加新 backend 只需在 `src/agents/registry.ts` 注册一个 `AgentBackend`，命令面 / 卡片 / 状态文件全自动适配。详见末尾 [扩展](#扩展)。

## 核心能力

- **飞书消息 → ACP** `session/prompt`，流式回复用 interactive 卡片渲染（思考 / 工具调用 / 文本逐块刷出 / 取消按钮 / footer 含模型 + 上下文 + token + 费用 + 耗时）
- **多 backend 切换**：`/agent codex` `/agent claude`，per-chat 持久化
- **多模型切换**：`/model <id>` 运行时热切（走 ACP `unstable_setSessionModel`），per-chat 偏好持久化
- **Session 续接**：重启 / idle evict 后自动 `session/load`，对话历史不丢
- **Shell 直通**：`!<cmd>` 在 bot 部署机直接跑，cwd 跨消息持久化（`!cd /tmp` 后续 `!ls` 仍在 /tmp）
- **ACL**：全局白名单 + per-chat 增量，未授权用户静默丢弃
- **Bot-to-bot**：`/bots add cli_xxx` 让其他飞书 app 触发本 bot（带 self-loop 防护）
- **生命周期**：`/restart` / `/update`（git fetch + ff-merge + 重启），单实例 PID 锁，孤儿子进程清理
- **附件**：image / file / post 内嵌图片自动下载到 chat workdir，路径喂给 agent

## 快速上手

```bash
git clone git@github.com:cafkagh/lark-acp.git
cd lark-acp
npm install

cp .env.example .env
# 编辑 .env，至少填：
#   ALLOWED_OPEN_IDS, OWNER_OPEN_ID, BOT_OPEN_ID, BOT_APP_ID

./bin/lark-acp
```

需要本机已经装好 `lark-cli` 并登录 bot 凭证，事件订阅走它的 WebSocket。（注意：本项目使用一个带 `+subcommand` 语法的自研 `lark-cli`，跟 npm 上的 `@larksuite/cli` 命令形态不同。）

## 鉴权配置

### Codex

```bash
codex   # 一次性登录 ChatGPT 账号
# 或者：
echo "OPENAI_API_KEY=sk-..." >> .env
```

### Claude Code

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

如果在 root 用户下跑，需在 `.env` 加 `IS_SANDBOX=1`（claude SDK 默认拒绝 root bypass permission）。
如果 npm 没自动装上对应平台的 claude binary，在 `.env` 加 `CLAUDE_CODE_EXECUTABLE=/path/to/claude`。

## 命令面

```
/help                         本帮助
/pwd                          当前 chat 的 agent workdir + shell cwd
/status [all]                 进程 + agent + session + 用量
/usage [all]                  /status 别名

/agent [name]                 查看 / 切 backend (codex|claude|...)
/model [id|reset]             查看 / 切当前 backend 的模型
/resume                       列当前 workdir 下的 session
/resume <序号|sid前缀>         绑到指定 session
/bind <sid|前缀>               跨 workdir 绑 session（自动切 cwd）
/new [path]                   开新 session（可选切 cwd）
/cancel /stop /abort          中断当前查询

/mode [strict|owner|all|reset]   本 chat 的回复模式
/acl [list|add|rm|clear]      本 chat 的额外允许用户
/bots [list|add|rm|clear]     本 chat 允许哪些 peer bot 触发

/update                       git pull + 重启
/restart                      重启

!<cmd>                        在 bot 部署机执行 shell（cwd 持久化）
```

## 主要环境变量

完整列表见 `.env.example`。摘要：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LARK_ACP_HOME` | `~/.lark-acp` | 状态目录（log / 配置 / session 绑定）|
| `LARK_ACP_DEFAULT_WORKDIR` | 启动 cwd | 新 chat 的默认 agent cwd |
| `ALLOWED_OPEN_IDS` | _(空)_ | 全局白名单（逗号分隔 open_id；空=INSECURE）|
| `OWNER_OPEN_ID` | _(空)_ | bot owner（owner 模式下不 @ 也能驱动 bot）|
| `BOT_OPEN_ID` | auto | 本 bot 在自己 app 命名空间下的 open_id（启动时自动取）|
| `BOT_APP_ID` | auto | 本 bot 自身 app_id（self-loop guard）|
| `REPLY_MODE` | `strict` | 全局默认回复模式（per-chat 用 `/mode` 覆盖）|
| `AGENT_DEFAULT` | `codex` | 全局默认 backend |
| `AGENT_TIMEOUT` | `0` | 单 prompt 客户端硬超时（秒，**0 = ∞**，靠 /cancel 中断）|
| `AGENT_IDLE_EVICT_SECS` | `900` | ACP 子进程空闲多久回收 |
| `AGENT_CANCEL_GRACE_MS` | `4000` | cancel 后等多久再 SIGKILL |
| `STREAM_FIRST_DELAY_MS` | `150` | 第一次 PATCH 卡片延迟 |
| `STREAM_INTERVAL_MS` | `800` | 后续卡片节流间隔 |
| `STREAM_HEARTBEAT_MS` | `5000` | 没新内容时心跳刷一次 |
| `LARK_BIN` | `lark-cli` | lark-cli 路径（PATH 找不到时显式指）|

## 状态文件

```
~/.lark-acp/
├── lark-acp.log                       业务日志
├── chat-workdirs.json                 per-chat agent cwd
├── chat-shellcwds.json                per-chat shell cwd
├── chat-modes.json                    per-chat reply mode 覆盖
├── chat-acl.json                      per-chat ACL 增量
├── chat-agents.json                   per-chat 当前 agent 选择
├── chat-models.json                   per-chat 当前模型偏好
├── chat-bot-allowlist.json            per-chat 允许的 peer bot app_id
└── lark-acp-sessions/<chatId>/<agent> ACP session id 持久化（每 backend 独立）
```

`/tmp/lark-acp-pipeline.pid` 是单实例锁，开机 cron 启动也只会有一个。

## 飞书应用权限

bot 能正常工作至少需要的 scope：

| 权限 | 用途 |
|---|---|
| `im:message.group_at_msg` | 收群里 @ 的消息（必需）|
| `im:message:send_as_bot` | 发消息（必需）|
| `im:message.group_msg` | 收群里所有消息（owner 模式 / bot-to-bot 必需）|
| `im:resource` | 下载附件 |
| `im:chat:readonly` | 取群名 |

事件订阅勾选：

- `im.message.receive_v1`
- `card.action.trigger`

## systemd 部署

`/etc/systemd/system/lark-acp.service`：

```ini
[Unit]
Description=lark-acp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/lark-acp
EnvironmentFile=/opt/lark-acp/.env
# nvm-installed node 不在 systemd 默认 PATH 里，按你机器的实际路径填
Environment=PATH=/root/.nvm/versions/node/v22.22.2/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/lark-acp/bin/lark-acp
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now lark-acp
journalctl -u lark-acp -f
```

注意：`/restart` `/update` 走 wrapper 脚本的 exit-99 自动重启循环，**不**触发 systemd `Restart=on-failure`（systemd 只兜底真正的崩溃）。

## 扩展：加一个新 Agent Backend

1. 在 `src/agents/<name>.ts` 定义 backend：

```ts
import type { AgentBackend } from "./types.js";
export const myBackend: AgentBackend = {
  name: "myname",
  label: "My Agent",
  resolveSpawn(cwd) {
    return { command: "my-acp-binary", args: [], env: {} };
  },
};
```

2. 在 `src/agents/registry.ts` 注册：

```ts
import { myBackend } from "./myname.js";
register(myBackend);
```

3. 完事 —— `/agent myname` 自动可用，`/model` `/resume` `/bind` 这些都按 backend ACP 自报的 capability 自动生效。

## 设计原则

**ACP-only for agent-facing concerns**：所有 "agent 相关" 的功能（消息流、用量统计、session 列表、模型切换、tool call 渲染）只通过 ACP 协议获取。**禁止**读 agent 的内部存储文件（`~/.claude/projects/*.jsonl`、`~/.codex/sessions/*.jsonl` 等）作为兜底。如果 ACP 没暴露某字段，就不显示 / 提示用户去给 backend 上游提 issue，不用 sidecar 抓取绕过。

这条规则保证：

- 同一份代码同时跑 codex / claude / 未来的 N 个 backend 都不需要写"如果是 X 就读 Y 文件"分支
- backend 升级换存储格式 / 加密 / 改路径，lark-acp 不会跟着崩
- 边界清晰：lark-acp 是 ACP client，只做 client 该做的事

## 项目结构

```
src/
├── index.ts             入口 + 单实例锁 + 事件分发 + 信号
├── config.ts            env + 路径常量
├── log.ts / lock.ts     日志 + PID 锁 + 原子写
├── state.ts             所有 chat-*.json 持久化
├── shell.ts             ! 命令实现（cwd 持久化）
├── lark.ts              飞书 API 包装 + 消息解析 + 附件下载
├── subscribe.ts         lark-cli event +subscribe 子进程管理
├── streaming.ts         StreamingReplier 卡片渲染
├── sessions.ts          (legacy: claude jsonl 读取，待迁移到 ACP)
├── usage.ts             jsonl 用量解析 + 价格表 (legacy)
├── commands.ts          所有 / 命令派发表
├── bridge.ts            askAgent: Feishu 消息 → ACP prompt
└── agents/
    ├── types.ts         AgentBackend 接口
    ├── registry.ts      backend 注册 / 查找
    ├── client.ts        ACP 子进程池 + JSON-RPC
    ├── codex.ts         Codex backend 定义
    └── claude.ts        Claude Code backend 定义

bin/
└── lark-acp             bash 启动器（exit-99 自动重启）
```
