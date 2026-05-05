# 调度系统设计（lark-acp scheduler）

> 状态：**设计完成，未实施**。等待方向确认后再开干。
> 最后讨论：2026-05

## 1. 目标

让 lark-acp 的用户**用自然语言**在 chat 里加定时任务，到点了 bot 自己执行 —— 既能"5 分钟后提醒我开会"这种简单提醒，也能"每周一 9 点扫昨天 PR 写周报"这种动态计算任务。

核心约束：

- ACP-only 原则不破坏（agent 相关都走 ACP）
- 不依赖 Anthropic 云 / 不依赖外部 cron 服务，**完全 lark-acp 部署机本地**
- 既支持用户加，也支持 agent 自己加（agent 触发的子任务）
- 重启 / idle evict / 机器重启都不丢任务

## 2. 一句话定位

**让 agent 当自然语言解析器，lark-acp 当执行引擎**。

```
[用户在 chat 说话]
    ↓
[agent 解析时间 + 动作 → 调 Bash 工具 → lark-acp-cli ...]
    ↓
[lark-acp engine: 持久化 + 定时触发]
    ↓
[到点了：发文本 OR 启 agent prompt]
    ↓
[卡片 / 文本到 chat]
```

LLM 负责**它擅长的**（语言 / 时间表达式理解、复杂任务分解、上下文沉淀）；engine 负责**它擅长的**（精确时间触发、持久化、单实例）。

## 3. Action 类型（决定一切的二元划分）

```ts
type Action =
  | { type: "text"; text: string }                // 静态字符串
  | { type: "prompt"; prompt: string;             // 动态 — 触发时跑 agent
      fromSessionId?: string;                     //   (可选) 接续指定 session
      cwd?: string;                               //   (可选) 工作目录
      agent?: "codex" | "claude" };               //   (可选) 临时换 backend
```

| 类型 | 触发时干啥 | 用什么 LLM | 适合 |
|---|---|---|---|
| `text` | 直接 `larkApi POST /messages` 发字符串 | **不调 LLM** | 写死内容的提醒（"开会"、"该下班了"）|
| `prompt` | 走 `bridge.askAgent()` 重新跑一轮 | 一次完整 ACP turn | 触发时才能算的任务（查 PR、看天气、扫日志、生成周报）|

agent 解析用户意图时自己判断走哪个：
- 用户说"提醒我看 PR #42" → text（内容已知）
- 用户说"看一下今天天气然后告诉我" → prompt（触发时才能查）

## 4. 数据模型

```ts
type Schedule =
  | { type: "at"; runAt: number }                 // 一次性，unix ms
  | { type: "cron"; expr: string };               // 周期，5 字段标准 cron

type Job = {
  id: string;                                     // uuid v4
  createdAt: number;
  createdBy:
    | { kind: "user"; openId: string }
    | { kind: "agent"; agent: string; viaUser: string };
  chatId: string;                                 // 触发时往哪发
  schedule: Schedule;
  action: Action;
  enabled: boolean;
  description?: string;                           // 用户原话 / agent 简述，给 /jobs 列表用
  lastRunAt?: number;
  nextRunAt: number;                              // engine 维护
  runCount: number;
  lastError?: string;                             // 失败时记
};
```

时区统一用 `LARK_ACP_TZ` 环境变量（默认 `Asia/Shanghai`）。源标签里也带 `tz=` 让 agent 解析时用对的偏移。

持久化在 `~/.lark-acp/schedules.json`（atomic write）。

## 5. 命令面

### 用户面（in chat）

- **加任务**：用自然语言描述，让 agent 解析并调 CLI（默认路径，不另外加 `/at` `/cron` 命令）
- **看队列**：`/jobs` 命令（直接列、不烧 LLM token）
  - `/jobs` — 列本会话的 jobs
  - `/jobs all` — 全部（admin only）
  - `/jobs rm <id-prefix>` — 删
  - `/jobs pause <id-prefix>` — 暂停
  - `/jobs resume <id-prefix>` — 恢复
  - `/jobs get <id-prefix>` — 详情

### Agent / Shell 面（CLI）

```bash
# 一次性
lark-acp-cli at "<when>" --chat <chat_id> [--tz <tz>] \
   ( --text "..." | --prompt "..." ) \
   [--description "..."] [--from-session <sid>] [--cwd <path>] [--agent codex|claude]

# 周期
lark-acp-cli cron "<5-field expr>" --chat <chat_id> [--tz <tz>] \
   ( --text "..." | --prompt "..." ) \
   [--description "..."] [--from-session <sid>] [--cwd <path>] [--agent ...]

# 管理
lark-acp-cli jobs list [--chat <chat_id>]
lark-acp-cli jobs rm <id-prefix>
lark-acp-cli jobs pause <id-prefix>
lark-acp-cli jobs resume <id-prefix>
lark-acp-cli jobs get <id-prefix>
```

`<when>` 接受：
- 相对秒数 / 分钟 / 小时 / 天：`30s` / `15m` / `1h30m` / `2d`
- 绝对 ISO 8601：`2026-04-30T09:00:00+08:00`

CLI 不再做高级自然语言时间解析（如"明天 9 点" "下周二"）—— **agent 是更强的解析器**，agent 自己把"明天 9 点"算成绝对 ISO 再传给 CLI。

## 6. CLI ↔ daemon 通讯

**原则：无 HTTP / 无 Socket / 无 RPC**，纯文件 + 信号。

1. CLI 把 Job 追加到 `~/.lark-acp/schedules.json`（atomic write）
2. CLI 给 daemon 发 `SIGUSR1`（PID 在 `/tmp/lark-acp-pipeline.pid`）
3. daemon 收 USR1 → 重 load schedules.json → 重排所有定时器

CLI 是个独立 tsx 脚本（`bin/lark-acp-cli`），跟 daemon 同机同 user 才能写 `~/.lark-acp/`、读 PID、发信号。**无远程支持**（要远程就 ssh 上去再跑 CLI）。

## 7. Engine 行为

启动时：

1. load `schedules.json`
2. 算每个 enabled job 的 nextRunAt（cron 用 `cron-parser`，at 直接读 `runAt`）
3. 取最近的 → `setTimeout` 到那个时间
4. 触发 → 执行 action → 更新 `lastRunAt` / `runCount` / `nextRunAt` → 持久化 → 重排

收 `SIGUSR1`：清当前 timer，重新 load + 重排。

边界处理：

| 场景 | 行为 |
|---|---|
| one-shot 时间在过去（漏触发）| 默认 skip + log；env `MISSED_FIRE=run` 可改成立即执行 |
| cron 永不再触发（过期表达式）| 标 expired，不再排，不删（用户 `/jobs rm`）|
| action 执行失败 | log + 写 `lastError`；one-shot 不重试，cron 下个周期再试 |
| 进程崩溃 | 重启时 reload 后正常排，错过的按"过去时间"规则 |
| 同时多个 job 触发 | 串行执行，避免并发卡片渲染冲突 |
| 同一 chat 多个 prompt 触发 | 走现有 `chatLocks` 排队，跟用户消息一起序列化 |
| 用户 `/cancel` | 中断**当前正在跑的** prompt 触发；下个 cron 周期照旧 |

## 8. action=prompt 的执行细节

构造一个虚拟事件喂给 `bridge.askAgent()`：

```ts
{
  chatId: job.chatId,
  prompt: job.action.prompt,
  fromSession: job.action.fromSessionId,    // 透传
  cwd: job.action.cwd ?? workdirFor(chatId),
  agent: job.action.agent ?? agentForChat(chatId),
  // 没有 user message → 卡片用 fresh-card 模式（直接 POST，不 reply）
  trigger: {
    kind: "schedule",
    jobId: job.id,
    scheduledBy: job.createdBy,
  },
}
```

差异点（vs 用户真实提问）：

- 没有 user `messageId` → `StreamingReplier` 走 fresh-card 模式（`POST /messages` 而不是 `reply/<msgId>`）
- 源标签：`[Feishu chat_id=... sender_kind=schedule scheduled_by=ou_xxx job=7c3f1a2]`
- 卡片 footer 加 `🕒 scheduled` 标识
- 取消按钮 owner 留空（任何 ACL 成员可点）
- agent 的 ACP session 优先级：`fromSessionId` > chat 当前 session > 新建

## 9. 复杂任务怎么扛

核心思想：**复杂度留给触发时，schedule 只是叫醒铃**。复杂任务 = 复杂用户提问；只要 agent 触发时能回到完整上下文，就跟用户实时提问一样能搞定。

4 个机制让 agent 拿到上下文：

### 9.1 接续 session（`--from-session`）

用户跟 agent 来回讨论了 30 分钟方法论 → 最后说"以后每周一这样跑一遍" → agent 把当前 session id 写入 schedule。触发时 engine 走 `session/load` 把那 30 分钟历史读回来。**复杂方法论 / 风格 / 偏好都不用复制粘贴进 prompt 字符串**。

### 9.2 长 prompt 字段

`schedules.json` 是 JSON，prompt 可以 8KB 多段指令 + 示例 + fallback 规则。无格式硬上限。

### 9.3 锁 cwd（`--cwd`）

复杂任务通常跟某个项目目录绑定。schedule 记下 cwd，触发时 ACP session 从这个 cwd 起 — agent 自动有 git / 文件 / 工具上下文，无需 prompt 里写"请 cd 到 /opt/...".

### 9.4 分解成多步 schedule（组合 > 扩展）

```
"每周一早上准备好周报，9:30 给我看"

agent 一次加两个 job：
  cron "0 9 * * 1"  --prompt "扫数据，写到 /tmp/report.md"           // 数据准备
  cron "30 9 * * 1" --prompt "把 /tmp/report.md 整理成卡片发到群里"  // 发布

第一个触发时只跑数据采集（不污染群聊）；
第二个 30 分钟后触发，文件已经在那里，agent 直接读。
```

engine 不需要懂"步骤依赖"——agent 通过文件系统 / 时间间隔自然组合。

### 9.5 不该硬扛的（让 agent 自己解决）

| 复杂场景 | engine 不加 | 让 agent 这么做 |
|---|---|---|
| 任务依赖另一个结果 | 不加 DAG / 链式 schedule | 写中间文件，下个 job 读 |
| 任务失败要重试 | 不加 retry 策略 | prompt 里写 try/catch："X 失败就降级到 Y" |
| 任务要审批 | 不加审批流 | 触发时先发"待确认"卡片，等用户后续消息 |
| 多人协作 | 不加分发 | 多个 schedule 各自往不同 chat 触发 |

## 10. Agent 怎么知道用 lark-acp-cli

在 `bridge.ts BOT_RELAY_PREAMBLE` 末尾追加一段说明：

```
## 调度任务

如果用户请求"X 时间后/每隔 X 时间 提醒/做 Y"，使用 lark-acp-cli 添加调度：

- 简单提醒（内容写死，触发时直接发）：
    lark-acp-cli at "<5m|1h|tomorrow|...>" --chat <chat_id> --text "..."
- 动态任务（触发时需要重新计算/查询）：
    lark-acp-cli at "<when>" --chat <chat_id> --prompt "..."
- 周期：lark-acp-cli cron "<5字段>" --chat <chat_id> ( --text | --prompt ) "..."
- 列表：lark-acp-cli jobs list --chat <chat_id>
- 删除：lark-acp-cli jobs rm <id-prefix>

chat_id 从源标签 [Feishu chat_id=...] 取。
时区按 LARK_ACP_TZ 环境变量（默认 Asia/Shanghai）。
"明天 9 点"等自然语言时间，由你（agent）转换成绝对 ISO 再传给 CLI。

调用后给用户简短回执（"好的，X 时间提醒"），不要重复用户原话。
触发时若收到的源标签里 sender_kind=schedule，不要再重复加新调度（避免循环）。
```

## 11. 安全与隔离

- **ACL 沿用现有**：用户加 schedule 必须先过 chat ACL（agent 走的 CLI 也是 user 触发的，统一）
- **跨 chat 调度禁止**：默认 `--chat` 只能是当前 chat 或当前 user 在的 chat。`--chat` 给非当前 chat 时校验 user 是不是那个 chat 的成员。admin 可破。
- **self-loop 防护**：`sender_kind=schedule` 让 agent 知道是定时触发，preamble 里明确"不要在这个 turn 里再加新调度"
- **Job 数量上限**：默认 100 jobs / chat，1000 / 全局。防止 agent 失控狂加。

## 12. 工程量

| 模块 | 行数 | 时间 |
|---|---|---|
| `src/schedule/types.ts` — Job + Action 类型 | 30 | — |
| `src/schedule/store.ts` — load/save + atomic + signal-reload | 90 | 0.4h |
| `src/schedule/parse.ts` — `<when>` 相对/ISO 解析 + cron 校验 | 100 | 0.4h |
| `src/schedule/engine.ts` — timer + dispatch + 边界处理 | 180 | 0.8h |
| `src/schedule/exec.ts` — 执行 text / prompt action | 100 | 0.4h |
| `src/streaming.ts` — fresh-card 模式适配 | 30 | 0.3h |
| `src/commands.ts` — `/jobs` 子命令 | 100 | 0.4h |
| `src/index.ts` — `SIGUSR1` reload + 启动加载 | 30 | 0.2h |
| `src/bridge.ts` — `BOT_RELAY_PREAMBLE` 加调度章 | 5 | 0.1h |
| `bin/lark-acp-cli` — 二进制（at + cron + jobs 子命令） | 150 | 0.7h |
| 端到端测试 + 部署 | — | 0.5h |
| **合计** | **~815** | **~4.2h** |

新依赖：`cron-parser`（轻量，~30KB）。

## 13. 决策点清单

| # | 问题 | 默认 | 备选 |
|---|---|---|---|
| 1 | 时间表达式解析放哪 | agent 解析（最强）| `chrono-node` 库（+200KB） |
| 2 | 是否加 `/at` `/cron` typed 命令 | **不加**（NL 路径替代）| 加（power user）|
| 3 | 时区配置粒度 | 全局 env | 每 job 独立 |
| 4 | text / prompt 怎么判断 | agent 自决 | CLI 默认 text，要 prompt 必须显式 |
| 5 | 跨 chat 调度 | 默认禁止 | admin 可显式破 |
| 6 | action=prompt 触发的 token 预算显示 | v1 不显示 | `/jobs list` 里加预估 cost |
| 7 | 长触发卡片（>30min） | 任其流式刷新 | 超时自动收起改发文本 |
| 8 | Job 数量上限 | 100/chat, 1000/全局 | 不限 |

## 14. v1 / v2 切分建议

**v1（先做）**：
- text + prompt action 类型
- at + cron schedule 类型
- `--from-session` `--cwd` 关键参数
- `/jobs list/rm/pause/resume`
- agent 通过 BOT_RELAY_PREAMBLE 学会用 CLI

**v2（后看需求）**：
- 加 typed `/at` `/cron` 命令（如果发现 power user 需求）
- 通过 ACP MCP server 暴露 `schedule_add` 等 tool（替代 CLI shell-out，更优雅）
- token budget 估算 + 显示
- 长触发卡片自动收起
- 跨 chat 调度的细粒度权限

## 15. ACP-only 原则审查

| 模块 | 是否走 ACP | 评估 |
|---|---|---|
| schedule store | 不涉及 agent | ✅ 不冲突（lark-acp 自己的状态）|
| action=text 触发 | 不涉及 agent | ✅ 完全本地 |
| action=prompt 触发 | 走 `bridge.askAgent` → ACP `session/prompt` | ✅ 符合规则 |
| agent 加 schedule | 通过 Bash tool 调本地 CLI | ✅ Bash 是 agent 自有能力，CLI 是 lark-acp 的旁路写自己状态文件，**不破坏 ACP 通道** |
| `--from-session` | 走 ACP `session/load` | ✅ |
| `/jobs` 命令 | 全本地 JSON 读写 | ✅ |

唯一边界：v2 想用 MCP server 让 agent 通过协议调用而不是 Bash —— 那是 agent-facing 接口，要走 ACP / MCP 标准。**v1 先 Bash，省事**。

## 16. 不做的（明确划界）

- ❌ Anthropic 云端 scheduled agent（与本地 lark-acp 解耦的远程 cron）—— 用户不要"远程跑"，要本地能管
- ❌ 内建 retry / 重试策略 —— agent 自己写在 prompt 里
- ❌ 任务依赖 / DAG —— 用文件系统 + 时间间隔组合
- ❌ Web UI 管理面板 —— `/jobs` 命令够用
- ❌ 多人审批流 —— 复杂业务交给 agent prompt 自己写
- ❌ 高级 cron（毫秒、随机抖动、节假日跳过）—— `cron-parser` 标准能力够用

## 17. 已沉淀的设计原则相关

- 沿用 [memory: ACP-only for agent-facing concerns]：agent 出口走 ACP，不读 agent 内部存储
- 复用现有基础设施：chatLocks、StreamingReplier、原子写、PID 锁
- 跟 recall 功能一样的设计风格：per-chat 状态文件、SIGUSR1 reload（之前没这个机制，新加）

---

## 附录 A：3 种典型场景示例

### A.1 简单提醒

> 用户："5 分钟后提醒我看 PR #42"

```
agent → Bash: lark-acp-cli at "5m" --chat oc_xxx \
              --text "📝 提醒：看 PR #42" \
              --description "5 分钟后提醒看 PR #42"
agent → user: "好的，5 分钟后提醒。job `7c3f1a2`"

[5 min later]
engine: text action → larkApi POST → "📝 提醒：看 PR #42"
```

### A.2 周期动态任务

> 用户："每天下午 5 点扫一下今天 GitLab 上谁的 MR 还没被 review，发个排行榜"

```
agent → Bash: lark-acp-cli cron "0 17 * * *" --chat oc_xxx \
              --cwd /opt/our-repos \
              --prompt "调 GitLab API 列今天创建/更新的 MR，按
                        '无 review approve 数 + 等待时长' 排序，
                        前 10 名生成 markdown 表格发到群里。
                        MR 链接要带提交人 @。" \
              --description "每天 17:00 MR 排行榜"
agent → user: "好的，每天 17:00 自动跑 MR 排行榜"

[每天 17:00]
engine: prompt action → bridge.askAgent → ACP session/prompt
        → agent 跑 GitLab API → 生成 markdown
        → 卡片渲染到群里（footer 带 🕒 scheduled）
```

### A.3 沉淀方法的接续

> 你跟 agent 聊了 30 分钟"代码 review 方法"
> 最后说："以后每天下班前用这套跑一遍"

```
agent（知道当前 ACP session id）→ Bash:
  lark-acp-cli cron "0 18 * * 1-5" --chat oc_xxx \
    --from-session 019dc8bf-... \
    --cwd /opt/our-repos \
    --prompt "按今天讨论的代码 review 方法，扫今天的提交并发到群里" \
    --description "工作日 18:00 自动 code review"
agent → user: "好的"

[每周一-五 18:00]
engine: prompt action → bridge.askAgent
        → ACP session/load(019dc8bf-...) 接续 30 分钟讨论历史
        → agent 触发 prompt（带完整方法论上下文）
        → 卡片到群里
```

## 附录 B：开发顺序建议

如果未来要开干，按以下顺序最不容易翻车：

1. `schedule/types.ts` + `schedule/store.ts` — 数据模型 + 持久化（独立可单元测）
2. `schedule/parse.ts` — `<when>` 解析 + cron 校验（纯函数，可单测）
3. `schedule/engine.ts` — 定时器 + 触发派发（用 mock action 验流程）
4. `schedule/exec.ts` — 接 lark.ts 发 text + 接 bridge.askAgent 跑 prompt
5. `streaming.ts` fresh-card 适配
6. `index.ts` 启动加载 + SIGUSR1 handler
7. `commands.ts` `/jobs` 子命令
8. `bin/lark-acp-cli` 写 + 测
9. `BOT_RELAY_PREAMBLE` 加调度章，端到端真机测
