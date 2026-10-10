# 自由响应式会议（常驻流式会话）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「轮流发言 + 短连接 CLI 进程」架构改为「自由响应 + 常驻流式会话」：每个参会者一个常驻进程，消息实时推送分发；同时引入模板/实例分离（模板无名字，加人时设置名字与目标）与会议中动态添加成员。

**Architecture:** `AgentSession` 封装一个常驻 CLI 进程（`query({ prompt: AsyncIterable<SDKUserMessage> })`），消息经推送队列实时进入；engine 持有 `sessions` Map 并做统一分发（聊天室广播、DM 定向、禁言标记、[SKIP] 吞掉）；暂停/结束=关闭进程，恢复/重启=resume 重建+按水位线补发增量。schema 全量重构（模板表去 name、participants 加 displayName/goal/muted、messages 按 participantId）。

**Tech Stack:** TypeScript、Next.js 16 App Router、Claude Agent SDK（streaming input）、Drizzle + better-sqlite3、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-11-persistent-streaming-design.md`

---

## 文件结构总览

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/db/schema.ts` | 重写 | 模板/会议/参会者/消息表新结构 |
| `agents/*.json` | 重写+删除 | 无名字岗位模板；删 dev2/dev3、新增 architect |
| `src/core/agent-session.ts` | 新建 | 常驻流式会话（推送队列、消费循环、DM 标记通道、崩溃重建） |
| `src/core/agent-runner.ts` | 删除 | 被 AgentSession 取代 |
| `src/core/injector.ts` | 重写 | 消息行格式、开场/恢复/入会指令、DM prompt、[SKIP] |
| `src/core/engine.ts` | 重写 | 分发器、会话生命周期、禁言、动态加人、恢复 |
| `src/core/engine-instance.ts` | 修改 | 启动时恢复 active 会议 |
| `src/lib/events.ts` | 重写 | 事件类型（participantId、participant 事件、删 round、加 offline） |
| `src/app/api/meetings/[id]/[action]/route.ts` | 修改 | 删 extend |
| `src/app/api/meetings/[id]/dm/route.ts` | 修改 | body 改 participantId |
| `src/app/api/meetings/[id]/participants/route.ts` | 新建 | POST 动态添加成员 |
| `src/app/api/meetings/[id]/participants/[participantId]/route.ts` | 新建 | PATCH 禁言 |
| `src/app/meetings/new/page.tsx` | 重写 | 模板+名字+目标的成员编辑表单 |
| `src/app/meetings/[id]/page.tsx` | 重写 | RoomData 组装（新 ParticipantView） |
| `src/components/room/types.ts` | 重写 | ParticipantView 新结构 |
| `src/components/room/Room.tsx` | 重写 | 参与者状态管理、SSE participant 事件、添加成员入口、禁言回调 |
| `src/components/room/AgentCard.tsx` | 重写 | displayName/goal/禁言按钮/offline 状态 |
| `src/components/room/ChatPanel.tsx` | 修改 | 按 participantId 显示、去 round |
| `src/components/room/DmDrawer.tsx` | 修改 | displayName |
| `src/components/room/AddMemberDialog.tsx` | 新建 | 添加成员弹窗 |
| `tests/` | 多文件 | 见各任务 |

**测试基线**：v1 有 30 个测试。本计划重写大部分；`a-batch-race-repro.test.ts` 与 `tests/README.md` 删除（竞态根源被整体替换）。

---

### Task 1: schema 重构与岗位模板

**Files:**
- Modify: `src/db/schema.ts`（全量重写）
- Modify: `agents/dev.json`、`agents/test.json`、`agents/debate.json`、`agents/analyst.json`
- Create: `agents/architect.json`
- Delete: `agents/dev2.json`、`agents/dev3.json`
- Modify: `src/core/agent-config.ts`
- Test: `tests/db.test.ts`、`tests/agent-config.test.ts`

- [ ] **Step 1: 重写 schema.ts**

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** agent 模板：岗位画像（无名字，名字在会议实例上） */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // slug，如 'dev'
  capability: text('capability').notNull(),
  description: text('description').notNull(),
  persona: text('persona').notNull(),
  avatar: text('avatar').notNull().default('🤖'),
});

export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  topic: text('topic').notNull(),
  workspacePath: text('workspace_path').notNull(),
  status: text('status').notNull().default('paused'), // active | paused | ended
  createdAt: integer('created_at').notNull(),
  endedAt: integer('ended_at'),
});

/** 参会者实例：一场会议里的一个"人"（同一模板可多实例） */
export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  templateId: text('template_id').notNull(),
  displayName: text('display_name').notNull(),
  goal: text('goal').notNull(),
  muted: integer('muted').notNull().default(0),
  sdkSessionId: text('sdk_session_id'),
  speakOrder: integer('speak_order').notNull(),
  lastInjectedMsgId: integer('last_injected_msg_id').notNull().default(0),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  meetingId: text('meeting_id').notNull(),
  channel: text('channel').notNull(), // chatroom | dm
  participantId: text('participant_id'), // speech/dm_agent=发言者实例；dm=私聊目标实例；user/system=null
  kind: text('kind').notNull(), // speech | user | system | dm_user | dm_agent
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
```

- [ ] **Step 2: 更新 agent-config.ts 的 zod schema（去 name）**

```typescript
// src/core/agent-config.ts 中 agentFileSchema 改为：
export const agentFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  capability: z.string().min(1),
  description: z.string().min(1),
  persona: z.string().min(1),
  avatar: z.string().default('🤖'),
});
```

（loadAgentFiles / importAgentsToDb 其余逻辑不变。）

- [ ] **Step 3: 重写模板 JSON（persona 不含名字，第一人称岗位画像）**

```json
// agents/dev.json
{
  "id": "dev",
  "capability": "研发",
  "description": "资深研发工程师，重工程质量与可维护性",
  "persona": "你是一名资深研发工程师，10 年经验，写过大型 To B 和 To C 应用。你重视工程质量、可维护性和长期演进成本，警惕「先上线再优化」变成「永不优化」。讨论技术方案时你会从实现难度、边界条件、失败模式出发，习惯拿具体的代码结构和工程权衡说话。",
  "avatar": "🧑‍💻"
}
```

```json
// agents/test.json
{
  "id": "test",
  "capability": "测试",
  "description": "测试工程师，边界条件与可验证性敏感",
  "persona": "你是一名测试工程师，8 年经验，做过功能、接口与集成测试。你对边界条件、异常路径和「怎么验证它是对的」高度敏感，讨厌不可测的设计。讨论方案时你总是问：怎么证明它能工作、坏了怎么发现、回归成本多高。",
  "avatar": "🧪"
}
```

```json
// agents/architect.json（新建）
{
  "id": "architect",
  "capability": "架构师",
  "description": "系统架构师，全局视角与技术演进",
  "persona": "你是一名系统架构师，14 年经验，主导过多个从零到百万级用户的系统。你看重全局视角：模块边界、数据流、演进路径和团队协作成本。讨论时你喜欢先厘清问题域再谈方案，警惕过度设计与「为了新技术而新技术」，习惯用取舍（trade-off）框架分析问题。",
  "avatar": "🏛️"
}
```

```json
// agents/debate.json
{
  "id": "debate",
  "capability": "评审",
  "description": "技术评审，逻辑严密，专挑漏洞",
  "persona": "你是一名技术评审专家，长期主持方案评审会。你逻辑严密、直言不讳，擅长发现论证漏洞、隐藏假设和被回避的风险。你不和稀泥，观点交锋时你会明确指出对方论据的薄弱环节，但也承认自己被说服的时刻。你讨厌没有结论的讨论。",
  "avatar": "⚖️"
}
```

```json
// agents/analyst.json
{
  "id": "analyst",
  "capability": "分析",
  "description": "数据分析师，用数据说话",
  "persona": "你是一名数据分析师，9 年经验，做过增长与产品分析。你习惯用数据说话：指标怎么定义、基线是多少、怎么衡量一个改动的效果。讨论中你会提醒大家区分事实与观点，警惕幸存者偏差和相关性当因果。没有数据时你会明确说这是推测。",
  "avatar": "📊"
}
```

删除 `agents/dev2.json`、`agents/dev3.json`（通知用户：其内容已被模板/实例分离机制取代）。

- [ ] **Step 4: 重写 db.test.ts 断言**

```typescript
// tests/db.test.ts —— 保留原有建表断言风格，更新字段断言：
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { agents, meetings, participants, messages } from '@/db/schema';

describe('db', () => {
  it('内存库建表并可插入', () => {
    const db = createTestDb();
    db.insert(agents).values({
      id: 'dev', capability: '研发', description: 'd', persona: 'p', avatar: '🧑‍💻',
    }).run();
    db.insert(meetings).values({
      id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', status: 'paused', createdAt: Date.now(),
    }).run();
    db.insert(participants).values({
      id: 'p1', meetingId: 'm1', templateId: 'dev', displayName: '张工', goal: '激进派',
      muted: 0, speakOrder: 0, lastInjectedMsgId: 0,
    }).run();
    db.insert(messages).values({
      meetingId: 'm1', channel: 'chatroom', participantId: 'p1', kind: 'speech',
      content: 'hi', createdAt: Date.now(),
    }).run();
    const ps = db.select().from(participants).all();
    expect(ps.length).toBe(1);
    expect(ps[0].displayName).toBe('张工');
    expect(ps[0].muted).toBe(0);
    const ms = db.select().from(messages).all();
    expect(ms[0].participantId).toBe('p1');
  });

  it('同一模板可插入两个实例（不同 displayName）', () => {
    const db = createTestDb();
    db.insert(agents).values({ id: 'dev', capability: '研发', description: 'd', persona: 'p' }).run();
    db.insert(meetings).values({
      id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', status: 'paused', createdAt: Date.now(),
    }).run();
    for (const [pid, name] of [['p1', '张工'], ['p2', '李工']] as const) {
      db.insert(participants).values({
        id: pid, meetingId: 'm1', templateId: 'dev', displayName: name, goal: 'g',
        muted: 0, speakOrder: 0, lastInjectedMsgId: 0,
      }).run();
    }
    expect(db.select().from(participants).all().map((p) => p.displayName)).toEqual(['张工', '李工']);
  });
});
```

- [ ] **Step 5: 更新 agent-config.test.ts（无 name 字段 + 保留重复 id 检测）**

```typescript
// tests/agent-config.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@/db/client';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';
import { agents } from '@/db/schema';

describe('agent-config', () => {
  it('加载内置岗位模板（无 name 字段）并幂等导入', () => {
    const db = createTestDb();
    const files = loadAgentFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect('name' in f).toBe(false);
    importAgentsToDb(db, files);
    importAgentsToDb(db, files);
    const rows = db.select().from(agents).all();
    expect(rows.map((r) => r.id)).toContain('dev');
    expect(rows.map((r) => r.id)).toContain('architect');
  });

  it('目录内 id 重复时抛出明确错误', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
      id: 'dup', capability: 'c', description: 'd', persona: 'p',
    }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({
      id: 'dup', capability: 'c', description: 'd', persona: 'p',
    }));
    expect(() => loadAgentFiles(dir)).toThrow(/重复/);
  });
});
```

- [ ] **Step 6: 重新生成迁移 + 删开发库 + 跑测试**

```bash
rm -f data/meetings.db
npx drizzle-kit generate --name free-response-schema
npx vitest run tests/db.test.ts tests/agent-config.test.ts
```

预期：全部 PASS。（此时其余测试因引用旧字段必然失败——属预期，后续任务逐个修复。若 drizzle 迁移目录有旧迁移文件冲突，可清空 `drizzle/` 目录后重新 generate，开发期无历史包袱。）

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: schema 重构——模板去 name、participants 实例化（displayName/goal/muted）、messages 按 participantId"
```

---

### Task 2: injector 重写（消息行格式 + 指令构造器）

**Files:**
- Modify: `src/core/injector.ts`（全量重写）
- Test: `tests/injector.test.ts`（全量重写）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/injector.test.ts
import { describe, it, expect } from 'vitest';
import {
  isSkip, chatroomLine, buildDmPrompt, buildKickoffPrompt, type SenderInfo,
} from '@/core/injector';
import type { MessageRow } from '@/db/schema';

const row = (over: Partial<MessageRow>): MessageRow => ({
  id: 1, meetingId: 'm1', channel: 'chatroom', participantId: null,
  kind: 'user', content: 'hi', createdAt: 0, ...over,
});

const senders = new Map<string, SenderInfo>([
  ['p1', { name: '张工', capability: '研发' }],
]);

describe('injector', () => {
  it('isSkip 只认纯 [SKIP]', () => {
    expect(isSkip('[SKIP]')).toBe(true);
    expect(isSkip(' [SKIP] ')).toBe(true);
    expect(isSkip('我认为…[SKIP]')).toBe(false);
  });

  it('chatroomLine：用户/系统/成员发言三种前缀', () => {
    expect(chatroomLine(row({ kind: 'user', content: '大家好' }), senders))
      .toBe('[chatroom 用户] 大家好');
    expect(chatroomLine(row({ kind: 'system', content: '会议开始' }), senders))
      .toBe('[system] 会议开始');
    expect(chatroomLine(row({ kind: 'speech', participantId: 'p1', content: '我反对' }), senders))
      .toBe('[chatroom 张工·研发] 我反对');
    expect(chatroomLine(row({ kind: 'speech', participantId: 'pX', content: '??' }), senders))
      .toBe('[chatroom 未知参会者] ??');
  });

  it('buildDmPrompt 带私信规则', () => {
    expect(buildDmPrompt(['在吗'])).toContain('[user 私信→你] 在吗');
    expect(buildDmPrompt(['在吗'])).toContain('仅你可见');
  });

  it('buildKickoffPrompt：开场指令 + roster + 历史行', () => {
    const p = buildKickoffPrompt({
      directive: '会议现在开始。请简短表态。',
      roster: '- 张工（研发）：激进派\n- 李工（测试）：保守派',
      history: [
        row({ kind: 'system', content: '会议开始' }),
        row({ id: 2, kind: 'user', content: '大家好' }),
      ],
    });
    expect(p).toContain('会议现在开始。请简短表态。');
    expect(p).toContain('- 张工（研发）：激进派');
    expect(p).toContain('[system] 会议开始');
    expect(p).toContain('[chatroom 用户] 大家好');
    expect(p).toContain('[SKIP]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/injector.test.ts`
预期：FAIL（chatroomLine / buildKickoffPrompt 未导出）。

- [ ] **Step 3: 重写 injector.ts**

```typescript
// src/core/injector.ts
import type { MessageRow } from '@/db/schema';

export const SKIP_TOKEN = '[SKIP]';

export function isSkip(text: string): boolean {
  return text.trim() === SKIP_TOKEN;
}

export interface SenderInfo {
  name: string; // displayName
  capability: string;
}

/** 把一条聊天室消息渲染为推送给 agent 的文本行 */
export function chatroomLine(row: MessageRow, senders: Map<string, SenderInfo>): string {
  if (row.kind === 'user') return `[chatroom 用户] ${row.content}`;
  if (row.kind === 'system') return `[system] ${row.content}`;
  const s = row.participantId ? senders.get(row.participantId) : undefined;
  const label = s ? `${s.name}·${s.capability}` : '未知参会者';
  return `[chatroom ${label}] ${row.content}`;
}

export function buildDmPrompt(content: string): string {
  return `[user 私信→你] ${content}

[system] 以上是用户发给你的私信（仅你可见，其他参会者看不到）。请直接回复用户，回复同样仅用户可见、不会进入聊天室。`;
}

/** 开场/恢复/入会共用的指令构造器：指令 + 花名册 + 历史消息行 */
export function buildKickoffPrompt(input: {
  directive: string;
  roster?: string;
  history: MessageRow[];
  senders: Map<string, SenderInfo>;
}): string {
  const parts: string[] = [input.directive];
  if (input.roster) parts.push(`# 参会者\n${input.roster}`);
  if (input.history.length) {
    parts.push(
      `# 最新讨论记录\n${input.history.map((r) => chatroomLine(r, input.senders)).join('\n')}`,
    );
  }
  parts.push(`[system] 请基于以上内容发言表态；若无话可说，只回复 ${SKIP_TOKEN}。`);
  return parts.join('\n\n');
}
```

（`collectChatroomIncrement` 保留原样，不删——engine 补发时仍用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/injector.test.ts`
预期：PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: injector 重写——chatroomLine/buildKickoffPrompt/buildDmPrompt"
```

---

### Task 3: AgentSession（常驻流式会话）

**Files:**
- Create: `src/core/agent-session.ts`
- Test: `tests/agent-session.test.ts`
- Delete: `tests/agent-runner.test.ts`、`src/core/agent-runner.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/agent-session.test.ts（完整文件）
import { describe, it, expect, vi } from 'vitest';
import { AgentSession, type QueryFactory, type AgentSessionCallbacks } from '@/core/agent-session';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** 受控异步输出流：测试中手动 emit 消息、可选地结束流 */
class ControlledStream implements AsyncIterable<SDKMessage> {
  private queued: SDKMessage[] = [];
  private waiters: ((r: IteratorResult<SDKMessage>) => void)[] = [];
  private ended = false;
  emit(m: SDKMessage) {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.queued.push(m);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<SDKMessage>> {
    const v = this.queued.shift();
    if (v) return Promise.resolve({ value: v, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function makeHarness(overrides?: Partial<AgentSessionCallbacks>) {
  const pushed: SDKUserMessage[] = [];
  const streams: ControlledStream[] = [];
  const cbs = {
    onSessionId: vi.fn(),
    onTool: vi.fn(),
    onResult: vi.fn(),
    onRestart: vi.fn(),
    onDead: vi.fn(),
    ...overrides,
  };
  const factory: QueryFactory = ({ prompt }) => {
    const stream = new ControlledStream();
    streams.push(stream);
    void (async () => {
      for await (const m of prompt) pushed.push(m);
    })();
    return stream;
  };
  return { pushed, streams, cbs, factory };
}

const initMsg = { type: 'system', subtype: 'init', session_id: 's-1' } as SDKMessage;
const okResult = (text: string, sid = 's-2') =>
  ({ type: 'result', subtype: 'success', result: text, session_id: sid } as unknown as SDKMessage);
const toolMsg = (name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } } as unknown as SDKMessage);

function makeSession(factory: QueryFactory, cbs: AgentSessionCallbacks, resume?: string) {
  const s = new AgentSession({
    systemPrompt: 'sys', cwd: '/tmp', resumeSessionId: resume, queryFactory: factory, callbacks: cbs,
  });
  s.start();
  return s;
}

describe('AgentSession', () => {
  it('push 进入 prompt 流；输出消息触发回调', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('第一条');
    await vi.waitFor(() => expect(h.pushed.length).toBe(1));
    expect(h.pushed[0].message.content).toBe('第一条');

    h.streams[0].emit(initMsg);
    await vi.waitFor(() => expect(h.cbs.onSessionId).toHaveBeenCalledWith('s-1'));

    h.streams[0].emit(toolMsg('Read', { file_path: '/a.ts' }));
    await vi.waitFor(() => expect(h.cbs.onTool).toHaveBeenCalledWith('Read', '/a.ts'));

    h.streams[0].emit(okResult('我认为可以'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('我认为可以', 'chatroom'));
    await s.close();
  });

  it('push 带 dm 标记时，result 回调携带 dm（顺序对应）', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('聊天室消息', 'chatroom');
    s.push('私信内容', 'dm');
    h.streams[0].emit(okResult('公开回应'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('公开回应', 'chatroom'));
    h.streams[0].emit(okResult('私下的回应'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('私下的回应', 'dm'));
    await s.close();
  });

  it('close 后 push 不再生效，且幂等', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    await s.close();
    await s.close(); // 幂等
    s.push('已关闭');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.pushed.length).toBe(0);
  });

  it('流意外结束：自动重建一次并回调 onRestart；再次结束回调 onDead', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs, 'old-session');
    h.streams[0].end(); // 第一次：崩溃
    await vi.waitFor(() => expect(h.cbs.onRestart).toHaveBeenCalledTimes(1));
    expect(h.streams.length).toBe(2); // 重建了新 query
    h.streams[1].end(); // 第二次：放弃
    await vi.waitFor(() => expect(h.cbs.onDead).toHaveBeenCalled());
    await s.close();
  });

  it('重建后的 query 携带最新 sessionId（resume）', async () => {
    const h = makeHarness();
    const resumeIds: (string | undefined)[] = [];
    const factory: QueryFactory = (input) => {
      resumeIds.push(input.options.resume);
      return h.factory(input);
    };
    const s = makeSession(factory, h.cbs);
    h.streams[0].emit(initMsg); // session_id: s-1
    await vi.waitFor(() => expect(h.cbs.onSessionId).toHaveBeenCalledWith('s-1'));
    h.streams[0].end(); // 触发重建
    await vi.waitFor(() => expect(h.streams.length).toBe(2));
    expect(resumeIds[1]).toBe('s-1');
    await s.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent-session.test.ts`
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 agent-session.ts**

```typescript
// src/core/agent-session.ts
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type PushKind = 'chatroom' | 'dm';

export interface AgentSessionCallbacks {
  onSessionId(sessionId: string): void;
  onTool(tool: string, detail: string): void;
  /** 一轮结束的最终文本；kind 对应触发这轮的 push 标记（顺序对应） */
  onResult(text: string, kind: PushKind): void;
  /** 崩溃后自动重建成功（引擎应补发增量） */
  onRestart(): void;
  /** 重建也失败，该成员掉线 */
  onDead(): void;
}

export type QueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    systemPrompt: string;
    cwd: string;
    permissionMode: 'bypassPermissions';
    resume?: string;
    maxTurns: number;
  };
}) => AsyncIterable<SDKMessage>;

/** SDK 消费引擎传来的流式输入 */
class PushQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buf.push(msg);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<SDKUserMessage>> {
    const v = this.buf.shift();
    if (v) return Promise.resolve({ value: v, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const v =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v === undefined ? '' : String(v);
}

export interface AgentSessionOptions {
  systemPrompt: string;
  cwd: string;
  resumeSessionId?: string;
  queryFactory: QueryFactory;
  callbacks: AgentSessionCallbacks;
}

export class AgentSession {
  private queue = new PushQueue();
  private sessionId: string | undefined;
  private closed = false;
  private restarted = false;
  private pendingKinds: PushKind[] = [];

  constructor(private readonly opts: AgentSessionOptions) {}

  start(): void {
    if (this.closed) return;
    this.queue = new PushQueue();
    const iter = this.opts.queryFactory({
      prompt: this.queue,
      options: {
        systemPrompt: this.opts.systemPrompt,
        cwd: this.opts.cwd,
        permissionMode: 'bypassPermissions',
        resume: this.sessionId ?? this.opts.resumeSessionId,
        maxTurns: 40,
      },
    });
    void this.consume(iter);
  }

  push(text: string, kind: PushKind = 'chatroom'): void {
    this.pendingKinds.push(kind);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }

  private async consume(iter: AsyncIterable<SDKMessage>): Promise<void> {
    try {
      for await (const msg of iter) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.opts.callbacks.onSessionId(msg.session_id);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              this.opts.callbacks.onTool(
                block.name,
                describeToolInput(block.input as Record<string, unknown>),
              );
            }
          }
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          if (msg.session_id) {
            this.sessionId = msg.session_id;
            this.opts.callbacks.onSessionId(msg.session_id);
          }
          const kind = this.pendingKinds.shift() ?? 'chatroom';
          this.opts.callbacks.onResult(msg.result ?? '', kind);
        }
      }
      this.handleEnd();
    } catch {
      this.handleEnd();
    }
  }

  private handleEnd(): void {
    if (this.closed) return;
    if (this.restarted) {
      this.opts.callbacks.onDead();
      return;
    }
    this.restarted = true;
    // 清空标记队列：崩溃瞬间 CLI 可能已消费 prompt 未出 result，残留 tag 会让
    // 重建后第一条公开回复被误判为 dm（隐私泄漏级 bug）
    this.pendingKinds = [];
    this.opts.callbacks.onRestart();
    this.start();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent-session.test.ts`
预期：PASS（5 个用例）

- [ ] **Step 5: 删除 agent-runner**

```bash
git rm src/core/agent-runner.ts tests/agent-runner.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: AgentSession 常驻流式会话（推送队列/DM 标记通道/崩溃重建），移除 agent-runner"
```

---

### Task 4: engine 核心重构（会话生命周期 + 分发）

**Files:**
- Modify: `src/core/engine.ts`（全量重写）
- Modify: `src/lib/events.ts`（先改，engine 依赖它）
- Test: `tests/engine-create.test.ts`（重写）

- [ ] **Step 1: 重写 events.ts**

```typescript
// src/lib/events.ts
import { EventEmitter } from 'node:events';
import type { MessageRow } from '@/db/schema';

export type MeetingStatus = 'active' | 'paused' | 'ended';
export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'speaking' | 'offline';

/** 参会者视图（participant 事件与页面共用） */
export interface ParticipantInfo {
  id: string;
  templateId: string;
  displayName: string;
  goal: string;
  muted: boolean;
  speakOrder: number;
}

export type MeetingEvent =
  | { type: 'message'; meetingId: string; message: MessageRow }
  | {
      type: 'agent_status';
      meetingId: string;
      participantId: string;
      status: AgentStatus;
      detail?: string;
    }
  | { type: 'participant'; meetingId: string; participant: ParticipantInfo }
  | { type: 'meeting_status'; meetingId: string; status: MeetingStatus };

const g = globalThis as unknown as { __meetingBus?: EventEmitter };

export function getBus(): EventEmitter {
  if (!g.__meetingBus) {
    g.__meetingBus = new EventEmitter();
    g.__meetingBus.setMaxListeners(200);
  }
  return g.__meetingBus;
}

export function emitMeetingEvent(e: MeetingEvent): void {
  getBus().emit(`meeting:${e.meetingId}`, e);
}

export function subscribeMeeting(
  meetingId: string,
  fn: (e: MeetingEvent) => void,
): () => void {
  const bus = getBus();
  const ch = `meeting:${meetingId}`;
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}
```

同步重写 `tests/events.test.ts`：

```typescript
// tests/events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { emitMeetingEvent, subscribeMeeting } from '@/lib/events';

describe('events', () => {
  it('participant 事件可订阅与退订', () => {
    const fn = vi.fn();
    const off = subscribeMeeting('m1', fn);
    emitMeetingEvent({
      type: 'participant',
      meetingId: 'm1',
      participant: { id: 'p1', templateId: 'dev', displayName: '张工', goal: 'g', muted: false, speakOrder: 0 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    emitMeetingEvent({
      type: 'participant',
      meetingId: 'm1',
      participant: { id: 'p1', templateId: 'dev', displayName: '张工', goal: 'g', muted: true, speakOrder: 0 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('agent_status 按 participantId 送达', () => {
    const fn = vi.fn();
    const off = subscribeMeeting('m2', fn);
    emitMeetingEvent({ type: 'agent_status', meetingId: 'm2', participantId: 'p9', status: 'offline' });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'p9', status: 'offline' }));
    off();
  });
});
```

- [ ] **Step 2: 写失败测试（engine-create）**

```typescript
// tests/engine-create.test.ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine } from '@/core/engine';
import { messages, participants } from '@/db/schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeEngine() {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  return { db, engine: new MeetingEngine(db) };
}

export const validInput = () => ({
  title: 'auth 模块重构评审',
  topic: '是否重写 auth 模块',
  workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
  participants: [
    { templateId: 'dev', displayName: '张工', goal: '激进派：主张全面重写' },
    { templateId: 'test', displayName: '李测试', goal: '保守派：主张渐进改造' },
  ],
});

describe('createMeeting', () => {
  it('校验工作区与人数，创建参会者实例与开场系统消息', () => {
    const { db, engine } = makeEngine();
    const input = validInput();
    const m = engine.createMeeting(input);

    expect(m.status).toBe('paused');
    const ps = db.select().from(participants).all();
    expect(ps.length).toBe(2);
    expect(ps.map((p) => p.displayName)).toEqual(['张工', '李测试']);
    expect(ps.map((p) => p.speakOrder)).toEqual([0, 1]);

    const sys = db.select().from(messages).where(eq(messages.kind, 'system')).all();
    expect(sys.length).toBe(1);
    expect(sys[0].content).toContain(input.topic);
    expect(sys[0].content).toContain('张工');
  });

  it('工作区不存在时抛错', () => {
    const { engine } = makeEngine();
    const input = validInput();
    input.workspacePath = 'X:/不存在';
    expect(() => engine.createMeeting(input)).toThrow(/工作区/);
  });

  it('参与者少于 2 或多于 8 时抛错', () => {
    const { engine } = makeEngine();
    const one = validInput();
    one.participants = [one.participants[0]];
    expect(() => engine.createMeeting(one)).toThrow(/2-8|参与者/);
  });

  it('同一模板两个实例（不同 displayName）合法', () => {
    const { db, engine } = makeEngine();
    const input = validInput();
    input.participants = [
      { templateId: 'dev', displayName: '张工', goal: '激进派' },
      { templateId: 'dev', displayName: '李工', goal: '保守派' },
    ];
    engine.createMeeting(input);
    expect(db.select().from(participants).all().length).toBe(2);
  });

  it('buildSystemPrompt 含 persona、身份自指、goal 与自由响应规则', () => {
    const { engine } = makeEngine();
    const input = validInput();
    const m = engine.createMeeting(input);
    const ps = engine.getParticipants(m.id);
    const sp = engine.buildSystemPrompt(m.id, ps[0].id);
    const dev = loadAgentFiles().find((a) => a.id === 'dev')!;
    expect(sp).toContain(dev.persona.slice(0, 10)); // 动态引用，模板改动不改测试
    expect(sp).toContain('张工（研发）');
    expect(sp).toContain('激进派：主张全面重写');
    expect(sp).toContain('[SKIP]');
    expect(sp).toContain('私信');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/engine-create.test.ts tests/events.test.ts`
预期：FAIL。

- [ ] **Step 4: 重写 engine.ts**

```typescript
// src/core/engine.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  agents, meetings, participants, messages,
  type AgentRow, type MeetingRow, type MessageRow, type ParticipantRow,
} from '@/db/schema';
import type { DB } from '@/db/client';
import { emitMeetingEvent, type MeetingStatus, type ParticipantInfo } from '@/lib/events';
import type { AgentSessionLike, SessionFactory } from './session-factory';
import { defaultSessionFactory } from './session-factory';
import {
  collectChatroomIncrement, chatroomLine, buildKickoffPrompt, buildDmPrompt, isSkip,
  type SenderInfo,
} from './injector';

export interface CreateMeetingInput {
  title: string;
  topic: string;
  workspacePath: string;
  participants: { templateId: string; displayName: string; goal: string }[];
}

const MUTE_SUFFIX =
  '\n（你现在被主持人禁言，请勿发言，直接回复 [SKIP]，并记住该消息作为上下文。）';

export class MeetingEngine {
  /** meetingId -> participantId -> session */
  private sessions = new Map<string, Map<string, AgentSessionLike>>();

  constructor(
    private db: DB,
    private sessionFactory: SessionFactory = defaultSessionFactory,
  ) {}

  // ---------- 查询 ----------

  getMeeting(meetingId: string): MeetingRow {
    const m = this.db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
    if (!m) throw new Error(`会议 ${meetingId} 不存在`);
    return m;
  }

  getParticipants(meetingId: string): ParticipantRow[] {
    return this.db.select().from(participants)
      .where(eq(participants.meetingId, meetingId))
      .all()
      .sort((a, b) => a.speakOrder - b.speakOrder);
  }

  getMessages(meetingId: string): MessageRow[] {
    return this.db.select().from(messages)
      .where(eq(messages.meetingId, meetingId)).all();
  }

  getParticipant(meetingId: string, participantId: string): ParticipantRow {
    const p = this.db.select().from(participants)
      .where(and(eq(participants.meetingId, meetingId), eq(participants.id, participantId)))
      .get();
    if (!p) throw new Error(`参会者 ${participantId} 不在该会议中`);
    return p;
  }

  agentMap(): Map<string, AgentRow> {
    return new Map(this.db.select().from(agents).all().map((a) => [a.id, a]));
  }

  participantInfo(p: ParticipantRow): ParticipantInfo {
    return {
      id: p.id, templateId: p.templateId, displayName: p.displayName,
      goal: p.goal, muted: !!p.muted, speakOrder: p.speakOrder,
    };
  }

  // ---------- 消息与事件 ----------

  insertMessage(row: {
    meetingId: string;
    channel: 'chatroom' | 'dm';
    participantId?: string | null;
    kind: 'speech' | 'user' | 'system' | 'dm_user' | 'dm_agent';
    content: string;
  }): MessageRow {
    this.db.insert(messages).values({
      meetingId: row.meetingId,
      channel: row.channel,
      participantId: row.participantId ?? null,
      kind: row.kind,
      content: row.content,
      createdAt: Date.now(),
    }).run();
    const all = this.db.select().from(messages)
      .where(eq(messages.meetingId, row.meetingId)).all();
    return all[all.length - 1]; // 自增 id，最后一条即刚插入的
  }

  emitMessage(msg: MessageRow): void {
    emitMeetingEvent({ type: 'message', meetingId: msg.meetingId, message: msg });
  }

  setAgentStatus(
    meetingId: string,
    participantId: string,
    status: 'idle' | 'thinking' | 'tool' | 'speaking' | 'offline',
    detail?: string,
  ): void {
    emitMeetingEvent({ type: 'agent_status', meetingId, participantId, status, detail });
  }

  // ---------- 创建 ----------

  createMeeting(input: CreateMeetingInput): MeetingRow {
    if (!fs.existsSync(input.workspacePath) || !fs.statSync(input.workspacePath).isDirectory()) {
      throw new Error('工作区路径不存在或不是目录');
    }
    if (input.participants.length < 2 || input.participants.length > 8) {
      throw new Error('参与者数量须在 2-8 之间');
    }
    for (const p of input.participants) {
      if (!p.displayName?.trim() || !p.goal?.trim()) {
        throw new Error('每个参与者的名字与目标不能为空');
      }
    }
    const am = this.agentMap();
    for (const p of input.participants) {
      if (!am.has(p.templateId)) throw new Error(`模板 ${p.templateId} 不存在`);
    }

    const meetingId = randomUUID();
    this.db.insert(meetings).values({
      id: meetingId,
      title: input.title,
      topic: input.topic,
      workspacePath: input.workspacePath,
      status: 'paused',
      createdAt: Date.now(),
    }).run();

    input.participants.forEach((p, i) => {
      this.db.insert(participants).values({
        id: randomUUID(),
        meetingId,
        templateId: p.templateId,
        displayName: p.displayName.trim(),
        goal: p.goal.trim(),
        muted: 0,
        speakOrder: i,
        lastInjectedMsgId: 0,
      }).run();
    });

    const opening = this.insertMessage({
      meetingId,
      channel: 'chatroom',
      kind: 'system',
      content: `会议「${input.title}」已创建。主题：${input.topic}\n参会者：\n${this.roster(meetingId)}\n工作区：${input.workspacePath}`,
    });
    this.emitMessage(opening);
    return this.getMeeting(meetingId);
  }

  /** 花名册文本（指令与 system prompt 共用） */
  private roster(meetingId: string): string {
    const am = this.agentMap();
    return this.getParticipants(meetingId)
      .map((p) => {
        const t = am.get(p.templateId);
        return `- ${p.displayName}（${t?.capability ?? ''}）：${p.goal}`;
      })
      .join('\n');
  }

  // ---------- system prompt ----------

  buildSystemPrompt(meetingId: string, participantId: string): string {
    const m = this.getMeeting(meetingId);
    const p = this.getParticipant(meetingId, participantId);
    const t = this.agentMap().get(p.templateId)!;
    return `# 你的身份
你是「${p.displayName}」，本会议中的${t.capability}。${t.persona}

# 会议背景
会议主题：${m.topic}
工作区（你的文件工具只能在此目录内使用）：${m.workspacePath}

# 你的会议目标
${p.goal}

# 参会者
${this.roster(meetingId)}

# 行为规则
- 会议以自由讨论方式进行：聊天室的新消息会实时推送给你，你自主判断是否发言
- 有值得说的就简短发言；没有则只回复 ${'[SKIP]'}，不要无话找话
- 发言像真实会议发言一样简洁聚焦（通常几十到两三百字），有观点、不重复别人说过的
- 你可以用文件工具查阅/修改工作区代码来支撑观点；你的工具操作过程其他参会者看不到，只有你的最终发言文本会公布到聊天室
- 用户可能私信你（消息带 [user 私信→你] 前缀），私信与你的私聊回复仅双方可见，不会进入聊天室；私信中的指示会影响你的立场，这是允许的`;
  }

  // ---------- 分发 ----------

  private senderInfoMap(meetingId: string): Map<string, SenderInfo> {
    const am = this.agentMap();
    return new Map(
      this.getParticipants(meetingId).map((p) => {
        const t = am.get(p.templateId);
        return [p.id, { name: p.displayName, capability: t?.capability ?? '' }] as const;
      }),
    );
  }

  private sessionsOf(meetingId: string): Map<string, AgentSessionLike> {
    let s = this.sessions.get(meetingId);
    if (!s) {
      s = new Map();
      this.sessions.set(meetingId, s);
    }
    return s;
  }

  /** 聊天室消息广播给所有（除发送者）在线成员；禁言者附加提示 */
  private broadcastChatroom(msg: MessageRow, exceptParticipantId?: string): void {
    const senders = this.senderInfoMap(msg.meetingId);
    const sessions = this.sessionsOf(msg.meetingId);
    for (const p of this.getParticipants(msg.meetingId)) {
      if (p.id === exceptParticipantId) continue;
      const s = sessions.get(p.id);
      if (!s) continue;
      const line = chatroomLine(msg, senders);
      s.push(p.muted ? line + MUTE_SUFFIX : line);
      this.db.update(participants)
        .set({ lastInjectedMsgId: msg.id })
        .where(eq(participants.id, p.id)).run();
    }
  }

  /** agent 一轮结束：按 kind 分流（speech 落库并广播 / dm 落库仅送达用户 / skip 吞掉） */
  private handleAgentResult(
    meetingId: string,
    participantId: string,
    text: string,
    kind: 'chatroom' | 'dm',
  ): void {
    if (kind === 'dm') {
      const p = this.getParticipant(meetingId, participantId);
      if (text.trim() && !isSkip(text)) {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'dm_agent', participantId: p.id, content: text,
        }));
      } else {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'system', participantId: p.id,
          content: `${p.displayName} 未能回复私信。`,
        }));
      }
      this.setAgentStatus(meetingId, participantId, 'idle');
      return;
    }
    if (!text.trim() || isSkip(text)) {
      this.setAgentStatus(meetingId, participantId, 'idle');
      return; // [SKIP]：不落库、不分发
    }
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'speech', participantId, content: text,
    });
    this.emitMessage(msg);
    this.setAgentStatus(meetingId, participantId, 'idle');
    this.broadcastChatroom(msg, participantId);
  }

  /** 创建常驻会话并接线回调 */
  private createSessionFor(meetingId: string, p: ParticipantRow): AgentSessionLike {
    const m = this.getMeeting(meetingId);
    const session = this.sessionFactory.create({
      systemPrompt: this.buildSystemPrompt(meetingId, p.id),
      cwd: m.workspacePath,
      resumeSessionId: p.sdkSessionId ?? undefined,
      callbacks: {
        onSessionId: (sid) => {
          this.db.update(participants)
            .set({ sdkSessionId: sid })
            .where(eq(participants.id, p.id)).run();
        },
        onTool: (tool, detail) =>
          this.setAgentStatus(meetingId, p.id, 'tool', `${tool} ${detail}`.trim()),
        onResult: (text, kind) => this.handleAgentResult(meetingId, p.id, text, kind),
        onRestart: () => this.catchUp(meetingId, p.id),
        onDead: () => this.setAgentStatus(meetingId, p.id, 'offline'),
      },
    });
    session.start();
    this.sessionsOf(meetingId).set(p.id, session);
    return session;
  }

  /** 向某成员推送指令 + 其水位线之后的全部增量（开场/恢复/入会/崩溃重建共用） */
  private catchUp(meetingId: string, participantId: string, directive?: string): void {
    const sessions = this.sessionsOf(meetingId);
    const s = sessions.get(participantId);
    if (!s) return;
    const increment = collectChatroomIncrement(this.db, meetingId, participantId);
    const text = buildKickoffPrompt({
      directive:
        directive ??
        '[system] 以下是会议的最新讨论记录，请关注后续推送并在有话可说时发言。',
      history: increment,
      senders: this.senderInfoMap(meetingId),
    });
    s.push(text);
    if (increment.length) {
      this.db.update(participants)
        .set({ lastInjectedMsgId: increment[increment.length - 1].id })
        .where(eq(participants.id, participantId)).run();
    }
  }

  // ---------- 运行控制 ----------

  isRunning(meetingId: string): boolean {
    return (this.sessions.get(meetingId)?.size ?? 0) > 0;
  }

  start(meetingId: string): void {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法开始');
    this.setStatus(meetingId, 'active');
    for (const p of this.getParticipants(meetingId)) {
      if (this.sessionsOf(meetingId).has(p.id)) continue;
      this.setAgentStatus(meetingId, p.id, 'thinking');
      this.createSessionFor(meetingId, p);
      const resume = !!p.sdkSessionId;
      this.catchUp(meetingId, p.id, resume
        ? `[system] 会议「${m.title}」继续进行。`
        : `[system] 会议「${m.title}」现在开始，主题：${m.topic}。请简短表态开场。`);
    }
  }

  private setStatus(meetingId: string, status: MeetingStatus): void {
    this.db.update(meetings)
      .set({ status, ...(status === 'ended' ? { endedAt: Date.now() } : {}) })
      .where(eq(meetings.id, meetingId)).run();
    emitMeetingEvent({ type: 'meeting_status', meetingId, status });
  }

  private async closeSessions(meetingId: string): Promise<void> {
    const sessions = this.sessions.get(meetingId);
    if (!sessions) return;
    this.sessions.delete(meetingId);
    await Promise.allSettled([...sessions.values()].map((s) => s.close()));
    for (const p of this.getParticipants(meetingId)) {
      this.setAgentStatus(meetingId, p.id, 'idle');
    }
  }

  async pause(meetingId: string): Promise<void> {
    if (this.getMeeting(meetingId).status === 'active') this.setStatus(meetingId, 'paused');
    await this.closeSessions(meetingId);
  }

  async resume(meetingId: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法继续');
    this.start(meetingId);
  }

  async end(meetingId: string): Promise<void> {
    await this.closeSessions(meetingId);
    this.setStatus(meetingId, 'ended');
    const m = this.getMeeting(meetingId);
    const closing = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `会议「${m.title}」已结束。`,
    });
    this.emitMessage(closing);
  }

  /** 服务器重启后恢复所有 active 会议（与 resume 同路径） */
  recoverActiveMeetings(): void {
    const active = this.db.select().from(meetings)
      .where(eq(meetings.status, 'active')).all();
    for (const m of active) {
      try {
        this.start(m.id);
      } catch (e) {
        console.error(`[engine] 恢复会议 ${m.id} 失败:`, e);
      }
    }
  }

  // ---------- 用户消息与私聊 ----------

  sendUserMessage(meetingId: string, content: string): MessageRow {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法发言');
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'user', content,
    });
    this.emitMessage(msg);
    if (m.status === 'active') this.broadcastChatroom(msg);
    return msg;
  }

  async sendDm(meetingId: string, participantId: string, content: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法私聊');
    const p = this.getParticipant(meetingId, participantId);
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'dm', kind: 'dm_user', participantId: p.id, content,
    }));
    if (m.status === 'active' && this.sessionsOf(meetingId).has(p.id)) {
      // 常驻会话在线：直接推私信（禁言不影响私信）
      const s = this.sessionsOf(meetingId).get(p.id)!;
      this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
      s.push(buildDmPrompt(content), 'dm');
    } else {
      // 暂停中：一次性会话回合（resume 原会话链，结束即关）
      await this.runDmOffline(meetingId, p, content);
    }
  }

  /** 暂停状态下的一次性私聊回合 */
  private async runDmOffline(
    meetingId: string,
    p: ParticipantRow,
    content: string,
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    let done!: () => void;
    const gate = new Promise<void>((r) => (done = r));
    this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
    const session = this.sessionFactory.create({
      systemPrompt: this.buildSystemPrompt(meetingId, p.id),
      cwd: m.workspacePath,
      resumeSessionId: p.sdkSessionId ?? undefined,
      callbacks: {
        onSessionId: (sid) => {
          this.db.update(participants)
            .set({ sdkSessionId: sid })
            .where(eq(participants.id, p.id)).run();
        },
        onTool: (tool, detail) =>
          this.setAgentStatus(meetingId, p.id, 'tool', `${tool} ${detail}`.trim()),
        onResult: (text) => {
          this.handleAgentResult(meetingId, p.id, text, 'dm');
          done();
        },
        onRestart: () => {},
        onDead: () => {
          this.emitMessage(this.insertMessage({
            meetingId, channel: 'dm', kind: 'system', participantId: p.id,
            content: `${p.displayName} 私信回复失败。`,
          }));
          done();
        },
      },
    });
    session.start();
    session.push(buildDmPrompt(content), 'dm');
    await gate;
    await session.close();
    this.setAgentStatus(meetingId, p.id, 'idle');
  }

  // ---------- 动态成员管理 ----------

  addParticipant(
    meetingId: string,
    input: { templateId: string; displayName: string; goal: string },
  ): ParticipantRow {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法添加成员');
    const existing = this.getParticipants(meetingId);
    if (existing.length >= 8) throw new Error('参会者已达上限 8');
    if (!input.displayName?.trim() || !input.goal?.trim()) {
      throw new Error('名字与目标不能为空');
    }
    if (!this.agentMap().has(input.templateId)) throw new Error(`模板 ${input.templateId} 不存在`);

    const row: ParticipantRow = {
      id: randomUUID(),
      meetingId,
      templateId: input.templateId,
      displayName: input.displayName.trim(),
      goal: input.goal.trim(),
      muted: 0,
      sdkSessionId: null,
      speakOrder: existing.length,
      lastInjectedMsgId: 0,
    };
    this.db.insert(participants).values(row).run();

    const join = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `${row.displayName} 加入会议。`,
    });
    this.emitMessage(join);
    emitMeetingEvent({ type: 'participant', meetingId, participant: this.participantInfo(row) });

    if (m.status === 'active') {
      this.setAgentStatus(meetingId, row.id, 'thinking');
      this.createSessionFor(meetingId, row);
      this.catchUp(meetingId, row.id,
        `[system] 你中途加入会议「${m.title}」（主题：${m.topic}）。你是「${row.displayName}」，你的会议目标：${row.goal}。以下是会议到目前为止的全部记录，请先简短自我介绍并给出初步观点。`);
    }
    return row;
  }

  setMuted(meetingId: string, participantId: string, muted: boolean): ParticipantRow {
    const p = this.getParticipant(meetingId, participantId);
    this.db.update(participants)
      .set({ muted: muted ? 1 : 0 })
      .where(eq(participants.id, p.id)).run();
    const updated = this.getParticipant(meetingId, participantId);
    emitMeetingEvent({ type: 'participant', meetingId, participant: this.participantInfo(updated) });
    return updated;
  }
}

export type { MeetingStatus };
```

**注意**：engine.ts 引用了 `./session-factory`——Task 4 Step 5 创建它。

- [ ] **Step 5: 创建 session-factory.ts（engine 与测试的接缝）**

```typescript
// src/core/session-factory.ts
import { AgentSession, type AgentSessionCallbacks, type QueryFactory } from './agent-session';
import { query } from '@anthropic-ai/claude-agent-sdk';

/** engine 依赖的最小会话接口（测试用 FakeSession 替换） */
export interface AgentSessionLike {
  start(): void;
  push(text: string, kind?: 'chatroom' | 'dm'): void;
  close(): Promise<void>;
}

export interface SessionCreateOptions {
  systemPrompt: string;
  cwd: string;
  resumeSessionId?: string;
  callbacks: AgentSessionCallbacks;
}

export interface SessionFactory {
  create(opts: SessionCreateOptions): AgentSessionLike;
}

const sdkQueryFactory: QueryFactory = ({ prompt, options }) =>
  query({ prompt, options });

export const defaultSessionFactory: SessionFactory = {
  create: (opts) =>
    new AgentSession({ ...opts, queryFactory: sdkQueryFactory }),
};
```

（若 SDK 类型对 `query({ prompt, options })` 报窄化错误，在 sdkQueryFactory 内做一次类型断言 `query({ prompt, options } as Parameters<typeof query>[0])`。）

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/engine-create.test.ts tests/events.test.ts tests/agent-session.test.ts tests/injector.test.ts`
预期：PASS

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: engine 核心重构——常驻会话分发、禁言、动态加人、暂停/恢复/结束统一路径"
```

---

### Task 5: 分发矩阵测试（engine-dispatch）

**Files:**
- Test: `tests/engine-dispatch.test.ts`（新建，替代 engine-loop.test.ts）
- Delete: `tests/engine-loop.test.ts`

- [ ] **Step 1: 创建共享测试工具 tests/fake-session.ts**

```typescript
// tests/fake-session.ts —— dispatch/dm/control/api 四个测试文件共用
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine } from '@/core/engine';
import type { SessionCreateOptions } from '@/core/session-factory';

/** 假会话：记录 push，测试手动触发回调 */
export class FakeSession {
  started = false;
  closed = false;
  pushes: { text: string; kind: 'chatroom' | 'dm' }[] = [];
  constructor(public opts: SessionCreateOptions) {}
  start() { this.started = true; }
  push(text: string, kind: 'chatroom' | 'dm' = 'chatroom') { this.pushes.push({ text, kind }); }
  async close() { this.closed = true; }
}

/** 构造带 FakeSession 工厂的 engine 与一个 2 人测试会议 */
export function setupEngine() {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const sessions: FakeSession[] = [];
  const engine = new MeetingEngine(db, {
    create: (opts: SessionCreateOptions) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s;
    },
  });
  const m = engine.createMeeting({
    title: 't',
    topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    participants: [
      { templateId: 'dev', displayName: '张工', goal: '激进派' },
      { templateId: 'test', displayName: '李测试', goal: '保守派' },
    ],
  });
  return { db, engine, m, sessions };
}
```

- [ ] **Step 2: 写分发矩阵测试**

```typescript
// tests/engine-dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { setupEngine } from './fake-session';
import { messages, participants } from '@/db/schema';

describe('分发矩阵', () => {
  it('start：为每个成员建会话并推送开场指令（含开场系统消息增量）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    expect(sessions.length).toBe(2);
    expect(sessions.every((s) => s.started)).toBe(true);
    const first = sessions[0].pushes[0];
    expect(first.kind).toBe('chatroom');
    expect(first.text).toContain('现在开始');
    expect(first.text).toContain('[system]'); // 开场系统消息作为增量
  });

  it('用户消息：广播给所有在线成员（各自水位线推进）', () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '大家怎么看？');
    for (const s of sessions) {
      expect(s.pushes.length).toBe(1);
      expect(s.pushes[0].text).toBe('[chatroom 用户] 大家怎么看？');
    }
    const ps = db.select().from(participants).all();
    // 两个成员的水位线都推进到了最新消息 id
    const maxId = db.select().from(messages).all()
      .reduce((a, b) => (b.id > a ? b.id : a), 0);
    expect(ps.every((p) => p.lastInjectedMsgId === maxId)).toBe(true);
  });

  it('agent 发言：落库并广播给其他人（不含自己）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onResult('我主张重写', 'chatroom');
    const speeches = engine.getMessages(m.id).filter((x) => x.kind === 'speech');
    expect(speeches.length).toBe(1);
    expect(speeches[0].participantId).toBe(ps[0].id);
    expect(sessions[0].pushes.length).toBe(0); // 不推给自己
    expect(sessions[1].pushes.length).toBe(1);
    expect(sessions[1].pushes[0].text).toContain('[chatroom 张工·研发] 我主张重写');
  });

  it('[SKIP]：不落库不分发', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onResult('[SKIP]', 'chatroom');
    sessions[1].opts.callbacks.onResult('', 'chatroom');
    expect(engine.getMessages(m.id).filter((x) => x.kind === 'speech').length).toBe(0);
    expect(sessions.every((s) => s.pushes.length === 0)).toBe(true);
  });

  it('禁言成员：仍收到广播但带禁言后缀', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[1].id, true);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '继续');
    expect(sessions[1].pushes[0].text).toContain('禁言');
    expect(sessions[1].pushes[0].text).toContain('[chatroom 用户] 继续');
    expect(sessions[0].pushes[0].text).not.toContain('禁言');
  });

  it('工具活动：仅状态事件，不进聊天室', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions[0].opts.callbacks.onTool('Read', '/a.ts');
    const msgs = engine.getMessages(m.id);
    expect(msgs.every((x) => !x.content.includes('/a.ts'))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/engine-dispatch.test.ts`
预期：PASS（engine 已在 Task 4 实现）。若有 FAIL，修 engine 直至通过。

- [ ] **Step 3: 删除旧 engine-loop.test.ts 并提交**

```bash
git rm tests/engine-loop.test.ts
git add -A && git commit -m "test: 分发矩阵测试（用户广播/发言广播/SKIP 吞掉/禁言后缀/工具不进聊天室）"
```

---

### Task 6: DM 即时响应测试（engine-dm 重写）

**Files:**
- Test: `tests/engine-dm.test.ts`（全量重写）

- [ ] **Step 1: 写测试**

```typescript
// tests/engine-dm.test.ts
import { describe, it, expect } from 'vitest';
import { setupEngine } from './fake-session';

describe('私聊', () => {
  it('active 会议：DM 立即推入目标会话（kind=dm），其他人不收', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '私下聊聊？');
    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].kind).toBe('dm');
    expect(sessions[0].pushes[0].text).toContain('私下聊聊？');
    expect(sessions[1].pushes.length).toBe(0);
  });

  it('DM 回复落库为 dm_agent，不进聊天室广播', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '在吗');
    sessions[0].opts.callbacks.onResult('在的，说吧', 'dm');
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'dm_agent']);
    expect(sessions[1].pushes.length).toBe(0); // 不广播
  });

  it('禁言不影响私信', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '还是聊聊');
    expect(sessions[0].pushes[0].kind).toBe('dm');
    expect(sessions[0].pushes[0].text).not.toContain('禁言');
  });

  it('paused 会议：DM 走一次性会话（回复后关闭）', async () => {
    const { engine, m, sessions } = setupEngine();
    const ps = engine.getParticipants(m.id);
    // 不 start：会议 paused，工厂此时创建一次性 FakeSession（sessions[0]）
    const dmPromise = engine.sendDm(m.id, ps[0].id, '暂停时也找你');
    const offline = sessions[0];
    expect(offline.started).toBe(true);
    expect(offline.pushes[0].kind).toBe('dm');
    // sendDm 的 promise 在收到 onResult 前不 resolve——手动触发回复
    offline.opts.callbacks.onResult('收到', 'dm');
    await dmPromise;
    expect(offline.closed).toBe(true);
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'dm_agent']);
  });
});
```

**注意**：第 4 个用例中 sendDm 返回的 promise 在 onResult 前不 resolve——测试先触发 push、再手动 onResult、再 await，这正是验证「一次性回合等待回复后关闭」。

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/engine-dm.test.ts`
预期：PASS。修 engine 直至通过。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: 私聊即时推送/一次性离线回合/禁言不影响私信"
```

---

### Task 7: 会议控制与动态成员测试（engine-control 重写 + 清理竞态红用例）

**Files:**
- Test: `tests/engine-control.test.ts`（全量重写）
- Delete: `tests/a-batch-race-repro.test.ts`、`tests/README.md`

- [ ] **Step 1: 写测试**

```typescript
// tests/engine-control.test.ts
import { describe, it, expect } from 'vitest';
import { setupEngine, FakeSession } from './fake-session';
import { MeetingEngine } from '@/core/engine';
import type { SessionCreateOptions } from '@/core/session-factory';

describe('会议控制', () => {
  it('pause：关闭全部会话、状态 paused；期间消息只落库不推送', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    await engine.pause(m.id);
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(engine.getMeeting(m.id).status).toBe('paused');
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '暂停期间的消息');
    expect(sessions.every((s) => s.pushes.length === 0)).toBe(true);
    // 消息确实落库了
    expect(engine.getMessages(m.id).some((x) => x.content === '暂停期间的消息')).toBe(true);
  });

  it('resume：重建会话并补发暂停期间增量', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    // 会话有 sessionId（模拟已发言），resume 应走「继续」路径
    sessions[0].opts.callbacks.onSessionId('s-keep');
    await engine.pause(m.id);
    engine.sendUserMessage(m.id, '暂停期间的重要消息');
    const before = sessions.length;
    engine.resume(m.id);
    expect(sessions.length).toBe(before + 2); // 全部重建
    const rebuilt = sessions[sessions.length - 2];
    expect(rebuilt.opts.resumeSessionId).toBe('s-keep');
    expect(rebuilt.pushes[0].text).toContain('暂停期间的重要消息');
    expect(rebuilt.pushes[0].text).toContain('继续进行');
    // 另一成员无 sessionId → 全新会话
    expect(sessions[sessions.length - 1].opts.resumeSessionId).toBeUndefined();
  });

  it('end：关闭会话、落库结束消息、拒绝再操作', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    await engine.end(m.id);
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(engine.getMeeting(m.id).status).toBe('ended');
    expect(engine.getMessages(m.id).some((x) => x.content.includes('已结束'))).toBe(true);
    expect(() => engine.sendUserMessage(m.id, 'x')).toThrow(/结束/);
    expect(() => engine.start(m.id)).toThrow(/结束/);
  });

  it('崩溃重建：onRestart 后按水位线补发增量', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '崩溃前的消息');
    sessions[0].pushes = [];
    sessions[0].opts.callbacks.onRestart();
    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].text).toContain('崩溃前的消息');
  });

  it('重建也失败：onDead → offline 状态，会议不受影响', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    expect(() => sessions[0].opts.callbacks.onDead()).not.toThrow();
    expect(engine.getMeeting(m.id).status).toBe('active');
  });
});

describe('动态成员管理', () => {
  it('active 会议添加成员：落库、入会消息、建会话并推送全部历史', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    engine.sendUserMessage(m.id, '第一条历史');
    const before = sessions.length;
    const row = engine.addParticipant(m.id, {
      templateId: 'architect', displayName: '王架构', goal: '全局视角把控',
    });
    expect(engine.getParticipants(m.id).length).toBe(3);
    expect(engine.getMeeting(m.id).status).toBe('active');
    expect(sessions.length).toBe(before + 1);
    const joinPush = sessions[sessions.length - 1].pushes[0].text;
    expect(joinPush).toContain('王架构');
    expect(joinPush).toContain('中途加入');
    expect(joinPush).toContain('[chatroom 用户] 第一条历史'); // 全部历史（水位线 0）
    // 新成员水位线推进到最新
    const p = engine.getParticipant(m.id, row.id);
    expect(p.lastInjectedMsgId).toBeGreaterThan(0);
  });

  it('paused 会议添加成员：仅落库（resume 时统一重建）', async () => {
    const { engine, m, sessions } = setupEngine();
    const before = sessions.length;
    engine.addParticipant(m.id, {
      templateId: 'analyst', displayName: '赵分析', goal: '数据支撑',
    });
    expect(sessions.length).toBe(before); // 没有新会话
    expect(engine.getParticipants(m.id).length).toBe(3);
  });

  it('上限与校验：第 9 人拒绝、空名字拒绝、ended 拒绝', async () => {
    const { engine, m } = setupEngine();
    for (let i = 0; i < 6; i++) {
      engine.addParticipant(m.id, {
        templateId: 'dev', displayName: `成员${i}`, goal: 'g',
      });
    }
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: '超了', goal: 'g',
    })).toThrow(/8/);
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: '', goal: 'g',
    })).toThrow(/名字/);
    await engine.end(m.id);
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: 'x', goal: 'g',
    })).toThrow(/结束/);
  });

  it('setMuted：更新并广播 participant 事件', async () => {
    const { engine, m } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const updated = engine.setMuted(m.id, ps[0].id, true);
    expect(updated.muted).toBe(1);
    expect(engine.getParticipant(m.id, ps[0].id).muted).toBe(1);
  });
});

describe('服务器重启恢复', () => {
  it('recoverActiveMeetings：重启 engine 后 active 会议自动重建会话', async () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions[0].opts.callbacks.onSessionId('s-recover');
    // 模拟重启：旧 engine 的内存会话消失，新 engine 实例（同一 db）
    const created2: FakeSession[] = [];
    const engine2 = new MeetingEngine(db, {
      create: (opts: SessionCreateOptions) => {
        const s = new FakeSession(opts);
        created2.push(s);
        return s;
      },
    });
    engine.sendUserMessage(m.id, '重启前的消息');
    engine2.recoverActiveMeetings();
    expect(created2.length).toBe(2);
    expect(created2[0].opts.resumeSessionId).toBe('s-recover');
    expect(created2[0].pushes[0].text).toContain('重启前的消息');
    // paused 会议不在恢复范围：engine2 未为它建任何会话
    const pausedEnv = setupEngine();
    await pausedEnv.engine.pause(pausedEnv.m.id);
    const created3: FakeSession[] = [];
    const engine3 = new MeetingEngine(pausedEnv.db, {
      create: (opts: SessionCreateOptions) => {
        const s = new FakeSession(opts);
        created3.push(s);
        return s;
      },
    });
    engine3.recoverActiveMeetings();
    expect(created3.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/engine-control.test.ts`
预期：PASS。

- [ ] **Step 3: 删除竞态红用例与 README**

```bash
git rm tests/a-batch-race-repro.test.ts tests/README.md
```

（竞态根源（loops 轮询循环）已被整体替换；新 pause/resume 语义在上方用例覆盖。README 中的 vi.waitFor 教训已体现在新测试中——所有 waitFor 回调都用 expect 抛错式。）

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: 会议控制/动态成员/重启恢复；删除旧轮询竞态红用例"
```

---

### Task 8: API 路由更新（禁言 + 动态成员 + 删 extend）

**Files:**
- Modify: `src/app/api/meetings/[id]/[action]/route.ts`
- Modify: `src/app/api/meetings/[id]/dm/route.ts`
- Create: `src/app/api/meetings/[id]/participants/route.ts`
- Create: `src/app/api/meetings/[id]/participants/[participantId]/route.ts`
- Modify: `src/core/engine-instance.ts`
- Test: `tests/api.test.ts`（重写）

- [ ] **Step 1: 写失败测试（完整文件，基于 v1 已验证的 mock 结构；engine 注入 FakeSession 工厂避免真实 SDK）**

```typescript
// tests/api.test.ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  const db = actual.createTestDb();
  return { ...actual, getDb: () => db };
});

vi.mock('@/core/engine-instance', async () => {
  const { getDb } = await import('@/db/client');
  const { importAgentsToDb, loadAgentFiles } = await import('@/core/agent-config');
  const { MeetingEngine } = await import('@/core/engine');
  const { FakeSession } = await import('./fake-session');
  const db = getDb(); // 与上面 mock 的 getDb 共享同一内存库
  importAgentsToDb(db, loadAgentFiles());
  const sessions: FakeSession[] = [];
  const engine = new MeetingEngine(db, {
    create: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s;
    },
  });
  return { getEngine: () => engine };
});

import { NextRequest } from 'next/server';
import { POST as createMeeting, GET as listMeetings } from '@/app/api/meetings/route';
import { POST as action } from '@/app/api/meetings/[id]/[action]/route';
import { POST as sendMessage } from '@/app/api/meetings/[id]/messages/route';
import { POST as addParticipant } from '@/app/api/meetings/[id]/participants/route';
import { PATCH as patchParticipant } from '@/app/api/meetings/[id]/participants/[participantId]/route';
import { POST as sendDm } from '@/app/api/meetings/[id]/dm/route';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));

const body = () => ({
  title: 't', topic: 'tp', workspacePath: ws(),
  participants: [
    { templateId: 'dev', displayName: '张工', goal: '激进派' },
    { templateId: 'test', displayName: '李测试', goal: '保守派' },
  ],
});

describe('api', () => {
  it('创建会议（新结构）→ 列表可见 → 用户发言', async () => {
    const res = await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }));
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.id).toBeTruthy();

    const list = await listMeetings();
    expect((await list.json()).length).toBeGreaterThanOrEqual(1);

    const msgRes = await sendMessage(
      new NextRequest(`http://x/api/meetings/${created.id}/messages`, {
        method: 'POST', body: JSON.stringify({ content: 'hello' }),
      }) as Parameters<typeof sendMessage>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(msgRes.status).toBe(200);
  });

  it('缺 displayName 创建返回 400', async () => {
    const bad = body();
    bad.participants[0].displayName = '';
    const res = await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(bad),
    }));
    expect(res.status).toBe(400);
  });

  it('动态添加成员：有效返回 201；无效模板返回 400', async () => {
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }))).json();
    const ok = await addParticipant(
      new NextRequest(`http://x/api/meetings/${created.id}/participants`, {
        method: 'POST',
        body: JSON.stringify({ templateId: 'architect', displayName: '王架构', goal: '把关' }),
      }) as Parameters<typeof addParticipant>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(ok.status).toBe(201);
    const row = await ok.json();
    expect(row.displayName).toBe('王架构');

    const bad = await addParticipant(
      new NextRequest(`http://x/api/meetings/${created.id}/participants`, {
        method: 'POST',
        body: JSON.stringify({ templateId: 'nope', displayName: 'x', goal: 'g' }),
      }) as Parameters<typeof addParticipant>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(bad.status).toBe(400);
  });

  it('PATCH 禁言：返回 muted=1 的 participant', async () => {
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }))).json();
    const engine = (await import('@/core/engine-instance')).getEngine();
    const ps = engine.getParticipants(created.id);
    const res = await patchParticipant(
      new NextRequest(`http://x/api/meetings/${created.id}/participants/${ps[0].id}`, {
        method: 'PATCH', body: JSON.stringify({ muted: true }),
      }) as Parameters<typeof patchParticipant>[0],
      { params: Promise.resolve({ id: created.id, participantId: ps[0].id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).muted).toBe(1);
  });

  it('DM（participantId 语义）返回 200（active 会话路径，push 即返回不等待）', async () => {
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }))).json();
    const engine = (await import('@/core/engine-instance')).getEngine();
    engine.start(created.id); // FakeSession 工厂：无真实 SDK
    const ps = engine.getParticipants(created.id);
    const res = await sendDm(
      new NextRequest(`http://x/api/meetings/${created.id}/dm`, {
        method: 'POST',
        body: JSON.stringify({ participantId: ps[0].id, content: '在吗' }),
      }) as Parameters<typeof sendDm>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(res.status).toBe(200);
  });

  it('非法 action 与 extend 均返回 400', async () => {
    for (const act of ['bad', 'extend']) {
      const res = await action(
        new NextRequest(`http://x/api/meetings/m1/${act}`, { method: 'POST' }) as Parameters<typeof action>[0],
        { params: Promise.resolve({ id: 'm1', action: act }) },
      );
      expect(res.status).toBe(400);
    }
  });
});
```

- [ ] **Step 2: 更新路由**

```typescript
// src/app/api/meetings/[id]/[action]/route.ts
import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await ctx.params;
  const engine = getEngine();
  try {
    switch (action) {
      case 'start':
        engine.start(id);
        return Response.json({ ok: true });
      case 'pause':
        await engine.pause(id);
        return Response.json({ ok: true });
      case 'resume':
        await engine.resume(id);
        return Response.json({ ok: true });
      case 'end':
        await engine.end(id);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: `未知操作 ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

```typescript
// src/app/api/meetings/[id]/dm/route.ts
import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { participantId, content } = await req.json();
    await getEngine().sendDm(id, String(participantId), String(content));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

```typescript
// src/app/api/meetings/[id]/participants/route.ts
import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const p = getEngine().addParticipant(id, {
      templateId: String(body.templateId),
      displayName: String(body.displayName ?? ''),
      goal: String(body.goal ?? ''),
    });
    return Response.json(p, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

```typescript
// src/app/api/meetings/[id]/participants/[participantId]/route.ts
import { getEngine } from '@/core/engine-instance';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; participantId: string }> },
) {
  const { id, participantId } = await ctx.params;
  try {
    const { muted } = await req.json();
    const p = getEngine().setMuted(id, participantId, !!muted);
    return Response.json(p);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

```typescript
// src/core/engine-instance.ts
import { getDb } from '@/db/client';
import { MeetingEngine } from './engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

export function getEngine(): MeetingEngine {
  if (!g.__meetingEngine) {
    const engine = new MeetingEngine(getDb());
    g.__meetingEngine = engine;
    // 服务器重启/热重载后：恢复所有进行中的会议（异步，不阻塞）
    engine.recoverActiveMeetings();
  }
  return g.__meetingEngine;
}
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/api.test.ts`
预期：PASS

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: 动态成员与禁言 API；启动恢复 active 会议；移除 extend"
```

---

### Task 9: UI 全套改造

**Files:**
- Rewrite: `src/components/room/types.ts`、`Room.tsx`、`AgentCard.tsx`
- Modify: `src/components/room/ChatPanel.tsx`、`DmDrawer.tsx`
- Create: `src/components/room/AddMemberDialog.tsx`
- Rewrite: `src/app/meetings/new/page.tsx`、`src/app/meetings/[id]/page.tsx`

- [ ] **Step 1: types.ts**

```typescript
// src/components/room/types.ts
import type { MeetingRow, MessageRow } from '@/db/schema';
import type { AgentStatus, ParticipantInfo } from '@/lib/events';

export interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

export interface ParticipantView extends ParticipantInfo {
  capability: string;
  avatar: string;
}

export interface RoomData {
  meeting: MeetingRow;
  participants: ParticipantView[];
  messages: MessageRow[];
}

export type { AgentStatus };
```

- [ ] **Step 2: AgentCard.tsx（displayName/goal/禁言/offline）**

```tsx
// src/components/room/AgentCard.tsx
import type { ParticipantView, AgentState } from './types';

const stateLabel: Record<string, string> = {
  idle: '',
  thinking: '思考中…',
  tool: '使用工具中',
  speaking: '发言中…',
  offline: '掉线',
};

export default function AgentCard({
  participant,
  state,
  meetingActive,
  onDm,
  onToggleMute,
}: {
  participant: ParticipantView;
  state: { status: AgentState; detail?: string };
  meetingActive: boolean;
  onDm: () => void;
  onToggleMute: () => void;
}) {
  const busy = state.status !== 'idle' && state.status !== 'offline';
  return (
    <div className={`rounded border p-2 ${participant.muted ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{participant.avatar}</span>
        <span className="text-sm font-medium">{participant.displayName}</span>
        <span className="rounded bg-gray-100 px-1.5 text-[10px]">{participant.capability}</span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={onDm} className="text-[10px] text-blue-600 hover:underline">
            私聊
          </button>
          {meetingActive && (
            <button
              onClick={onToggleMute}
              className={`text-[10px] hover:underline ${participant.muted ? 'text-red-600' : 'text-gray-500'}`}
            >
              {participant.muted ? '解除禁言' : '禁言'}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-gray-600">{participant.goal}</p>
      {participant.muted && (
        <p className="mt-1 text-[11px] text-red-500">已被主持人禁言</p>
      )}
      {(busy || state.status === 'offline') && (
        <p className={`mt-1 animate-pulse text-[11px] ${state.status === 'offline' ? 'text-red-500' : 'text-blue-600'}`}>
          {stateLabel[state.status]}
          {state.detail ? `（${state.detail}）` : ''}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: ChatPanel.tsx（按 participantId、去 round）**

在现有文件上修改：`const byAgent = new Map(participants.map((p) => [p.agentId, p]))` 改为 `const byId = new Map(participants.map((p) => [p.id, p]))`；`m.agentId` 改 `m.participantId`；发言者行改为：

```tsx
const p = m.participantId ? byId.get(m.participantId) : undefined;
return (
  <div key={m.id} className="flex gap-2">
    <span className="text-xl">{p?.avatar ?? '🤖'}</span>
    <div>
      <p className="text-xs text-gray-500">
        {p?.displayName ?? '未知'} · {p?.capability}
      </p>
      <div className="mt-0.5 max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm">
        {m.content}
      </div>
    </div>
  </div>
);
```

（删除 `{m.round != null && ...}` 轮次显示。）

- [ ] **Step 4: DmDrawer.tsx（displayName）**

标题行改为 `{participant.avatar} 与 {participant.displayName} 私聊`。

- [ ] **Step 5: AddMemberDialog.tsx（新建）**

```tsx
// src/components/room/AddMemberDialog.tsx
'use client';

import { useEffect, useState } from 'react';

interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

export default function AddMemberDialog({
  meetingId,
  onClose,
}: {
  meetingId: string;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((list: TemplateInfo[]) => {
        setTemplates(list);
        if (list[0]) setTemplateId(list[0].id);
      })
      .catch(() => setError('加载模板失败'));
  }, []);

  const submit = async () => {
    setError('');
    if (!displayName.trim()) return setError('请填写名字');
    if (!goal.trim()) return setError('请填写会议目标');
    setBusy(true);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, displayName, goal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '添加失败');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded border px-3 py-2 text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-96 rounded-lg bg-white p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 font-semibold">添加成员</h3>

        <label className="mb-1 block text-sm">角色模板</label>
        <select className={input} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.avatar} {t.capability}——{t.description}
            </option>
          ))}
        </select>

        <label className="mb-1 mt-3 block text-sm">名字</label>
        <input className={input} placeholder="如：张工" value={displayName}
          onChange={(e) => setDisplayName(e.target.value)} />

        <label className="mb-1 mt-3 block text-sm">会议目标（立场/任务）</label>
        <input className={input} placeholder="如：激进派——主张全面重写" value={goal}
          onChange={(e) => setGoal(e.target.value)} />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-1.5 text-sm">取消</button>
          <button onClick={submit} disabled={busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
            {busy ? '添加中…' : '加入会议'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Room.tsx（全量重写）**

```tsx
// src/components/room/Room.tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import AgentCard from './AgentCard';
import ChatPanel from './ChatPanel';
import DmDrawer from './DmDrawer';
import AddMemberDialog from './AddMemberDialog';
import type { ParticipantView, RoomData, AgentState } from './types';

export type { ParticipantView, RoomData } from './types';

export default function Room({ initial }: { initial: RoomData }) {
  const [meeting, setMeeting] = useState(initial.meeting);
  const [participants, setParticipants] = useState(initial.participants);
  const [messages, setMessages] = useState(initial.messages);
  const [states, setStates] = useState<Record<string, { status: AgentState; detail?: string }>>({});
  const [dmTarget, setDmTarget] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const applyEvent = useCallback((e: MessageEvent) => {
    const data = JSON.parse(e.data);
    if (data.type === 'message') {
      setMessages((ms) =>
        ms.some((m) => m.id === data.message.id) ? ms : [...ms, data.message],
      );
    } else if (data.type === 'agent_status') {
      setStates((s) => ({
        ...s,
        [data.participantId]: { status: data.status, detail: data.detail },
      }));
    } else if (data.type === 'participant') {
      const info = data.participant;
      setParticipants((ps) => {
        const exists = ps.some((p) => p.id === info.id);
        return exists
          ? ps.map((p) => (p.id === info.id ? { ...p, ...info } : p))
          : [...ps, info];
      });
    } else if (data.type === 'meeting_status') {
      setMeeting((m) => ({ ...m, status: data.status }));
    }
  }, []);

  useEffect(() => {
    const es = new EventSource(`/api/meetings/${initial.meeting.id}/events`);
    es.onmessage = applyEvent;
    return () => es.close();
  }, [initial.meeting.id, applyEvent]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const act = async (action: string) => {
    const res = await fetch(`/api/meetings/${meeting.id}/${action}`, { method: 'POST' });
    if (res.ok && action === 'pause') setMeeting((m) => ({ ...m, status: 'paused' }));
    if (res.ok && (action === 'start' || action === 'resume')) {
      setMeeting((m) => ({ ...m, status: 'active' }));
    }
  };

  const toggleMute = async (participantId: string, muted: boolean) => {
    await fetch(`/api/meetings/${meeting.id}/participants/${participantId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted }),
    });
    setParticipants((ps) =>
      ps.map((p) => (p.id === participantId ? { ...p, muted } : p)),
    );
  };

  const sendChat = async (content: string) => {
    await fetch(`/api/meetings/${meeting.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  };

  const sendDm = async (participantId: string, content: string) => {
    await fetch(`/api/meetings/${meeting.id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId, content }),
    });
  };

  const dmParty = participants.find((p) => p.id === dmTarget);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r p-4">
        <h1 className="font-bold">{meeting.title}</h1>
        <p className="mt-1 text-xs text-gray-500">{meeting.topic}</p>
        <p className="mt-2 text-xs">状态：{meeting.status}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.status === 'paused' && (
            <button onClick={() => act('start')}
              className="rounded bg-green-600 px-3 py-1 text-xs text-white">
              开始/继续
            </button>
          )}
          {meeting.status === 'active' && (
            <button onClick={() => act('pause')} className="rounded bg-yellow-600 px-3 py-1 text-xs text-white">
              暂停
            </button>
          )}
          {meeting.status !== 'ended' && (
            <button onClick={() => act('end')} className="rounded bg-red-600 px-3 py-1 text-xs text-white">
              结束
            </button>
          )}
          {meeting.status !== 'ended' && (
            <button onClick={() => setShowAdd(true)} className="rounded bg-gray-600 px-3 py-1 text-xs text-white">
              + 添加成员
            </button>
          )}
        </div>
        <div className="mt-4 space-y-2">
          {participants.map((p) => (
            <AgentCard
              key={p.id}
              participant={p}
              state={states[p.id] ?? { status: 'idle' }}
              meetingActive={meeting.status === 'active'}
              onDm={() => setDmTarget(p.id)}
              onToggleMute={() => toggleMute(p.id, !p.muted)}
            />
          ))}
        </div>
      </aside>

      <ChatPanel
        messages={messages.filter((m) => m.channel === 'chatroom')}
        participants={participants}
        onSend={sendChat}
        disabled={meeting.status === 'ended'}
        bottomRef={bottomRef}
      />

      {dmParty && (
        <DmDrawer
          participant={dmParty}
          messages={messages.filter((m) => m.channel === 'dm' && m.participantId === dmParty.id)}
          onSend={(c) => sendDm(dmParty.id, c)}
          onClose={() => setDmTarget(null)}
          disabled={meeting.status === 'ended'}
        />
      )}

      {showAdd && (
        <AddMemberDialog meetingId={meeting.id} onClose={() => setShowAdd(false)} />
      )}
    </div>
  );
}
```

（说明：「开始/继续」统一调 `act('start')`——engine.start 对从未开始的 paused 与暂停后的重启是同一路径。）

- [ ] **Step 7: 新建会议页（模板+名字+目标）**

```tsx
// src/app/meetings/new/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

interface MemberDraft {
  key: number;
  templateId: string;
  displayName: string;
  goal: string;
}

export default function NewMeetingPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [members, setMembers] = useState<MemberDraft[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then((list: TemplateInfo[]) => {
        setTemplates(list);
        if (list[0]) {
          setMembers([
            { key: 1, templateId: list[0].id, displayName: '', goal: '' },
            { key: 2, templateId: list[1]?.id ?? list[0].id, displayName: '', goal: '' },
          ]);
        }
      })
      .catch(() => setError('加载模板列表失败'));
  }, []);

  const update = (key: number, patch: Partial<MemberDraft>) => {
    setMembers((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  };
  const add = () => {
    setMembers((ms) => [
      ...ms,
      { key: Date.now(), templateId: templates[0]?.id ?? '', displayName: '', goal: '' },
    ]);
  };
  const remove = (key: number) => {
    setMembers((ms) => ms.filter((m) => m.key !== key));
  };

  const submit = async () => {
    setError('');
    if (!title.trim()) return setError('请填写标题');
    if (!topic.trim()) return setError('请填写讨论话题');
    if (!workspacePath.trim()) return setError('请填写工作区路径');
    if (members.length < 2) return setError('至少 2 个成员');
    if (members.some((m) => !m.displayName.trim() || !m.goal.trim())) {
      return setError('请为每个成员填写名字与会议目标');
    }
    setBusy(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, topic, workspacePath,
          participants: members.map((m) => ({
            templateId: m.templateId, displayName: m.displayName, goal: m.goal,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? '创建失败');
      router.push(`/meetings/${data.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const input = 'w-full rounded border px-3 py-2 text-sm';

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-bold">新建会议</h1>

      <label className="mb-1 block text-sm font-medium">标题</label>
      <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} />

      <label className="mb-1 mt-4 block text-sm font-medium">讨论话题</label>
      <textarea className={input} rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} />

      <label className="mb-1 mt-4 block text-sm font-medium">工作区路径（成员可读写此目录）</label>
      <input className={input} placeholder="C:/Users/you/project/example"
        value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} />

      <h2 className="mb-2 mt-6 font-semibold">参会成员（选模板、起名字、定目标）</h2>
      <div className="space-y-3">
        {members.map((m) => (
          <div key={m.key} className="rounded border p-3">
            <div className="flex gap-2">
              <select className={input} value={m.templateId}
                onChange={(e) => update(m.key, { templateId: e.target.value })}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.avatar} {t.capability}
                  </option>
                ))}
              </select>
              <input className={input} placeholder="名字，如：张工"
                value={m.displayName} onChange={(e) => update(m.key, { displayName: e.target.value })} />
              {members.length > 2 && (
                <button onClick={() => remove(m.key)}
                  className="shrink-0 rounded border px-3 text-xs text-red-600">
                  移除
                </button>
              )}
            </div>
            <input className={`${input} mt-2`} placeholder="会议目标，如：激进派——主张全面重写"
              value={m.goal} onChange={(e) => update(m.key, { goal: e.target.value })} />
          </div>
        ))}
      </div>
      {members.length < 8 && (
        <button onClick={add} className="mt-2 rounded border px-4 py-1.5 text-sm">
          + 添加成员
        </button>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button onClick={submit} disabled={busy}
        className="mt-6 rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:opacity-50">
        {busy ? '创建中…' : '创建会议'}
      </button>
    </main>
  );
}
```

- [ ] **Step 8: 房间页组装**

```tsx
// src/app/meetings/[id]/page.tsx
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { getEngine } from '@/core/engine-instance';
import Room, { type RoomData } from '@/components/room/Room';

export const instant = false;

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const engine = getEngine();
  let data: RoomData;
  try {
    const meeting = engine.getMeeting(id);
    const participants = engine.getParticipants(id);
    const messages = engine.getMessages(id);
    const templates = getDb().select().from(agents).all();
    const tMap = new Map(templates.map((t) => [t.id, t]));
    data = {
      meeting,
      participants: participants.map((p) => {
        const t = tMap.get(p.templateId);
        return {
          id: p.id,
          templateId: p.templateId,
          displayName: p.displayName,
          goal: p.goal,
          muted: !!p.muted,
          speakOrder: p.speakOrder,
          capability: t?.capability ?? '',
          avatar: t?.avatar ?? '🤖',
        };
      }),
      messages,
    };
  } catch {
    notFound();
  }
  return <Room initial={data} />;
}
```

（SSE participant 事件只带 ParticipantInfo，UI 用旧 capability/avatar 合并——`{ ...p, ...info }` 保留展示字段。）

- [ ] **Step 9: 构建验证**

Run: `npx tsc --noEmit && npm run build`
预期：0 错误。（dev server 手测留到 Task 10。）

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: UI 改造——模板选择/名字/目标、禁言按钮、动态添加成员弹窗、去轮次"
```

---

### Task 10: 全量验证与端到端手测

**Files:** 无新文件

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
预期：全部 PASS（db 2、agent-config 2、injector 4、agent-session 5、events 2、engine-create 5、engine-dispatch 6、engine-dm 4、engine-control 10、api ≥6，总数 ≈46）。

- [ ] **Step 2: lint**

Run: `npm run lint`
预期：0 error（warning 可接受）。

- [ ] **Step 3: E2E 手测（真实 SDK）**

```bash
rm -f data/meetings.db
npm run dev
```

浏览器 `http://localhost:3000` 验证清单：

1. 新建会议：两个成员（研发「张工」激进派 + 测试「李测试」保守派），工作区填本仓库路径。
2. 点「开始」→ 两个成员几乎同时收到开场推送、状态思考中 → 各自发言落库，互相触发连锁回应。
3. 用户发言 → 成员实时响应（不再等轮次）。
4. 点某成员「禁言」→ 它对后续消息只回 [SKIP]（状态一闪即逝），聊天室无其发言；解除后恢复。
5. 私聊：active 时 DM 即时回复；暂停会议后 DM 仍能回复（一次性回合）。
6. 「+ 添加成员」：选架构师、起名「王架构」→ 卡片实时出现 → 它收到全部历史并自我介绍。
7. 暂停 → 继续：会话重建、补发暂停期间消息。
8. 结束：按钮变灰、聊天室出现结束系统消息；刷新页面历史完整回放。
9. 重启 dev server（active 会议存在时）：引擎自动恢复会话。
10. DM 通道正确性（uuid 绑定的真实行为）：快速连续给同一成员发聊天室消息+私信（构造 SDK batch 合并）→ 私信回复绝不进聊天室；观察某成员长工具循环触发 `error_max_turns` 后，其后续回复通道不错位。
11. 崩溃鲁棒性（可选）：会议进行中 kill 某成员的 CLI 子进程 → 自动重建（onRestart→catchUp 补发增量）；再 kill 一次 → 掉线标记、会议不受影响。

验证中发现问题：小问题当场修并补测试；架构级问题停下来与用户讨论。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: 全量验证通过；E2E 手测自由响应式会议"
```

---

## 实现勘误（Task 3 代码审查后修订）

Task 3 的计划代码块经代码审查发现三处缺陷，已在 commit `0a41dc8` 修复——**后续任务以 `src/core/agent-session.ts` 实际代码为准，勿照抄本计划 Task 3 Step 3 的代码块**：

1. **handleEnd 顺序修正**：先 `start()`（换新队列）再回调 `onRestart()`——原顺序下 engine 的 catchUp 补发会写入已死的旧队列（消息永久丢失且水位线已推进）。
2. **result 分支放宽**：`msg.type === 'result'` 任意 subtype 都出队销账；非 success 文本按空串 `onResult('', kind)`——error result（error_max_turns 等）同样是 turn 完成信号，只在 success 出队会让 DM 标记错位。
3. **DM 通道改用 uuid 绑定**（取代 pendingKinds 顺序数组）：push 时生成 uuid 记入 `Map<uuid, PushKind>`（SDKUserMessage 带 uuid 字段），result 按 `user_message_uuids`（prompt batch 合并时含全部成员 uuid）逐个销账，**含任一 dm 则按 dm 归并**（宁漏播不泄漏）；单数 `user_message_uuid` 次之；均缺失时按插入序回退（旧 producer 兼容）。SDK 文档（sdk.d.ts）确认 host 传入的 uuid 会被回显。另：consume 收到 init 时复位 `restarted`（连续失败才放弃）、catch 不再静默、onRestart/onDead 回调包 try/catch 防逃逸、close 为「请求关闭」语义（不等待当前 turn）。

对 engine 的影响：`AgentSessionCallbacks` 接口签名不变，Task 4 的 engine 代码无需调整；onRestart 触发时新队列已就绪，catchUp 可安全 push。

## 风险与回退

- **SDK streaming 行为不符预期**（如 push 不触发 turn、result 不逐条对应）：Task 3 的 AgentSession 测试先行暴露；E2E（Task 10）最终验证真实行为。~~若 push:result 一一对应假设被证伪，回退方案是「文本自标记」~~——已由 uuid 绑定机制解决（见上方实现勘误第 3 条），真实 CLI 的 batch 合并行为仍需 E2E 观察确认。
- **同一消息重复补发**（崩溃瞬间）：可接受——LLM 上下文重复一条消息无害。
- **回退**：本计划是纯重构，git revert 各任务提交即可回到 v1。
