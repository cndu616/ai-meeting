# AI Meeting 设计文档

日期：2026-10-10
状态：**已被实际实现取代（2026-10-11 标注，仅作史料）**——权威现状见 `2026-10-11-persistent-streaming-design.md`（常驻流式会话架构及其 2026-10-11 代码讨论会修订）。本文的「轮流发言 + 短连接会话」等设计已整体为自由响应模式取代，勿据此理解现行系统。

## 1. 概述

多 Agent 会议系统：多个平等的 AI agent 围绕共同话题在聊天室中讨论，用户以群聊参与者 + 私聊对象的双重身份介入。基于 Claude Agent SDK（TypeScript）实现，agent 具备代码探索与读写能力，会议完整持久化、可召回继续。

核心使用场景：围绕代码库的技术评审（多立场 agent 辩论架构决策、方案取舍，能实际读代码验证观点），但架构保持通用，话题不强制绑定代码库。

## 2. 已确认的需求决定

| 维度 | 决定 |
|------|------|
| 场景 | 代码库评审为主，架构通用 |
| 技术栈 | TypeScript 全栈（Claude Agent SDK TS 版） |
| 发言机制 | 轮流发言 + 可跳过，系统层公平调度 |
| 召回语义 | 可继续开会（恢复完整会话状态） |
| 代码权限 | 会议指定工作区目录，工具限制在内，自动批准 |
| 会议规模 | 典型 3-5 个 agent，上限 8 |
| 工具可见性 | 工具调用不进聊天室，仅 agent 卡片状态提示 |
| 用户身份 | 群聊参与者（聊天室发言）+ 每个 agent 的私聊对象 |

## 3. 总体架构

单用户本地工具：一台机器一个用户使用，SSE/接口不做多用户鉴权。

```
┌─────────────────────────────────────────────┐
│ Next.js 应用（单项目）                        │
│                                             │
│  浏览器 UI ──SSE──▶ API Routes ◀──POST── 用户输入 │
│  (聊天室/私聊/     │                        │
│   会议管理)        ▼                        │
│              会议引擎 (MeetingEngine)          │
│              · 生命周期状态机                  │
│              · 轮次调度（轮流+可跳过）            │
│              · 事件广播 → SSE                 │
│                 │                           │
│                 ▼                           │
│           AgentRunner × N                    │
│           每个封装一个 Claude Agent SDK 会话     │
│           (工具 cwd=工作区，自动批准)            │
│                 │                           │
│                 ▼                           │
│           SQLite + Drizzle (会议/消息/参与者)    │
└─────────────────────────────────────────────┘
```

分层原则：`src/core`（会议引擎）不依赖 Next.js，可独立测试；API Routes 只是薄薄的转接层。

## 4. 数据模型

| 表 | 关键字段 | 说明 |
|---|---|---|
| `agents` | name, capability, description, persona, avatar | agent 库，由 `agents/*.json` 配置文件启动时导入 |
| `meetings` | title, topic, workspace_path, status, max_rounds, current_round, created_at | status: `active` / `paused` / `ended` |
| `participants` | meeting_id, agent_id, meeting_role, sdk_session_id, speak_order, last_injected_msg_id | 会议角色（派别/立场）+ SDK 会话 ID（召回关键）+ 注入水位 |
| `messages` | meeting_id, channel(`chatroom`/`dm`), agent_id, content, round, kind, created_at | kind: `speech` / `user` / `system` / `dm_user` / `dm_agent` |
| `dm_threads` | meeting_id, agent_id | 用户与每个 agent 的私聊线索（UI 定位用） |

agent 配置文件示例（`agents/dev.json`，zod 校验）：

```json
{
  "name": "老王",
  "capability": "研发",
  "description": "资深后端工程师，重视架构简洁性和可维护性",
  "persona": "你是一名资深后端工程师……（能力人设 system prompt 片段）",
  "avatar": "🐧"
}
```

System prompt 组装：`persona`（常规能力）+ 会议上下文（话题、参与者名单）+ `meeting_role`（会议角色/派别/立场）+ 行为规则（轮流发言、[SKIP] 约定、发言要简洁等）。

## 5. 会议流程状态机

```
创建会议（话题+工作区+选agent+配会议角色）
        │ 开始
        ▼
   ┌─ active ──────────────────────────┐
   │  system 开场消息（话题+参与者介绍）      │
   │  循环: 轮次 round = 1..max_rounds    │
   │    for agent in speak_order:        │
   │      注入新消息 → SDK 发言 → 存库/推送  │
   │      (回复 [SKIP] 则跳过)             │
   │  轮间检查: 用户暂停? 达到 max_rounds?   │
   └────────────┬───────────────────────┘
        暂停│结束（用户手动 / 轮数用尽）
            ▼
   paused ──(召回)──▶ active：resume 各 agent 的 SDK 会话，继续下一轮
   ended：只读，可导出
```

- 用户聊天室插话不打断当前轮：消息存库并实时显示，在下一次注入时进入所有 agent 的视野
- max_rounds 用尽后用户可「追加轮数」继续
- 创建会议时校验工作区路径有效性，无效则拒绝

## 6. Agent 发言管线

轮到某 agent 发言时：

1. **收集增量**：从 DB 取该 agent 上次注入以来新的 `chatroom` 消息（其他 agent 发言、用户插话、系统通知），以 `last_injected_msg_id` 为水位
2. **组装注入**：转述格式 + 轮次指令，示例：

```
[chatroom 老王·研发·激进派] 旧模块的耦合度被高估了，我看了 auth 模块……
[chatroom 用户] 你们先看看测试覆盖率再说
[user 私信→你] （仅当有排队私信时出现）
[system] 第 3 轮，轮到你发言。基于以上最新讨论，发表你的观点；
         若无话可说只回复 [SKIP]。
```

3. **调用 SDK**：`session.query()` 流式接收；文件工具 `cwd` 锁定会议工作区、自动批准
4. **工具隔离**（关键约束）：工具调用不产生聊天室消息，仅通过 SSE 状态事件在 agent 卡片显示实时状态（如「正在读 `src/auth.ts`」）；最终文本作为 `kind=speech` 消息存库并推送聊天室
5. **跳过**：回复文本 trim 后为 `[SKIP]` 则视为跳过，记一条轻量系统消息，不推送发言
6. 操作过程的披露是对话行为：其他参与者想了解某 agent 做过什么操作，直接问它，agent 将其会话内的工具历史作为普通文字发言描述（工具历史天然保留在其 SDK 会话上下文中）

## 7. 私聊机制

- 用户点 agent 卡片「私聊」→ 右侧抽屉面板
- 私信注入该 agent 的**同一个 SDK 会话**（`[user 私信→你]` 前缀），回复存 `channel=dm`，仅推送私聊面板，不进聊天室流
- 其他 agent 永远看不到 dm 消息（增量收集按 channel=chatroom 过滤）
- 时序：agent 会议发言中收到私信 → 排队，随下一次注入一起送达
- 同一上下文的涌现效果：agent 在私聊里得到的指示会影响其会上立场

## 8. 实时通信

- **SSE**（`GET /api/meetings/:id/events`）：新消息、agent 状态变化（思考中/使用工具/发言中/空闲）、轮次事件
- **POST**：用户发言、私信、暂停/继续/结束、追加轮数
- 进程内事件总线（`src/lib/events.ts`），无外部依赖

## 9. UI 设计

```
┌──────────┬──────────────────────────┬─────────┐
│ 会议信息   │  聊天室消息流                │ 私聊抽屉  │
│ 话题/轮次  │  老王·研发·激进派            │ (按需展开)│
│          │  旧模块耦合度被高估……         │         │
│ Agent列表 │                          │ 和老王私聊 │
│ 老王 🔵   │  小李·测试·保守派            │ …       │
│ ·研发·激进 │  我跑了测试，覆盖率高……       │         │
│ (状态行)  │                          │         │
│ 小李 🟢   │  [ 输入框……        发送 ]   │         │
└──────────┴──────────────────────────┴─────────┘
```

- agent 卡片：头像、名字、能力、会议角色（派别）、实时状态行（空闲/思考中/正在读 xx 文件/发言中）
- 聊天室消息：agent 消息带头像+角色标签，用户消息右对齐，系统消息居中灰字
- 页面：会议列表页（新建/召回/继续/查看）→ 创建向导（话题、工作区路径、选 agent、逐个配会议角色）→ 会议房间页

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| agent 发言 SDK 调用失败 | 重试 1 次；仍失败则该轮跳过 + 系统消息提示，会议继续 |
| 进程重启/会议中断 | 状态全在 DB；「继续会议」按 `sdk_session_id` resume 各会话，从 `current_round` 续开 |
| 工作区路径无效 | 创建会议时校验，拒绝创建 |
| 私信排队积压 | 注入时合并打包（本地工具，规模可控） |
| max_rounds 用尽仍想继续 | 「追加轮数」操作 |

## 11. 测试策略

- **单元测试**（Vitest）：轮次调度器（纯逻辑：跳过/轮数/顺序）、注入组装器（增量收集、channel 过滤、格式化、[SKIP] 识别）
- **集成测试**：mock SDK 查询接口，跑完整会议管线（创建→2 轮→暂停→继续→私聊）
- **手动 E2E**：真实 API key 跑一场 3 agent 会议验收

## 12. 项目结构

```
ai-meeting/
├── src/
│   ├── app/                      # Next.js
│   │   ├── page.tsx              # 会议列表
│   │   ├── meetings/new/page.tsx # 创建向导
│   │   ├── meetings/[id]/page.tsx# 会议房间
│   │   └── api/meetings/…        # REST + SSE
│   ├── core/                     # 会议引擎（不依赖 Next，可独立测试）
│   │   ├── engine.ts             # 生命周期 + 轮次调度
│   │   ├── injector.ts           # 增量收集 + 注入组装
│   │   └── agent-runner.ts       # SDK 会话封装（resume/工具配置/流式）
│   ├── db/                       # Drizzle schema + client + 迁移
│   ├── lib/events.ts             # 进程内事件总线
│   └── components/               # 聊天室/agent 卡片/私聊抽屉等
├── agents/                       # agent 配置文件（JSON，启动时导入）
│   ├── dev.json  test.json  debate.json  analyst.json …
├── data/                         # SQLite（gitignore）
└── drizzle.config.ts
```

## 13. 技术选型汇总

Next.js 15 + TypeScript + Claude Agent SDK（TS）+ Drizzle ORM + SQLite + Tailwind CSS + Vitest
