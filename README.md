# lark-acp

> English · [中文](README.zh.md)

Bridge Feishu / Lark group and direct chats to any **ACP-compatible coding agent** (Codex, Claude Code, or anything that speaks [Agent Client Protocol](https://agentclientprotocol.com/)). Streaming cards, per-chat agent + model switching, ACL, systemd deploy, bot-to-bot relay.

## Supported agents

| Backend | npm package | Auth |
|---|---|---|
| `codex` | `@zed-industries/codex-acp` | ChatGPT login / `OPENAI_API_KEY` / `CODEX_API_KEY` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | `~/.claude/settings.json` `env.ANTHROPIC_*` |

Adding a new backend = registering an `AgentBackend` in `src/agents/registry.ts`. Commands, cards, and state files automatically pick it up. See [Adding a backend](#adding-a-new-agent-backend) below.

## Core capabilities

- **Feishu message → ACP `session/prompt`**, streamed back into a Feishu interactive card (thinking, tool calls, text chunks, cancel button, footer with model + context + tokens + cost + elapsed)
- **Multi-backend switch**: `/agent codex` `/agent claude`, persisted per chat
- **Multi-model switch**: `/model <id>` at runtime via ACP `unstable_setSessionModel`, persisted per chat
- **Session continuity**: after restart / idle eviction, automatic `session/load` — conversation history not lost
- **Shell passthrough**: `!<cmd>` runs on the bot host with cwd persisted across messages (`!cd /tmp` then later `!ls` is still in `/tmp`)
- **ACL**: global allowlist + per-chat additive list, unauthorized senders silently dropped
- **Bot-to-bot**: `/bots add cli_xxx` lets another Feishu app drive this bot (with self-loop guard)
- **Lifecycle**: `/restart` / `/update` (git fetch + ff-merge + restart), single-instance PID lock, orphan subprocess sweep
- **Attachments**: image / file / inline post images auto-downloaded into chat workdir, paths fed to the agent

## Quick start

```bash
git clone git@github.com:cafkagh/lark-acp.git
cd lark-acp
npm install

cp .env.example .env
# Edit .env, at minimum:
#   ALLOWED_OPEN_IDS, OWNER_OPEN_ID, BOT_OPEN_ID, BOT_APP_ID

./bin/lark-acp
```

Requires `lark-cli` installed and logged in with bot credentials — event subscription rides its WebSocket. (Note: this project uses a custom `lark-cli` with `+subcommand` syntax; the public `@larksuite/cli` package has a different command shape.)

## Auth setup

### Codex

```bash
codex   # one-time ChatGPT login
# or:
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

If running as root, add `IS_SANDBOX=1` to `.env` (Claude SDK refuses bypass-permissions under root without it).
If npm didn't install the right Claude binary for your platform, also add `CLAUDE_CODE_EXECUTABLE=/path/to/claude`.

## Commands

```
/help                         show this help
/pwd                          current chat's agent workdir + shell cwd
/status [all]                 process + agent + session + usage
/usage [all]                  alias for /status

/agent [name]                 view / switch backend (codex|claude|...)
/model [id|reset]             view / switch model on the current backend
/resume                       list sessions in current workdir
/resume <number|sid-prefix>   bind to a specific session
/bind <sid|prefix>            cross-workdir bind (auto switches cwd)
/new [path]                   start a fresh session (optionally switch cwd)
/cancel /stop /abort          interrupt the in-flight prompt

/mode [strict|owner|all|reset]   per-chat reply mode
/acl [list|add|rm|clear]      per-chat extra-allowed users
/bots [list|add|rm|clear]     per-chat allowed peer-bot app_ids

/update                       git pull + restart
/restart                      restart

!<cmd>                        run shell on the bot host (cwd persisted)
```

## Main env vars

Full list in `.env.example`. Highlights:

| Var | Default | Description |
|---|---|---|
| `LARK_ACP_HOME` | `~/.lark-acp` | State directory (logs, configs, session bindings) |
| `LARK_ACP_DEFAULT_WORKDIR` | startup cwd | Default agent cwd for new chats |
| `ALLOWED_OPEN_IDS` | _(empty)_ | Global allowlist (comma-separated open_id; empty = INSECURE) |
| `OWNER_OPEN_ID` | _(empty)_ | Bot owner (can drive bot without `@` in owner mode) |
| `BOT_OPEN_ID` | auto | Bot's own open_id in its own app namespace (auto-discovered at startup) |
| `BOT_APP_ID` | auto | Bot's own app_id (self-loop guard) |
| `REPLY_MODE` | `strict` | Global default reply mode (per-chat overridable via `/mode`) |
| `AGENT_DEFAULT` | `codex` | Default backend |
| `AGENT_TIMEOUT` | `0` | Hard client-side timeout per prompt (seconds; **0 = ∞**, rely on `/cancel`) |
| `AGENT_IDLE_EVICT_SECS` | `900` | Idle evict ACP subprocess after this many seconds |
| `AGENT_CANCEL_GRACE_MS` | `4000` | Wait this long after cancel before SIGKILL |
| `STREAM_FIRST_DELAY_MS` | `150` | Delay before first card PATCH |
| `STREAM_INTERVAL_MS` | `800` | Throttle between subsequent card updates |
| `STREAM_HEARTBEAT_MS` | `5000` | Re-flush card every N ms when no new content |
| `LARK_BIN` | `lark-cli` | Path to `lark-cli` binary (override if not on PATH) |

## State files

```
~/.lark-acp/
├── lark-acp.log                       runtime log
├── chat-workdirs.json                 per-chat agent cwd
├── chat-shellcwds.json                per-chat shell cwd
├── chat-modes.json                    per-chat reply-mode override
├── chat-acl.json                      per-chat ACL additions
├── chat-agents.json                   per-chat current backend
├── chat-models.json                   per-chat model preference
├── chat-bot-allowlist.json            per-chat allowed peer-bot app_ids
└── lark-acp-sessions/<chatId>/<agent> ACP session id (per backend)
```

`/tmp/lark-acp-pipeline.pid` is the single-instance lock — even with launchd / cron auto-start, only one process runs.

## Feishu app permissions

Minimum scopes for the bot to function:

| Scope | Purpose |
|---|---|
| `im:message.group_at_msg` | Receive @-mentioned group messages (required) |
| `im:message:send_as_bot` | Send messages (required) |
| `im:message.group_msg` | Receive all group messages (required for owner mode + bot-to-bot) |
| `im:resource` | Download attachments |
| `im:chat:readonly` | Read chat metadata (group name) |

Event subscriptions:

- `im.message.receive_v1`
- `card.action.trigger`

## systemd deploy

`/etc/systemd/system/lark-acp.service`:

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
# nvm-installed node isn't on systemd's default PATH; fill in your real path
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

Note: `/restart` / `/update` use the wrapper script's exit-99 auto-restart loop and **do not** trigger systemd `Restart=on-failure` (systemd only catches genuine crashes).

## Adding a new agent backend

1. Define the backend at `src/agents/<name>.ts`:

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

2. Register in `src/agents/registry.ts`:

```ts
import { myBackend } from "./myname.js";
register(myBackend);
```

3. Done — `/agent myname` is now available, and `/model` `/resume` `/bind` etc. light up automatically based on the capabilities the backend advertises in its ACP `initialize` response.

## Design rule: ACP-only for agent-facing concerns

All "agent-related" features (message stream, usage stats, session listing, model switching, tool call rendering) flow through the ACP protocol only. **Do not** read the agent's internal storage files (`~/.claude/projects/*.jsonl`, `~/.codex/sessions/*.jsonl`, etc.) as a fallback. If a field isn't exposed via ACP, surface that fact and ask users to file an issue with the backend instead — never bypass via sidecar scraping.

This rule guarantees:

- One codepath works across codex / claude / future backends — no `if (backend === "X") read Y` branches
- Backend upgrades that change storage format / encryption / paths don't break lark-acp
- Clean boundary: lark-acp is an ACP client, period

## Project layout

```
src/
├── index.ts             entry: single-instance lock + event dispatch + signals
├── config.ts            env vars + path constants
├── log.ts / lock.ts     logging + PID lock + atomic write
├── state.ts             all chat-*.json persistence
├── shell.ts             ! command (cwd persistence)
├── lark.ts              Feishu API wrappers + message parsing + attachment download
├── subscribe.ts         lark-cli event +subscribe subprocess management
├── streaming.ts         StreamingReplier — interactive card rendering
├── sessions.ts          (legacy: claude jsonl reader, slated for ACP migration)
├── usage.ts             jsonl usage parser + price table (legacy)
├── commands.ts          all slash-command dispatch
├── bridge.ts            askAgent: Feishu message → ACP prompt
└── agents/
    ├── types.ts         AgentBackend interface
    ├── registry.ts      backend registration / lookup
    ├── client.ts        ACP subprocess pool + JSON-RPC
    ├── codex.ts         Codex backend definition
    └── claude.ts        Claude Code backend definition

bin/
└── lark-acp             bash launcher (exit-99 auto-restart loop)
```
