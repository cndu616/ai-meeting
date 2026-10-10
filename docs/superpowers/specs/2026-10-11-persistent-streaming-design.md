# 自由响应式会议：常驻流式会话架构设计

日期：2026-10-11
状态：已与用户逐节确认
前置文档：`2026-10-10-ai-meeting-design.md`（本设计取代其中「轮流发言 + 短连接会话」部分，其余部分继续有效）

## 背景与动机

现状（v1）：轮到某 agent 发言时，为它启动一个短生命周期的 CLI 子进程（resume 上一轮 sessionId），单轮结束后进程退出；DM 在会议进行中要排队到该 agent 下一次轮到发言才处理。用户反馈：**短连接 + 排队响应太慢**，要求发言结束后进程不退出、持续接收消息、保持长连接、及时响应。

用户决策（brainstorming 确认）：

1. **发言机制：自由响应模式**——聊天室里任何人（agent/用户）发的消息实时推送给所有其他 agent，agent 自主决定回应或沉默。无轮次、无固定顺序。
2. **秩序手段：禁言按钮**——用户作为主持人可禁言某 agent；被禁言者仍收到全部消息（上下文不断档），但推送时附加禁言提示，令其回复 [SKIP]。
3. **会议控制：完全自由 + 手动结束**——无轮数/条数限制，节奏由用户用发言、禁言/解禁、暂停来驾驭，结束由用户手动触发。
4. **成员模型：模板与实例分离**——agent 模板是岗位画像（研发/测试/架构师…），**不含名字**；添加成员时选择模板、设置名字、设置该成员在会议中的目标。
5. **动态添加成员**——会议进行中可随时加人；新成员入会时被告知会议基本信息并收到全部历史消息。

## 成员模型：模板与实例分离

- **模板（agents 表 / agents/*.json）**：岗位画像。字段 `{ id, capability, description, persona, avatar }`——**没有 name**。capability 即岗位名（研发、测试、架构师…），persona 描述该岗位的行为风格与专业倾向，avatar 为默认头像。
- **参会者实例（participants 表）**：一场会议里的一个"人"。`{ templateId, displayName, goal }`——displayName 是用户起的名字（张工、李工…），goal 是该成员在会议中的目标/立场（如「激进派：主张全面重写」），meetingRole 字段更名为 goal。
- **同一模板多实例**：两个成员可以都基于「研发」模板，名字和目标不同——这正是模板/实例分离的意义（v1 中用户为加第二个研发被迫复制 JSON 的痛点消失）。
- **引用统一按实例**：消息发言者、DM 目标、状态卡片、禁言开关、AgentSession 归属，全部以 participantId 标识，不再用模板 id。聊天室消息前缀形如 `[chatroom 张工·研发]`（displayName·capability）。
- 内置模板文件重写为无名字岗位模板（研发、测试、架构师、评审、分析等）；用户此前手写的 dev2/dev3 复制模板随之删除。

## SDK 能力依据（已在 node_modules 类型定义中核实）

- `query({ prompt: AsyncIterable<SDKUserMessage>, options })`：prompt 传一个永不结束的异步消息队列，CLI 子进程常驻。
- 每推入一条 `SDKUserMessage`（`{ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }`）触发一轮处理；agent 忙时推入的消息由 SDK 原生排队到当前轮结束后立即处理——**应用层无需任何排队逻辑**。
- 输出流逐条迭代：`system/init`（记 sessionId）、`assistant`（tool_use → 状态卡片）、`result`（本轮结束信号，含最终文本与新 sessionId）。
- `options.resume` 仍可用于进程重建时接上原会话链。
- `query.interrupt()` 可打断当前轮（本设计暂不使用，留作扩展）。

## 架构总览

```
用户消息 ──► API ──► DB 落库（messages 表）
                        │
                        ▼
                  消息分发器（engine 内）
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   AgentSession     AgentSession     AgentSession
   (张工·常驻进程)  (李工·常驻进程)  (…常驻进程)
        │
        ├─ 推入消息队列 → CLI 处理一轮 → 流式输出
        ├─ assistant 工具调用 → 状态卡片（不进聊天室）
        └─ assistant 最终发言 → 落库 → 回到分发器 → 触发其他 agent
```

会议是一条自驱动的消息流：开场推送是「火花」，此后每条落库消息经分发器推向各 agent，agent 的发言又成为新的触发，由用户用发言/禁言/暂停驾驭全局。

## 组件设计

### AgentSession（新文件 `src/core/agent-session.ts`）

每个参与者一个实例，封装一个常驻 CLI 进程：

- `start()`：以「永不结束的异步队列」为 prompt 启动 `query()`；options 含 systemPrompt、cwd、permissionMode、resume（重建时接续会话链）。内部启动消费循环。
- `push(text)`：把一条消息放入队列。若 CLI 正在处理，SDK 自动排队。**调用方永远不必等待**。
- `close()`：结束队列迭代并清理进程。幂等。
- 消费循环逐条处理输出：`system/init` → 记录 sessionId（经回调交 engine 落库）；`assistant` 的 tool_use → 经回调更新状态卡片事件；`result` → 提取最终发言文本（[SKIP] 判定沿用 `isSkip`），经回调交 engine 落库与分发；空文本/提取失败视作 [SKIP]。
- **崩溃兜底**：消费循环意外抛错或自然结束且会议未结束时 → 用 resume 自动重建进程一次，并按水位线补发崩溃期间错过的增量；重建仍失败 → 该 agent 标记掉线（状态卡片展示），不再推送，不影响其他 agent 与会议本身。

对 engine 而言 AgentSession 是纯注入依赖（构造函数传入工厂），测试中以 mock 替换。

### MeetingEngine 改造（`src/core/engine.ts`）

- 删除：`runLoop`、`loops`（pause 标志对象）、`pendingDms` 队列、`processPendingDms`、轮次计数与 `maxRounds` 自动暂停逻辑、`extendRounds`。
- 新增：`sessions: Map<participantId, AgentSession>` 与统一分发器 `dispatch(message)`。
- 分发规则（核心语义）：

| 事件 | 落库 | 推送给谁 | 备注 |
|---|---|---|---|
| start 开场 | 系统消息 | 全员（开场指令） | 连锁反应的火花；禁言附加逻辑统一适用 |
| 用户聊天室消息 | ✓ | 所有 agent | 禁言者附加禁言提示 |
| agent 发言 | ✓ | 其他所有 agent | 发言者不推给自己 |
| agent 回 [SKIP] | ✗ | 无人 | 防止连锁空转 |
| 用户 DM | ✓ | 仅目标 agent | 即时响应（排队到其当前轮结束） |
| agent 的 DM 回复 | ✓ | 仅用户（SSE 送达） | |
| 新成员入会 | 系统消息 | 仅新成员（入会指令+全部历史） | 现有 agent 不推送，经新成员自我介绍自然感知 |
| system 消息 | ✓ | 无人推送 | 仅展示 |

- **动态添加成员 `addParticipant(meetingId, { templateId, displayName, goal })`**：
  - 校验：会议未结束、当前总人数 ≤ 8、displayName 与 goal 非空。
  - 落库 participant（muted=0，lastInjectedMsgId=0，speakOrder 末位）；落库 system 消息「displayName 加入会议」。
  - 会议 active 时：创建并启动新 AgentSession（全新会话，无 resume），推送**一条合并的入会消息**：会议基本信息（主题、现有成员名单及各自目标、工作区）+ 中途加入说明 + 该成员自己的名字与目标 + 按时间序的全部历史聊天室消息（复用消息行格式，水位线从 0）+「请先简短自我介绍并给出初步观点」。此后纳入正常分发。
  - 会议 paused 时：仅落库，resume 时与其他成员统一重建并补发。
- `createMeeting` 输入相应变化：`participants: [{ templateId, displayName, goal }]`（不再有 maxRounds）。

- 禁言：`setMuted(meetingId, participantId, muted)` 更新 participants.muted；推送时若禁言，在消息末尾拼接：「（你现在被主持人禁言，请勿发言，直接回复 [SKIP]，并记住该消息作为上下文）」。
- `start`：status=active、落库系统消息、为每个参与者创建并启动 AgentSession、推送开场指令。
- `pause`：关闭所有 AgentSession（省资源），status=paused；期间消息照常落库但不推送。
- `resume`：status=active、为每个参与者重建 AgentSession（resume 各自 sdkSessionId）、按 lastInjectedMsgId 补发暂停期间增量、推送「会议恢复」指令。
- `end`：关闭全部进程、status=ended、落库结束系统消息。
- **服务器重启恢复**：engine 初始化/启动时扫描 status=active 的会议，走与 resume 相同的重建+补发路径（同一代码路径，统一语义）。
- `buildSystemPrompt`：persona 取自模板，身份用「displayName（capability）」自指，目标取该实例的 goal；行为规则改写为自由响应语义：收到消息后自主判断是否有值得说的，没有则回 [SKIP]；保持简短、有观点、不重复别人说过的。
- 水位线语义变更：`lastInjectedMsgId` 不再用于轮询收集，仅用于补发（暂停期间/崩溃期间错过的消息）。

### 数据模型变更（`src/db/schema.ts`）

项目处于开发期、无生产数据，直接改 schema 重新生成迁移，不做兼容：

- `agents`（模板表）：**删除 `name`**；保留 `id`（slug）、`capability`、`description`、`persona`、`avatar`。
- `meetings`：删除 `maxRounds`、`currentRound`；status 仍为 `active/paused/ended`（默认 paused 不变）。
- `participants`：`agentId` 更名 `templateId`；`meetingRole` 更名 `goal`；新增 `displayName`、`muted INTEGER NOT NULL DEFAULT 0`；保留 `sdkSessionId`、`lastInjectedMsgId`、`speakOrder`（speakOrder 仅用于 UI 稳定排序，不再驱动发言顺序）。
- `messages`：`agentId` 更名 `participantId`（speech/dm_agent 时=发言者实例；dm 时=私聊目标实例；user/system 为 null）；删除 `round` 字段。

### API 变更（`src/app/api/`）

- 创建会议：请求体去掉 `maxRounds`；participants 改为 `{ templateId, displayName, goal }`。
- 新增 `POST /api/meetings/:id/participants`，body `{ templateId, displayName, goal }`——动态添加成员。
- 新增 `PATCH /api/meetings/:id/participants/:participantId`，body `{ "muted": true|false }`。
- 其余路由不变；SSE 事件类型为 `message` / `agent_status` / `meeting_status` / **`participant`（新增：成员入会，携带实例信息，UI 增量渲染卡片）**，删除 `round` 类型（轮的概念消失）。

### UI 变更（`src/app/`、`src/components/`）

- 创建会议页（/meetings/new）：从「勾选固定 agent」改为「逐个添加成员：选模板 + 填名字 + 填目标」，支持同一模板添加多个实例。
- 房间页：新增**「+ 添加成员」按钮与弹窗**（模板下拉、名字、目标），入会后卡片实时出现（SSE participant 事件）。
- AgentCard：显示 displayName + capability + goal；移除「轮到谁发言」高亮与轮次展示；新增**禁言/解除禁言按钮**与状态徽标；实时状态机：`空闲 → 思考中 → 使用工具中（工具卡片） → 发言落库 → 空闲`，另支持 `被禁言`、`掉线`。
- ChatPanel / DmDrawer：消息与私聊对象均按 participant 实例展示；DM 响应从「排队等待」变为即时到达，体验自然提升。
- 输入框不变。

## 错误处理汇总

- AgentSession 崩溃：自动 resume 重建一次 + 水位线补发；再失败标记掉线，隔离故障不影响整场会议。
- 发言提取为空：视作 [SKIP]，不落库不分发（不重试，避免无意义的连锁模型调用）。
- 结束/暂停时对已死进程 close：幂等，静默。
- resume 时 sdkSessionId 为空（如从未发言）：视作全新会话启动。

## 测试策略（vitest，沿用 TDD）

- **AgentSession 单测**：mock SDK `query`——伪造异步队列与可控输出流，验证：push 触发一轮处理并产出发言回调；[SKIP] 与空文本路径；close 幂等；消费循环异常时 resume 重建并补发；重建失败转掉线回调。
- **Engine 单测**：注入 mock AgentSession 工厂，验证分发矩阵（上表全部行）、禁言提示拼接、[SKIP] 不再分发、动态添加成员（active 时启动+合并入会消息+全部历史补发；paused 时仅落库）、同一模板双实例互不混淆、pause 关闭全部进程、resume 重建+补发增量、end 清理、开场推送。
- **既有测试处置**：`engine-loop`/`engine-dm`/`engine-control` 按新语义重写；`agent-config` 测试随模板去 name 调整；`a-batch-race-repro.test.ts` 针对的 pause→resume 窗口竞态源于旧轮询循环的 loops 生命周期，新架构中该机制整体消失，测试按新语义（pause 关进程 → resume 重建）重写后自然转绿，同时删除 `tests/README.md` 中「保持红」的说明。
- **API/UI 测试**：沿用现有 mock 模式，新增动态添加成员与禁言路由用例。

## 非目标（明确不做）

- @提及定向触发（可作为后续迭代）
- 冷场自动催场
- 发言总量保险丝
- interrupt() 打断正在进行的轮次
- 成员移除（禁言已是软手段，留待真实需要再做）
- 会话内容摘要/压缩（上下文过长治理留待实际遇到再做）

## 迁移与兼容

开发期项目：改 schema → drizzle-kit 重新生成迁移 → 删除旧开发库文件重建。不做数据迁移、不做 v1 兼容层。
