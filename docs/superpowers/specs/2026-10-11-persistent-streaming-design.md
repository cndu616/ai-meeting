# 自由响应式会议：常驻流式会话架构设计

日期：2026-10-11
状态：**已实施**。2026-10-11 代码讨论会五项决议的实施修订已回写正文（见文末「实施修订记录」），本文是系统当前行为的权威描述；与实现冲突的历史表述以正文现行版为准。
前置文档：`2026-10-10-ai-meeting-design.md`（已被实际实现取代，仅作史料）

## 背景与动机

现状（v1）：轮到某 agent 发言时，为它启动一个短生命周期的 CLI 子进程（resume 上一轮 sessionId），单轮结束后进程退出；DM 在会议进行中要排队到该 agent 下一次轮到发言才处理。用户反馈：**短连接 + 排队响应太慢**，要求发言结束后进程不退出、持续接收消息、保持长连接、及时响应。

用户决策（brainstorming 确认）：

1. **发言机制：自由响应模式**——聊天室里任何人（agent/用户）发的消息实时推送给所有其他 agent，agent 自主决定回应或沉默。无轮次、无固定顺序。
2. **秩序手段：禁言按钮**——禁言 = 发言权冻结（2026-10-11 评审定稿，取代本文原版「照常推送 + 附加禁言提示」设计）：入口——muted 期间聊天室消息不推送、水位线不推进（token 零消耗），解禁时按时间序补发冻结期间增量；出口——muted 状态下到达的聊天室回合结果（飞行中回合等防御路径）拦截转系统提示；**豁免**——私信是一对一问答，不在「会议发言权」语义内，禁言不影响私信收发。
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
- `push(text, kind)`：把一条消息放入队列，**客户端自造 uuid** 绑定通道标记（chatroom/dm）。SDK 在对应 turn 的 result 上回显 `user_message_uuid(s)`，据此把回复精确绑定回这次 push（合并 turn / error turn 下顺序推断会错位）；归并规则：一次 result 对应多条 push 时含任一 dm 则整体按 dm（宁漏播不泄漏）。若 CLI 正在处理，SDK 自动排队。**调用方永远不必等待**。
- `close()`：关闭输入队列，SDK 会把进行中的 turn 跑完才退出；幂等。**决议 1（B+）语义**：close 时若存在未销账 push（pendingSends 非空）→ `onDiscard` 回调（引擎落痕迹消息）；closed 后到达的 result 不再静默丢弃 → 经 `resolveResultKind` 分通道转 `onLateResult`（空文本 error turn 无内容可保，照吞）。tool/中间输出仍静默。
- 私信双重销账：`pendingSends`（uuid→通道）之外另有 `pendingDms`（uuid→dm 文本）。崩溃重建时，未被 CLI 读走的消息从未读缓冲迁移重放；已被读走但未出 result 的私信凭销账簿重发——否则重建后回复会走聊天室通道，私信内容泄漏（宁漏播不泄漏的对称保障）。重放一律换新 uuid 重新绑定。
- 消费循环逐条处理输出：`system/init` → 记录 sessionId（经回调交 engine 落库）；`assistant` 的 tool_use → 经回调更新状态卡片事件；`result`（任意 subtype 都视为 turn 完成并出队——只认 success 会让 error turn 消费了 push 却不出队，后续回复全部错位）→ 提取最终发言文本（[SKIP] 判定沿用 `isSkip`），经回调交 engine 落库与分发；空文本/提取失败视作 [SKIP]。
- **崩溃兜底**：消费循环意外抛错或自然结束且会议未结束时 → 用 resume 自动重建进程一次，并按水位线补发崩溃期间错过的增量；重建仍失败 → 该 agent 标记掉线（状态卡片展示），不再推送，不影响其他 agent 与会议本身。

对 engine 而言 AgentSession 是纯注入依赖（构造函数传入工厂），测试中以 mock 替换。

### MeetingEngine 改造（`src/core/engine.ts`）

- 删除：`runLoop`、`loops`（pause 标志对象）、`pendingDms` 队列、`processPendingDms`、轮次计数与 `maxRounds` 自动暂停逻辑、`extendRounds`。
- 新增：`sessions: Map<participantId, AgentSession>` 与统一分发器 `dispatch(message)`。
- 分发规则（核心语义）：

| 事件 | 落库 | 推送给谁 | 备注 |
|---|---|---|---|
| start 开场 | 系统消息 | 全员（开场指令） | 连锁反应的火花；禁言冻结语义统一适用 |
| 用户聊天室消息 | ✓ | 所有 agent | 禁言者入口冻结（不推送、水位不动） |
| agent 发言 | ✓ | 其他所有 agent | 发言者不推给自己；会议非 active（含 paused）期间静默拦截 |
| agent 回 [SKIP] | ✗ | 无人 | 防止连锁空转 |
| 用户 DM | ✓ | 仅目标 agent | 即时响应（排队到其当前轮结束）；禁言豁免私信 |
| agent 的 DM 回复 | ✓ | 仅用户（SSE 送达） | 空文本/[SKIP] 落「未能回复私信」系统消息 |
| 新成员入会 | 系统消息 | 老成员收 join 广播 + 新成员收 catchUp 全量 | 决议 3：广播与入会指令互补（自然感知只覆盖「开口的新人」——muted 入场或一直 [SKIP] 的成员无感知通道）；新成员不重复收实时推送 |
| system 消息 | ✓ | 分情况 | join / mute / unmute / muted 拦截 / 迟到转交类系统消息**广播给在线成员**；开场 roster、结束语仅展示。原「一刀切无人推送」按 2026-10-11 讨论会推翻——实弹：禁言事件无推送，在场者把「发不出声」误读为「选择沉默」，差点记成弃权 |
| 暂停丢弃痕迹 | 系统消息 | 广播（chatroom） | 决议 1：close 时有未销账 push → 「X 暂停时有一回合在途……」 |
| 迟到 result 转交 | 系统消息 | chatroom 类广播；dm 类仅落 dm channel | 决议 1：closed 后到达的 result 分通道转系统消息，不再静默丢弃 |

- **动态添加成员 `addParticipant(meetingId, { templateId, displayName, goal })`**：
  - 校验：会议未结束、当前总人数 ≤ 8、displayName 与 goal 非空。
  - 落库 participant（muted=0，lastInjectedMsgId=0，speakOrder 末位）；落库 system 消息「displayName 加入会议」。
  - 会议 active 时：创建并启动新 AgentSession（全新会话，无 resume），推送**一条合并的入会消息**：会议基本信息（主题、现有成员名单及各自目标、工作区）+ 中途加入说明 + 该成员自己的名字与目标 + 按时间序的全部历史聊天室消息（复用消息行格式，水位线从 0）+「请先简短自我介绍并给出初步观点」。此后纳入正常分发。
  - 会议 paused 时：仅落库，resume 时与其他成员统一重建并补发。
- `createMeeting` 输入相应变化：`participants: [{ templateId, displayName, goal }]`（不再有 maxRounds）。

- 禁言：`setMuted(meetingId, participantId, muted)` 更新 participants.muted（三层语义见「用户决策」第 2 条）。**mute/unmute 落库并广播系统消息**（决议 2：system 事件不进推送流，在场者无从知悉成员状态变化——实弹中禁言被误读为沉默）；禁言者本人入口冻结收不到广播、水位不动，解禁时 catchUp 按时间序补看「被禁言 → 冻结期间讨论 → 解除禁言」完整轨迹；解禁指令显式说明此前被禁言，防补课后长篇广播风暴。**冻结含重建补发**：catchUp 对 muted 成员一律跳过（崩溃重建也不补发，零消耗语义贯彻所有路径），解禁时统一补。muted 拦截提示（「已被禁言，其发言未被送达」）同样广播。私信豁免：禁言不影响 dm 收发。
- `start`：status=active、为每个参与者创建并启动 AgentSession（掉线 DM 排队链收尾后再建，防并发 resume 同一 sdkSessionId 链）、推送开场指令。
- `pause`：status=paused、关闭所有 AgentSession（省资源）；期间消息照常落库但不推送。**决议 1（B+）补救路径**：close 时未销账 push → 痕迹消息「X 暂停时有一回合在途，结果稍后送达或超时作废」；closed 后迟到 result → 分通道转系统消息（chatroom 类「X 的在途发言（迟到）」广播；dm 类「X 的私信回复姗姗来迟」仅落 dm channel——红线：dm 迟到回复绝不进 chatroom）。
- `resume`：status=active、为每个参与者重建 AgentSession（resume 各自 sdkSessionId）、按 lastInjectedMsgId 补发暂停期间增量、推送「会议恢复」指令；**对账补推**（决议 1 第 3 点）：catchUp 之后查该成员最后一条 dm 消息，若 kind=dm_user（无任何回应——超时/失败/迟到类 dm system 都算已回应）则重推私信。接受与迟到回复的一次性双发，不上跨会话去重；补推循环 N 次也接受（DB 痕迹断环会把「无限重试」换成「重试一次后放弃」，风险置换）。
- `end`：关闭全部进程、status=ended、落库结束系统消息。
- **服务器重启恢复（quarantine，决议 5——推翻本文原「初始化扫描恢复」设计）**：`recoverActiveMeetings` 对 status=active 的孤儿会议逐个置 paused + 落痕迹系统消息（「检测到服务重启，会议已自动暂停。点『继续』召回……」），**不创建任何会话**。理由：原「开机复活」与 pagehide 兜底「人不在场→暂停」哲学相反，复活的是无人看管的 8 agent × 常驻 CLI × bypassPermissions；恢复走用户显式 resume 全套（sdkSessionId 召回 + 水位补发 + B+ 对账补推），信息无损、只是把「继续自主执行工具」从默认改为显式授权。
- **SIGTERM 排水契约（决议 5 能力边界，陈终局注记）**：优雅停止 = SIGTERM 处理 → `gracefulShutdown()`（pause 全部 active，close 痕迹随 pause 落）→ 有界排水窗口（30s）等在途回合跑完、迟到 result 经 onLateResult 落库 → 窗口超时降级强杀语义（onDiscard 痕迹 + 下次 resume 对账补推兜底）→ 退出。「有界」与否决 close-等待方案同一条理由：maxTurns 40 的链子不能让「优雅」等成「挂起」。强杀（SIGKILL/崩溃）时飞行中的聊天室内容无挽回通道——进程死亡的固有限制，能保的已保。
- `buildSystemPrompt`：persona 取自模板，身份用「displayName（capability）」自指，目标取该实例的 goal；行为规则改写为自由响应语义：收到消息后自主判断是否有值得说的，没有则回 [SKIP]；保持简短、有观点、不重复别人说过的。**消息格式说明**（决议 4 修复项）：附一小段实际推送 case，动态注入本人 displayName·capability 指认「哪行是自己」，说明系统标签的包装规则与「平时收不到自己的推送、补发记录时才见」的机制，要求发言正文直接从内容写起、不自加 [chatroom …] 标签——只给正例不给反例（负例格式有被模仿的引力）。成因：晚入场 agent 的历史全为带标签格式，in-context 模仿压倒指令语义导致双前缀；发言者收不到自己的广播，对瑕疵无感知。
- 水位线语义变更：`lastInjectedMsgId` 不再用于轮询收集，仅用于补发（暂停期间/崩溃期间错过的消息）。**DB 是唯一事实源，恢复 = 重建会话 + 按水位补发**；广播即同步推进水位，跳过即冻结水位。

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

- AgentSession 崩溃：自动 resume 重建一次 + 水位线补发（未读缓冲迁移 + 私信销账簿重发，均换新 uuid）；再失败标记掉线，隔离故障不影响整场会议。
- 发言提取为空：视作 [SKIP]，不落库不分发（不重试，避免无意义的连锁模型调用）；dm 通道的空文本落「未能回复私信」系统消息。
- 结束/暂停时对已死进程 close：幂等，静默。
- resume 时 sdkSessionId 为空（如从未发言）：视作全新会话启动。
- **已知缺陷（2026-10-11 实弹，待裁决）**：单轮 `maxTurns=40`，长任务（几十轮工具调用）会撞上限——SDK 产 `error_max_turns` result（空文本），若该轮绑定的是 dm push，UI 呈现为误导性的「未能回复私信」（实为任务被上限截断，上下文未丢）。候选处置：提高/可配置 maxTurns；dm 兜底文案区分「上限中断」与「未回复」。

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

---

## 实施修订记录（2026-10-11 代码讨论会）

本文按当日代码讨论会五项决议的实施结果回写，正文已是系统现状的权威描述。决议的完整论证过程（否决项、实弹事件、复核轨迹）见项目根目录 `dev-chen-代码讨论会.md`（史料定位，不随实现演进更新）。

| 决议 | 内容 | 回写位置 |
|---|---|---|
| 1 | 暂停丢弃修复 B+：close 痕迹消息 + 迟到 result 分通道转系统消息 + resume 对账补推无回应私信 + 接受一次性双发（不上跨会话去重） | AgentSession 节、分发矩阵、pause/resume 条目 |
| 2 | mute/unmute 消息化：落库并广播，muted 拦截提示同走广播；禁言 = 发言权冻结（入口/出口/私信豁免三层语义） | 用户决策 2、禁言条目、分发矩阵 |
| 3 | join 系统消息广播给在线老成员（与新人 catchUp 全量互补，不替代） | 分发矩阵「新成员入会」 |
| 4 | 文档拉回现实：本文为底本回写；禁言语义由「照常推送+附加提示」改为入口冻结；catchUp 跳过 muted（冻结含重建补发）；buildSystemPrompt 增消息格式说明；旧两份文档标注已被取代 | 全文 |
| 5 | 重启隔离（quarantine）：active 孤儿降级 paused + 痕迹消息、不建会话，恢复走显式 resume；SIGTERM 排水契约（pause + 30s 有界窗口 + 超时降级强杀语义） | 「服务器重启恢复」条目、SIGTERM 排水契约条目 |

推翻的本设计原始条目（原意 → 现状）：

- 原「禁言照常推送 + 附加禁言提示」→ 入口冻结（token 零消耗），解禁补发；
- 原分发矩阵「新成员入会：现有 agent 不推送」→ join 广播（自然感知只覆盖开口的新人）；
- 原分发矩阵「system 消息：无人推送」→ 逐条清单裁决（join/mute/unmute/拦截/迟到类广播，roster/结束语仅展示）；
- 原「服务器重启恢复：初始化扫描走 resume 路径」→ quarantine（开机零复活，「继续」是显式授权）。

已知未裁决项：`maxTurns=40` 撞上限时 dm 轮呈现误导性「未能回复私信」（见错误处理汇总末条）。

