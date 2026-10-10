# AI Meeting 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多 Agent 会议系统——多个平等 agent 轮流讨论话题，用户群聊 + 私聊双通道参与，会议持久化可召回继续。

**Architecture:** Next.js 单项目分层实现：`src/core`（会议引擎：轮次调度、消息注入、SDK 会话封装，不依赖 Next）+ `src/db`（Drizzle/SQLite）+ `src/app`（API Routes + UI）。每个 agent 一个 Claude Agent SDK 会话，私聊与会议共用该会话（同一上下文），工具调用仅作状态事件不进聊天室。

**Tech Stack:** Next.js 15 (App Router, TS) + @anthropic-ai/claude-agent-sdk + Drizzle ORM + better-sqlite3 + Tailwind CSS v4 + Vitest

**前置条件:** Node 18+；已安装 Claude Code CLI 且可运行（SDK 依赖）；`ANTHROPIC_API_KEY` 可用或 claude CLI 已登录；spec 见 `docs/superpowers/specs/2026-10-10-ai-meeting-design.md`

**与 spec 的差异:** 不建 `dm_threads` 表——私聊线程由 `messages` 表 `channel='dm' AND agent_id=X` 派生（避免冗余表，UI 查询等价）。

---

## 文件结构总览

| 文件 | 职责 |
|---|---|
| `src/db/schema.ts` | 5 张表定义（agents/meetings/participants/messages） |
| `src/db/client.ts` | DB 单例（globalThis 缓存）+ 测试用内存库 |
| `src/core/agent-config.ts` | agents/*.json 加载（zod 校验）+ upsert 入库 |
| `src/lib/events.ts` | 进程内事件总线 + SSE 事件类型 |
| `src/core/injector.ts` | 增量收集、注入组装、[SKIP] 识别 |
| `src/core/agent-runner.ts` | SDK 封装（单回合 query、工具活动提取） |
| `src/core/engine.ts` | 会议引擎（状态机、轮次循环、私聊回合） |
| `src/core/engine-instance.ts` | engine 全局单例 |
| `src/app/api/**` | REST + SSE 转接层 |
| `src/components/room/**` | 会议房间 client 组件 |
| `agents/*.json` | 内置 agent 配置 |

---

### Task 1: 项目脚手架

**Files:**
- Create: Next.js 脚手架生成（package.json, src/app 等）
- Create: `vitest.config.ts`, `drizzle.config.ts`, 修改 `next.config.ts`

- [ ] **Step 1: 生成 Next.js 项目**

在项目根目录（已有 `.git/`、`docs/`、`项目立项.md`，无冲突文件）：

```bash
cd "C:/Users/cndux/Desktop/project/ai-meeting"
npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --yes
```

Expected: 生成 package.json、src/app/ 等脚手架，依赖安装完成。

- [ ] **Step 2: 安装依赖**

```bash
npm i @anthropic-ai/claude-agent-sdk better-sqlite3 drizzle-orm zod
npm i -D drizzle-kit vitest @types/better-sqlite3
```

- [ ] **Step 3: 写配置文件**

`vitest.config.ts`：

```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: { environment: 'node' },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

`drizzle.config.ts`：

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

`next.config.ts`（整个替换）：

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
};

export default nextConfig;
```

`.gitignore` 追加：

```
data/
```

`package.json` scripts 增加：

```json
"test": "vitest run"
```

- [ ] **Step 4: 验证脚手架**

```bash
npm run build
```

Expected: 构建成功（此时还没有 API/DB 代码）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: Next.js 脚手架与工具链配置"
```

---

### Task 2: DB schema 与 client

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: 写 schema**

`src/db/schema.ts`：

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // slug，如 'dev'
  name: text('name').notNull(),
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
  maxRounds: integer('max_rounds').notNull().default(6),
  currentRound: integer('current_round').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  endedAt: integer('ended_at'),
});

export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  agentId: text('agent_id').notNull(),
  meetingRole: text('meeting_role').notNull(),
  sdkSessionId: text('sdk_session_id'),
  speakOrder: integer('speak_order').notNull(),
  lastInjectedMsgId: integer('last_injected_msg_id').notNull().default(0),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  meetingId: text('meeting_id').notNull(),
  channel: text('channel').notNull(), // chatroom | dm
  agentId: text('agent_id'), // dm 时=私聊对象；speech 时=发言者；user/system 为 null
  kind: text('kind').notNull(), // speech | user | system | dm_user | dm_agent
  content: text('content').notNull(),
  round: integer('round'),
  createdAt: integer('created_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
```

注意：`status` 默认 `paused`——会议创建后处于 paused，用户点「开始」才 active。

- [ ] **Step 2: 写 client**

`src/db/client.ts`：

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import fs from 'node:fs';
import * as schema from './schema';

export type DB = ReturnType<typeof createDrizzle>;

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

function applyMigrations(db: DB) {
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
}

// 全局单例：Next dev 热重载时避免重复打开连接
const g = globalThis as unknown as { __meetingDb?: DB };

export function getDb(): DB {
  if (g.__meetingDb) return g.__meetingDb;
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const sqlite = new Database(path.join(process.cwd(), 'data', 'meetings.db'));
  const db = createDrizzle(sqlite);
  applyMigrations(db);
  g.__meetingDb = db;
  return db;
}

// 测试专用：独立内存库
export function createTestDb(): DB {
  const sqlite = new Database(':memory:');
  const db = createDrizzle(sqlite);
  applyMigrations(db);
  return db;
}
```

- [ ] **Step 3: 生成迁移**

```bash
npx drizzle-kit generate
```

Expected: 生成 `drizzle/0000_*.sql` 与 `drizzle/meta/`。

- [ ] **Step 4: 写测试**

`tests/db.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { meetings } from '@/db/schema';

describe('db', () => {
  it('迁移已应用，可插入并读回', () => {
    const db = createTestDb();
    db.insert(meetings)
      .values({ id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', createdAt: 1 })
      .run();
    const row = db.select().from(meetings).all()[0];
    expect(row.id).toBe('m1');
    expect(row.status).toBe('paused');
    expect(row.maxRounds).toBe(6);
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/db drizzle tests/db.test.ts
git commit -m "feat: 数据库 schema、迁移与 client"
```

---

### Task 3: agent 配置文件加载

**Files:**
- Create: `agents/dev.json`, `agents/test.json`, `agents/debate.json`, `agents/analyst.json`
- Create: `src/core/agent-config.ts`
- Test: `tests/agent-config.test.ts`

- [ ] **Step 1: 写 4 个内置 agent 配置**

`agents/dev.json`：

```json
{
  "id": "dev",
  "name": "老王",
  "capability": "研发",
  "description": "资深后端工程师，重视架构简洁性和可维护性",
  "persona": "你是一名资深后端工程师，15 年经验。你重视架构简洁性、可维护性和工程务实性，反感过度设计。讨论技术问题时习惯用具体代码事实说话。",
  "avatar": "🐧"
}
```

`agents/test.json`：

```json
{
  "id": "test",
  "name": "小李",
  "capability": "测试",
  "description": "测试工程师，关注质量、边界条件与回归风险",
  "persona": "你是一名测试工程师，对质量风险极其敏感。你习惯追问边界条件、异常路径和回归风险，重视可测试性和监控覆盖。",
  "avatar": "🧪"
}
```

`agents/debate.json`：

```json
{
  "id": "debate",
  "name": "陈姐",
  "capability": "辩论",
  "description": "资深辩手，擅长发现逻辑漏洞、挑战共识",
  "persona": "你是一名受过专业训练的辩手。你擅长发现论证中的逻辑漏洞、隐含假设和未经证实的断言，敢于挑战所有人的观点（包括用户），但始终对事不对人。",
  "avatar": "⚖️"
}
```

`agents/analyst.json`：

```json
{
  "id": "analyst",
  "name": "阿伦",
  "capability": "数据分析",
  "description": "数据分析师，用数据与事实校准讨论",
  "persona": "你是一名数据分析师。你习惯用数字、基准和事实校准讨论，对没有依据的结论会要求证据，能自己写脚本分析工作区里的数据文件。",
  "avatar": "📊"
}
```

- [ ] **Step 2: 写加载器**

`src/core/agent-config.ts`：

```typescript
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { agents } from '@/db/schema';
import type { DB } from '@/db/client';

export const agentFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  capability: z.string().min(1),
  description: z.string().min(1),
  persona: z.string().min(1),
  avatar: z.string().default('🤖'),
});

export type AgentFile = z.infer<typeof agentFileSchema>;

export function loadAgentFiles(
  dir = path.join(process.cwd(), 'agents'),
): AgentFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) =>
      agentFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))),
    );
}

export function importAgentsToDb(db: DB, files: AgentFile[]): void {
  for (const a of files) {
    db.insert(agents)
      .values(a)
      .onConflictDoUpdate({ target: agents.id, set: { ...a } })
      .run();
  }
}
```

- [ ] **Step 3: 写测试**

`tests/agent-config.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';
import { agents } from '@/db/schema';

describe('agent-config', () => {
  it('加载内置配置并导入数据库（可重复导入不报错）', () => {
    const db = createTestDb();
    const files = loadAgentFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    importAgentsToDb(db, files);
    importAgentsToDb(db, files); // upsert 幂等
    const rows = db.select().from(agents).all();
    expect(rows.map((r) => r.id)).toContain('dev');
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add agents src/core/agent-config.ts tests/agent-config.test.ts
git commit -m "feat: 内置 agent 配置与加载入库"
```

---

### Task 4: 事件总线

**Files:**
- Create: `src/lib/events.ts`
- Test: `tests/events.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/events.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { emitMeetingEvent, subscribeMeeting, type MeetingEvent } from '@/lib/events';

describe('events', () => {
  it('按会议频道订阅/退订事件', () => {
    const got: MeetingEvent[] = [];
    const unsub = subscribeMeeting('m1', (e) => got.push(e));
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm1', status: 'active' });
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm2', status: 'active' }); // 其他会议，不收到
    unsub();
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm1', status: 'paused' });
    expect(got.length).toBe(1);
    expect(got[0].status).toBe('active');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，`@/lib/events` 不存在。

- [ ] **Step 3: 实现事件总线**

`src/lib/events.ts`：

```typescript
import { EventEmitter } from 'node:events';
import type { MessageRow } from '@/db/schema';

export type MeetingStatus = 'active' | 'paused' | 'ended';
export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'speaking';

export type MeetingEvent =
  | { type: 'message'; meetingId: string; message: MessageRow }
  | {
      type: 'agent_status';
      meetingId: string;
      agentId: string;
      status: AgentStatus;
      detail?: string;
    }
  | { type: 'round'; meetingId: string; round: number; phase: 'start' | 'end' }
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

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/events.ts tests/events.test.ts
git commit -m "feat: 进程内会议事件总线"
```

---

### Task 5: 注入器 injector

**Files:**
- Create: `src/core/injector.ts`
- Test: `tests/injector.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/injector.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { agents, meetings, participants, messages } from '@/db/schema';
import {
  isSkip,
  collectChatroomIncrement,
  buildSpeechPrompt,
  buildDmPrompt,
} from '@/core/injector';

function setup() {
  const db = createTestDb();
  db.insert(agents).values({
    id: 'dev', name: '老王', capability: '研发',
    description: 'd', persona: 'p', avatar: '🐧',
  }).run();
  db.insert(meetings).values({
    id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp',
    status: 'active', createdAt: 1,
  }).run();
  db.insert(participants).values({
    id: 'p1', meetingId: 'm1', agentId: 'dev', meetingRole: '激进派',
    speakOrder: 0, lastInjectedMsgId: 0,
  }).run();
  const say = (kind: string, content: string, agentId: string | null, channel = 'chatroom') =>
    db.insert(messages).values({
      meetingId: 'm1', channel, agentId, kind, content, createdAt: 1,
    }).run();
  return { db, say };
}

describe('isSkip', () => {
  it('trim 后为 [SKIP] 才算跳过', () => {
    expect(isSkip('[SKIP]')).toBe(true);
    expect(isSkip('  [SKIP] \n')).toBe(true);
    expect(isSkip('[SKIP]，但我还想说……')).toBe(false);
    expect(isSkip('我认为不行')).toBe(false);
  });
});

describe('collectChatroomIncrement', () => {
  it('只取 chatroom 中水位之后的消息，不含 dm', () => {
    const { db, say } = setup();
    say('system', '会议开始', null);
    say('speech', '我先说两句', 'dev');
    say('dm_user', '私下问一下', null, 'dm');
    const rows = collectChatroomIncrement(db, 'm1', 'p1');
    expect(rows.length).toBe(2); // dm 被排除
    // 推进水位后不再取旧消息
    db.update(participants)
      .set({ lastInjectedMsgId: rows[rows.length - 1].id })
      .run();
    expect(collectChatroomIncrement(db, 'm1', 'p1').length).toBe(0);
  });
});

describe('buildSpeechPrompt', () => {
  it('组装转述行与轮次指令', () => {
    const { db, say } = setup();
    say('user', '大家看看覆盖率', null);
    say('speech', '耦合度被高估了', 'dev');
    const rows = collectChatroomIncrement(db, 'm1', 'p1');
    const agentsById = new Map([['dev', { name: '老王', capability: '研发' }]]);
    const prompt = buildSpeechPrompt({ increment: rows, agentsById, round: 3 });
    expect(prompt).toContain('[chatroom 用户] 大家看看覆盖率');
    expect(prompt).toContain('[chatroom 老王·研发] 耦合度被高估了');
    expect(prompt).toContain('第 3 轮');
    expect(prompt).toContain('[SKIP]');
  });
});

describe('buildDmPrompt', () => {
  it('组装私信与回复规则', () => {
    const prompt = buildDmPrompt(['帮我看看老王的说法靠谱吗']);
    expect(prompt).toContain('[user 私信→你] 帮我看看老王的说法靠谱吗');
    expect(prompt).toContain('仅你可见');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，`@/core/injector` 不存在。

- [ ] **Step 3: 实现 injector**

`src/core/injector.ts`：

```typescript
import { and, eq, gt } from 'drizzle-orm';
import { messages, participants, type MessageRow } from '@/db/schema';
import type { DB } from '@/db/client';

export const SKIP_TOKEN = '[SKIP]';

export function isSkip(text: string): boolean {
  return text.trim() === SKIP_TOKEN;
}

/** 收集某参会者水位之后的聊天室消息（不含 dm，含自己此前发言） */
export function collectChatroomIncrement(
  db: DB,
  meetingId: string,
  participantId: string,
): MessageRow[] {
  const p = db.select().from(participants)
    .where(eq(participants.id, participantId)).get();
  if (!p) throw new Error(`participant ${participantId} 不存在`);
  return db.select().from(messages)
    .where(and(
      eq(messages.meetingId, meetingId),
      eq(messages.channel, 'chatroom'),
      gt(messages.id, p.lastInjectedMsgId),
    ))
    .all();
}

export interface SenderInfo {
  name: string;
  capability: string;
}

function chatroomLine(row: MessageRow, agentsById: Map<string, SenderInfo>): string {
  if (row.kind === 'user') return `[chatroom 用户] ${row.content}`;
  if (row.kind === 'system') return `[system] ${row.content}`;
  const a = row.agentId ? agentsById.get(row.agentId) : undefined;
  const label = a ? `${a.name}·${a.capability}` : '未知参会者';
  return `[chatroom ${label}] ${row.content}`;
}

export function buildSpeechPrompt(input: {
  increment: MessageRow[];
  agentsById: Map<string, SenderInfo>;
  round: number;
}): string {
  const lines = input.increment.map((r) => chatroomLine(r, input.agentsById));
  const head = lines.length
    ? lines.join('\n')
    : '（自你上次发言以来没有新的聊天室消息）';
  return `${head}

[system] 第 ${input.round} 轮，轮到你发言。基于以上最新讨论发表观点；若无话可说，只回复 ${SKIP_TOKEN}。`;
}

export function buildDmPrompt(dmContents: string[]): string {
  const lines = dmContents.map((c) => `[user 私信→你] ${c}`).join('\n');
  return `${lines}

[system] 以上是用户发给你的私信（仅你可见，其他参会者看不到）。请直接回复用户，回复同样仅用户可见、不会进入聊天室。`;
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/injector.ts tests/injector.test.ts
git commit -m "feat: 消息增量收集与注入组装"
```

---

### Task 6: agent-runner（SDK 封装）

**Files:**
- Create: `src/core/agent-runner.ts`
- Test: `tests/agent-runner.test.ts`

- [ ] **Step 1: 写失败测试（mock SDK）**

`tests/agent-runner.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { runAgentTurn } from '@/core/agent-runner';

function fakeStream(msgs: unknown[]) {
  return (async function* () { for (const m of msgs) yield m; })();
}

describe('runAgentTurn', () => {
  it('返回最终发言、会话 id 与工具活动；透传 resume 与 cwd', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] },
      },
      { type: 'result', subtype: 'success', result: '我认为可行', session_id: 'sess-1' },
    ]));

    const out = await runAgentTurn({
      systemPrompt: 'sp', workspacePath: 'C:/ws', prompt: 'p', resumeSessionId: 'old',
    });

    expect(out.speech).toBe('我认为可行');
    expect(out.sessionId).toBe('sess-1');
    expect(out.toolActivities).toEqual([{ tool: 'Read', detail: 'src/a.ts' }]);

    const arg = queryMock.mock.calls[0][0];
    expect(arg.options.cwd).toBe('C:/ws');
    expect(arg.options.resume).toBe('old');
    expect(arg.options.permissionMode).toBe('bypassPermissions');
  });

  it('result 非 success 或无文本时 speech 为空', async () => {
    queryMock.mockReturnValue(fakeStream([
      { type: 'result', subtype: 'error_max_turns', result: '', session_id: 's' },
    ]));
    const out = await runAgentTurn({ systemPrompt: 's', workspacePath: '/w', prompt: 'p' });
    expect(out.speech).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 agent-runner**

`src/core/agent-runner.ts`：

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface TurnInput {
  systemPrompt: string;
  workspacePath: string;
  prompt: string;
  resumeSessionId?: string;
}

export interface ToolActivity {
  tool: string;
  detail: string;
}

export interface TurnResult {
  speech: string;
  sessionId: string;
  toolActivities: ToolActivity[];
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const v =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v === undefined ? '' : String(v);
}

export async function runAgentTurn(input: TurnInput): Promise<TurnResult> {
  const q = query({
    prompt: input.prompt,
    options: {
      systemPrompt: input.systemPrompt,
      cwd: input.workspacePath,
      permissionMode: 'bypassPermissions',
      resume: input.resumeSessionId,
      maxTurns: 40,
    },
  });

  let speech = '';
  let sessionId = input.resumeSessionId ?? '';
  const toolActivities: ToolActivity[] = [];

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          toolActivities.push({
            tool: block.name,
            detail: describeToolInput(block.input as Record<string, unknown>),
          });
        }
      }
    } else if (msg.type === 'result' && msg.subtype === 'success') {
      speech = msg.result;
      sessionId = msg.session_id;
    }
  }
  return { speech, sessionId, toolActivities };
}
```

注意：SDK 版本类型若与上面不符（如 `resume` 字段名变化），以 `node_modules/@anthropic-ai/claude-agent-sdk` 的 `.d.ts` 为准做最小调整，行为不变。

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-runner.ts tests/agent-runner.test.ts
git commit -m "feat: Claude Agent SDK 会话封装"
```

---

### Task 7: engine——创建会议与 system prompt

**Files:**
- Create: `src/core/engine.ts`
- Test: `tests/engine-create.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/engine-create.test.ts`：

```typescript
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
  maxRounds: 2,
  participants: [
    { agentId: 'dev', meetingRole: '激进派：主张全面重写' },
    { agentId: 'test', meetingRole: '保守派：主张渐进改造' },
  ],
});

describe('createMeeting', () => {
  it('校验工作区与人数，创建参与者和开场系统消息', () => {
    const { db, engine } = makeEngine();
    const input = validInput();
    const m = engine.createMeeting(input);

    expect(m.status).toBe('paused');
    const ps = db.select().from(participants).all();
    expect(ps.length).toBe(2);
    expect(ps.map((p) => p.speakOrder).sort()).toEqual([0, 1]);

    const sys = db.select().from(messages)
      .where(eq(messages.kind, 'system')).all();
    expect(sys.length).toBe(1);
    expect(sys[0].content).toContain(input.topic);
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
    expect(() => engine.createMeeting(one)).toThrow(/2.*8|参与者/);
  });

  it('buildSystemPrompt 含 persona、会议角色与行为规则', () => {
    const { engine } = makeEngine();
    const input = validInput();
    engine.createMeeting(input);
    const sp = (engine as any).buildSystemPrompt('m-any', input.participants[0].agentId);
    expect(sp).toContain('老王');
    expect(sp).toContain('激进派：主张全面重写');
    expect(sp).toContain('[SKIP]');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，`@/core/engine` 不存在。

- [ ] **Step 3: 实现 engine 第一部分**

`src/core/engine.ts`：

```typescript
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, eq, max } from 'drizzle-orm';
import {
  agents, meetings, participants, messages,
  type AgentRow, type MeetingRow, type MessageRow, type ParticipantRow,
} from '@/db/schema';
import type { DB } from '@/db/client';
import { emitMeetingEvent, type MeetingStatus } from '@/lib/events';
import { runAgentTurn } from './agent-runner';
import { collectChatroomIncrement, buildSpeechPrompt, buildDmPrompt, isSkip } from './injector';

export interface CreateMeetingInput {
  title: string;
  topic: string;
  workspacePath: string;
  maxRounds: number;
  participants: { agentId: string; meetingRole: string }[];
}

type Runner = typeof runAgentTurn;

export class MeetingEngine {
  constructor(
    private db: DB,
    private runner: Runner = runAgentTurn,
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

  private getParticipantByAgent(meetingId: string, agentId: string): ParticipantRow {
    const p = this.db.select().from(participants)
      .where(and(eq(participants.meetingId, meetingId), eq(participants.agentId, agentId)))
      .get();
    if (!p) throw new Error(`agent ${agentId} 不在该会议中`);
    return p;
  }

  private agentMap(): Map<string, AgentRow> {
    return new Map(this.db.select().from(agents).all().map((a) => [a.id, a]));
  }

  // ---------- 消息与事件 ----------

  private insertMessage(row: {
    meetingId: string;
    channel: 'chatroom' | 'dm';
    agentId?: string | null;
    kind: 'speech' | 'user' | 'system' | 'dm_user' | 'dm_agent';
    content: string;
    round?: number | null;
  }): MessageRow {
    this.db.insert(messages)
      .values({ ...row, createdAt: Date.now() })
      .run();
    const inserted = this.db.select().from(messages)
      .where(eq(messages.meetingId, row.meetingId))
      .orderBy(max(messages.id)) // drizzle max 包裹 orderBy 场景不适用，改用下行方案
      .all();
    return inserted[inserted.length - 1];
  }
}
```

注意：上面 `insertMessage` 的取回方式不干净，实际实现用下面这个版本（直接全表按 id 倒序取该会议最新一条）：

```typescript
  private insertMessage(row: {
    meetingId: string;
    channel: 'chatroom' | 'dm';
    agentId?: string | null;
    kind: 'speech' | 'user' | 'system' | 'dm_user' | 'dm_agent';
    content: string;
    round?: number | null;
  }): MessageRow {
    this.db.insert(messages)
      .values({
        meetingId: row.meetingId,
        channel: row.channel,
        agentId: row.agentId ?? null,
        kind: row.kind,
        content: row.content,
        round: row.round ?? null,
        createdAt: Date.now(),
      })
      .run();
    const all = this.db.select().from(messages)
      .where(eq(messages.meetingId, row.meetingId)).all();
    return all[all.length - 1]; // 自增 id，最后一条即刚插入的
  }

  private emitMessage(msg: MessageRow): void {
    emitMeetingEvent({ type: 'message', meetingId: msg.meetingId, message: msg });
  }
```

继续 `createMeeting` 与 `buildSystemPrompt`（同一个类里追加）：

```typescript
  // ---------- 创建 ----------

  createMeeting(input: CreateMeetingInput): MeetingRow {
    if (!fs.existsSync(input.workspacePath) || !fs.statSync(input.workspacePath).isDirectory()) {
      throw new Error('工作区路径不存在或不是目录');
    }
    if (input.participants.length < 2 || input.participants.length > 8) {
      throw new Error('参与者数量须在 2-8 之间');
    }
    const ids = new Set(input.participants.map((p) => p.agentId));
    if (ids.size !== input.participants.length) throw new Error('参与者不能重复');

    const meetingId = randomUUID();
    this.db.insert(meetings).values({
      id: meetingId,
      title: input.title,
      topic: input.topic,
      workspacePath: input.workspacePath,
      status: 'paused',
      maxRounds: input.maxRounds,
      currentRound: 0,
      createdAt: Date.now(),
    }).run();

    input.participants.forEach((p, i) => {
      this.db.insert(participants).values({
        id: randomUUID(),
        meetingId,
        agentId: p.agentId,
        meetingRole: p.meetingRole,
        speakOrder: i,
        lastInjectedMsgId: 0,
      }).run();
    });

    const agentRows = this.agentMap();
    const roster = input.participants
      .map((p) => {
        const a = agentRows.get(p.agentId);
        return `- ${a?.name ?? p.agentId}（${a?.capability ?? ''}）：${p.meetingRole}`;
      })
      .join('\n');
    const opening = this.insertMessage({
      meetingId,
      channel: 'chatroom',
      kind: 'system',
      content: `会议「${input.title}」开始。主题：${input.topic}\n参会者：\n${roster}\n工作区：${input.workspacePath}`,
    });
    this.emitMessage(opening);
    return this.getMeeting(meetingId);
  }

  // ---------- system prompt ----------

  buildSystemPrompt(meetingId: string, agentId: string): string {
    const m = this.getMeeting(meetingId);
    const p = this.getParticipantByAgent(meetingId, agentId);
    const agent = this.agentMap().get(agentId)!;
    const roster = this.getParticipants(meetingId)
      .map((pp) => {
        const a = this.agentMap().get(pp.agentId)!;
        return `- ${a.name}（${a.capability}）：${pp.meetingRole}`;
      })
      .join('\n');
    return `# 你的身份
${agent.persona}

# 会议背景
会议主题：${m.topic}
工作区（你的文件工具只能在此目录内使用）：${m.workspacePath}

# 你的会议角色
${p.meetingRole}

# 参会者
${roster}

# 行为规则
- 会议按轮次进行，每轮所有参会者依次发言一次，轮到你时系统会注入其他人的最新发言
- 你可以用文件工具查阅/修改工作区代码来支撑观点；你的工具操作过程其他参会者看不到，只有你的最终发言文本会公布到聊天室
- 若其他参会者想了解你的操作细节，他们会直接问你，届时用文字描述即可
- 无话可说时只回复 [SKIP]
- 发言像真实会议发言一样简洁聚焦（通常几十到两三百字），不要输出长篇报告或标题堆砌
- 用户可能私信你（消息带 [user 私信→你] 前缀），私信与你的私聊回复仅双方可见，不会进入聊天室；私信中的指示会影响你的立场，这是允许的`;
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/engine-create.test.ts
git commit -m "feat: 会议引擎——创建会议与 system prompt 组装"
```

---

### Task 8: engine——轮次循环

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/engine-loop.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/engine-loop.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { messages, meetings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeSetup() {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const input: CreateMeetingInput = {
    title: 't', topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    maxRounds: 2,
    participants: [
      { agentId: 'dev', meetingRole: '激进派' },
      { agentId: 'test', meetingRole: '保守派' },
    ],
  };
  return { db, input };
}

function seqRunner(replies: string[], errAt?: Set<number>) {
  let i = 0;
  const mock = vi.fn(async () => {
    const n = i++;
    if (errAt?.has(n)) throw new Error('sdk down');
    return { speech: replies[n] ?? 'ok', sessionId: `s-${n}`, toolActivities: [] };
  });
  return mock;
}

describe('轮次循环', () => {
  it('start 后跑满 maxRounds 轮，每人每轮一条发言，然后自动 paused', async () => {
    const { db, input } = makeSetup();
    const runner = seqRunner(['观点A', '观点B', '观点C', '观点D']);
    const engine = new MeetingEngine(db, runner as any);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const rows = db.select().from(messages).all();
    expect(rows.filter((r) => r.kind === 'speech').length).toBe(4); // 2 轮 × 2 人
    const meeting = db.select().from(meetings)
      .where(eq(meetings.id, m.id)).all()[0];
    expect(meeting.status).toBe('paused'); // 跑满自动暂停
    expect(meeting.currentRound).toBe(2);
  });

  it('[SKIP] 生成跳过系统消息且不产生 speech', async () => {
    const { db, input } = makeSetup();
    const runner = seqRunner(['[SKIP]', '观点B', '[SKIP] ', '观点D']);
    const engine = new MeetingEngine(db, runner as any);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const rows = db.select().from(messages).all();
    const skips = rows.filter((r) => r.kind === 'system' && r.content.includes('跳过'));
    expect(skips.length).toBe(2);
    expect(rows.filter((r) => r.kind === 'speech').length).toBe(2);
  });

  it('runner 失败重试一次，仍失败则跳过该 agent 并继续', async () => {
    const { db, input } = makeSetup();
    const runner = seqRunner(
      ['x', 'x', 'x', 'x'],
      new Set([0, 1, 2]), // dev 首轮两次全失败；test 首轮第一次失败重试成功
    );
    const engine = new MeetingEngine(db, runner as any);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const rows = db.select().from(messages).all();
    expect(rows.some((r) => r.kind === 'system' && r.content.includes('发言失败'))).toBe(true);
    expect(rows.some((r) => r.kind === 'speech')).toBe(true);
    expect(runner.mock.calls.length).toBeLessThan(8); // 有跳过，未跑满
  });

  it('sdkSessionId 被记录（召回依据）', async () => {
    const { db, input } = makeSetup();
    const runner = seqRunner(['a', 'b', 'c', 'd']);
    const engine = new MeetingEngine(db, runner as any);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const ps = db.select().from(participants).all();
    expect(ps.every((p) => p.sdkSessionId && p.sdkSessionId.length > 0)).toBe(true);
  });
});
```

（`participants`、`meetings`、`messages` 均从顶部 `@/db/schema` import，`eq` 从 `drizzle-orm` import。）

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，`start` 不存在。

- [ ] **Step 3: 实现轮次循环（engine 类追加）**

```typescript
  // ---------- 运行控制 ----------

  private loops = new Map<string, { pause: boolean; promise: Promise<void> }>();

  isRunning(meetingId: string): boolean {
    return this.loops.has(meetingId);
  }

  /** 启动（或重启）轮次循环，返回循环结束的 promise */
  start(meetingId: string): Promise<void> {
    if (this.getMeeting(meetingId).status === 'ended') {
      throw new Error('会议已结束，无法开始');
    }
    this.setStatus(meetingId, 'active');
    if (this.loops.has(meetingId)) return this.loops.get(meetingId)!.promise;
    // 注意：runLoop 与 loops 必须持有同一个 ctl 引用，pause() 才能生效
    const ctl: { pause: boolean; promise: Promise<void> } = {
      pause: false,
      promise: Promise.resolve(),
    };
    ctl.promise = this.runLoop(meetingId, ctl)
      .catch((e) => console.error(`[engine] 会议 ${meetingId} 循环异常:`, e))
      .finally(() => this.loops.delete(meetingId));
    this.loops.set(meetingId, ctl);
    return ctl.promise;
  }

  private setStatus(meetingId: string, status: MeetingStatus): void {
    this.db.update(meetings)
      .set({ status, ...(status === 'ended' ? { endedAt: Date.now() } : {}) })
      .where(eq(meetings.id, meetingId)).run();
    emitMeetingEvent({ type: 'meeting_status', meetingId, status });
  }

  private shouldStop(meetingId: string, ctl: { pause: boolean }): boolean {
    return ctl.pause || this.getMeeting(meetingId).status !== 'active';
  }

  private async runLoop(meetingId: string, ctl: { pause: boolean }): Promise<void> {
    while (!this.shouldStop(meetingId, ctl)) {
      const m = this.getMeeting(meetingId);
      if (m.currentRound >= m.maxRounds) {
        const exhausted = this.insertMessage({
          meetingId, channel: 'chatroom', kind: 'system',
          content: `已达到最大轮数（${m.maxRounds}），会议暂停。可追加轮数后继续。`,
        });
        this.emitMessage(exhausted);
        this.setStatus(meetingId, 'paused');
        return;
      }
      const round = m.currentRound + 1;
      this.db.update(meetings)
        .set({ currentRound: round }).where(eq(meetings.id, meetingId)).run();
      emitMeetingEvent({ type: 'round', meetingId, round, phase: 'start' });

      for (const p of this.getParticipants(meetingId)) {
        if (this.shouldStop(meetingId, ctl)) return;
        await this.processPendingDms(meetingId, p);
        if (this.shouldStop(meetingId, ctl)) return;
        await this.runSpeechTurn(meetingId, p, round);
      }
      emitMeetingEvent({ type: 'round', meetingId, round, phase: 'end' });
    }
  }

  /** 单个 agent 的会议发言回合 */
  private async runSpeechTurn(
    meetingId: string,
    p: ParticipantRow,
    round: number,
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    const agent = this.agentMap().get(p.agentId)!;
    emitMeetingEvent({
      type: 'agent_status', meetingId, agentId: p.agentId, status: 'thinking',
    });

    const increment = collectChatroomIncrement(this.db, meetingId, p.id);
    const senderMap = new Map(
      [...this.agentMap().entries()].map(([id, a]) => [id, { name: a.name, capability: a.capability }]),
    );
    const prompt = buildSpeechPrompt({ increment, agentsById: senderMap, round });
    const systemPrompt = this.buildSystemPrompt(meetingId, p.agentId);

    let result: Awaited<ReturnType<Runner>> | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const r = await this.runner({
          systemPrompt, workspacePath: m.workspacePath, prompt,
          resumeSessionId: p.sdkSessionId ?? undefined,
        });
        if (r.speech) result = r;
        else break; // 无文本视为失败，不再重试空结果
      } catch {
        result = undefined; // 重试一次
      }
    }

    if (!result) {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'system',
        content: `${agent.name} 本轮发言失败，已跳过。`,
      }));
      this.setAgentStatus(meetingId, p.agentId, 'idle');
      return;
    }

    // 更新会话 id（召回依据）
    this.db.update(participants)
      .set({ sdkSessionId: result.sessionId })
      .where(eq(participants.id, p.id)).run();

    // 工具活动仅作为状态事件（不进聊天室）
    for (const t of result.toolActivities) {
      emitMeetingEvent({
        type: 'agent_status', meetingId, agentId: p.agentId, status: 'tool',
        detail: `${t.tool} ${t.detail}`.trim(),
      });
    }

    const watermarkBase = increment.length ? increment[increment.length - 1].id : p.lastInjectedMsgId;
    if (isSkip(result.speech)) {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'system', round,
        content: `${agent.name} 跳过本轮发言。`,
      }));
      this.db.update(participants)
        .set({ lastInjectedMsgId: watermarkBase })
        .where(eq(participants.id, p.id)).run();
    } else {
      emitMeetingEvent({
        type: 'agent_status', meetingId, agentId: p.agentId, status: 'speaking',
      });
      const msg = this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'speech',
        agentId: p.agentId, content: result.speech, round,
      });
      this.emitMessage(msg);
      this.db.update(participants)
        .set({ lastInjectedMsgId: Math.max(watermarkBase, msg.id) })
        .where(eq(participants.id, p.id)).run();
    }
    this.setAgentStatus(meetingId, p.agentId, 'idle');
  }

  private setAgentStatus(meetingId: string, agentId: string, status: AgentStatusName, detail?: string): void {
    emitMeetingEvent({ type: 'agent_status', meetingId, agentId, status, detail });
  }
```

类型补充（文件顶部）：

```typescript
import type { AgentStatus, MeetingStatus as MeetingStatusEvent } from '@/lib/events';
type AgentStatusName = AgentStatus;
```

`processPendingDms` 在 Task 9 实现，本任务先放空实现保证编译：

```typescript
  private async processPendingDms(_meetingId: string, _p: ParticipantRow): Promise<void> {}
```

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。注意 `start()` 对已 paused 的会议重启循环即「继续开会」。

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/engine-loop.test.ts
git commit -m "feat: 轮次循环——轮流发言、跳过、失败重试与自动暂停"
```

---

### Task 9: engine——用户消息与私聊

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/engine-dm.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/engine-dm.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { messages, participants } from '@/db/schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function setup(maxRounds = 1) {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const input: CreateMeetingInput = {
    title: 't', topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    maxRounds,
    participants: [
      { agentId: 'dev', meetingRole: '激进派' },
      { agentId: 'test', meetingRole: '保守派' },
    ],
  };
  const calls: { prompt: string; resume?: string }[] = [];
  const runner = vi.fn(async (i: { prompt: string; resumeSessionId?: string }) => {
    calls.push({ prompt: i.prompt, resume: i.resumeSessionId });
    return { speech: '回复', sessionId: `s-${calls.length}`, toolActivities: [] };
  });
  const engine = new MeetingEngine(db, runner as any);
  const m = engine.createMeeting(input);
  return { db, engine, runner, meetingId: m.id, calls };
}

describe('用户消息', () => {
  it('sendUserMessage 存库为 chatroom/user，后续注入可见', async () => {
    const { db, engine, meetingId, calls } = await setup();
    engine.sendUserMessage(meetingId, '大家先看看覆盖率');
    await engine.start(meetingId);
    const row = db.select().from(messages)
      .where(eq(messages.kind, 'user')).all();
    expect(row.length).toBe(1);
    expect(calls[0].prompt).toContain('[chatroom 用户] 大家先看看覆盖率');
  });
});

describe('私聊', () => {
  it('会议进行中私信排队：轮到该 agent 时先私聊回合（prompt 含私信前缀）再发言回合', async () => {
    const { db, engine, meetingId, calls } = await setup();
    await engine.sendDm(meetingId, 'dev', '私下帮我看看小李的论据');
    await engine.start(meetingId);
    // calls[0] = dev 的私聊回合，calls[1] = dev 的发言回合，calls[2] = test 的发言回合
    expect(calls.length).toBe(3);
    expect(calls[0].prompt).toContain('[user 私信→你] 私下帮我看看小李的论据');
    expect(calls[0].prompt).toContain('仅你可见');
    const dmAgent = db.select().from(messages)
      .where(eq(messages.kind, 'dm_agent')).all();
    expect(dmAgent.length).toBe(1);
    expect(dmAgent[0].channel).toBe('dm');
    // 发言回合与私聊回合共用同一 resume 链
    expect(calls[1].resume).toBe('s-1');
  });

  it('paused 状态私信即时回复', async () => {
    const { db, engine, meetingId, calls } = await setup();
    // 不 start，会议处于 paused
    await engine.sendDm(meetingId, 'test', '你觉得呢');
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toContain('你觉得呢');
    expect(db.select().from(messages).where(eq(messages.kind, 'dm_agent')).all().length).toBe(1);
  });

  it('dm_user 存库且 channel=dm', async () => {
    const { db, engine, meetingId } = await setup();
    await engine.sendDm(meetingId, 'dev', 'hi');
    const row = db.select().from(messages)
      .where(eq(messages.kind, 'dm_user')).all();
    expect(row[0].channel).toBe('dm');
    expect(row[0].agentId).toBe('dev');
  });

  it('ended 会议拒绝私信与群聊', async () => {
    const { engine, meetingId } = await setup();
    engine.end(meetingId);
    await expect(engine.sendDm(meetingId, 'dev', 'x')).rejects.toThrow(/结束/);
    expect(() => engine.sendUserMessage(meetingId, 'x')).toThrow(/结束/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL，`sendUserMessage`/`sendDm`/`end` 不存在。

- [ ] **Step 3: 实现（engine 类追加，替换 Task 8 的空 processPendingDms）**

```typescript
  // ---------- 用户消息 ----------

  sendUserMessage(meetingId: string, content: string): MessageRow {
    if (this.getMeeting(meetingId).status === 'ended') {
      throw new Error('会议已结束，无法发言');
    }
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'user', content,
    });
    this.emitMessage(msg);
    return msg;
  }

  // ---------- 私聊 ----------

  private pendingDms = new Map<string, string[]>(); // participantId -> 私信内容

  async sendDm(meetingId: string, agentId: string, content: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法私聊');
    const p = this.getParticipantByAgent(meetingId, agentId);
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'dm', kind: 'dm_user', agentId, content,
    }));
    if (m.status === 'active' && this.isRunning(meetingId)) {
      const q = this.pendingDms.get(p.id) ?? [];
      q.push(content);
      this.pendingDms.set(p.id, q);
    } else {
      // 暂停中（或循环已死）即时私聊回合
      await this.runDmTurn(meetingId, p, [content]);
    }
  }

  /** 轮到某 agent 发言前，先处理其排队私信 */
  private async processPendingDms(meetingId: string, p: ParticipantRow): Promise<void> {
    const q = this.pendingDms.get(p.id);
    if (!q?.length) return;
    this.pendingDms.set(p.id, []);
    await this.runDmTurn(meetingId, p, q);
  }

  private async runDmTurn(
    meetingId: string,
    p: ParticipantRow,
    dmContents: string[],
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    const agent = this.agentMap().get(p.agentId)!;
    emitMeetingEvent({
      type: 'agent_status', meetingId, agentId: p.agentId, status: 'thinking',
      detail: '私聊中',
    });
    const prompt = buildDmPrompt(dmContents);
    const systemPrompt = this.buildSystemPrompt(meetingId, p.agentId);
    try {
      const r = await this.runner({
        systemPrompt, workspacePath: m.workspacePath, prompt,
        resumeSessionId: p.sdkSessionId ?? undefined,
      });
      if (r.sessionId) {
        this.db.update(participants)
          .set({ sdkSessionId: r.sessionId })
          .where(eq(participants.id, p.id)).run();
      }
      if (r.speech) {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'dm_agent', agentId: p.agentId,
          content: r.speech,
        }));
      } else {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'system', agentId: p.agentId,
          content: `${agent.name} 未能回复私信。`,
        }));
      }
    } catch {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'dm', kind: 'system', agentId: p.agentId,
        content: `${agent.name} 私信回复失败。`,
      }));
    }
    this.setAgentStatus(meetingId, p.agentId, 'idle');
  }
```

（`end` 在 Task 10 实现；本任务先加最小实现让测试通过：`end(meetingId: string) { this.setStatus(meetingId, 'ended'); const loop = this.loops.get(meetingId); if (loop) loop.pause = true; }`）

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/engine-dm.test.ts
git commit -m "feat: 用户群聊消息与私聊回合（排队/即时双模式）"
```

---

### Task 10: engine——暂停/继续/结束/追加轮数

**Files:**
- Modify: `src/core/engine.ts`
- Test: `tests/engine-control.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/engine-control.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { meetings, messages, participants } from '@/db/schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setup(maxRounds = 4) {
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const input: CreateMeetingInput = {
    title: 't', topic: 'tp',
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    maxRounds,
    participants: [
      { agentId: 'dev', meetingRole: '激进派' },
      { agentId: 'test', meetingRole: '保守派' },
    ],
  };
  let n = 0;
  const runner = vi.fn(async () => ({
    speech: `第${++n}条发言`, sessionId: `s-${n}`, toolActivities: [],
  }));
  const engine = new MeetingEngine(db, runner as any);
  const m = engine.createMeeting(input);
  return { db, engine, runner, meetingId: m.id };
}

describe('会议控制', () => {
  it('pause 停止循环，状态 paused；resume 从断点继续并沿用 resume 链', async () => {
    const { db, engine, runner, meetingId } = setup(4);
    const p = engine.start(meetingId);
    // 首个 agent 发完言立即暂停
    await vi.waitFor(() =>
      expect(db.select().from(messages).where(eq(messages.kind, 'speech')).all().length).toBe(1),
    );
    engine.pause(meetingId);
    await p;
    expect(db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0].status).toBe('paused');

    const firstResumeArg = { resume: undefined as string | undefined };
    // 继续：从第 1 轮第 2 个 agent 继续
    const p2 = engine.resume(meetingId);
    await p2;
    const speeches = db.select().from(messages).where(eq(messages.kind, 'speech')).all();
    expect(speeches.length).toBe(8); // 4 轮 × 2 人全部跑完
    // 后续回合透传了 session id
    expect(runner.mock.calls[1][0].resumeSessionId).toBeTruthy();
  });

  it('end 置 ended 并停止循环，ended 后 start 抛错', async () => {
    const { db, engine, meetingId } = setup(4);
    const p = engine.start(meetingId);
    await vi.waitFor(() =>
      expect(db.select().from(messages).where(eq(messages.kind, 'speech')).all().length).toBeGreaterThanOrEqual(1),
    );
    engine.end(meetingId);
    await p;
    const m = db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0];
    expect(m.status).toBe('ended');
    expect(m.endedAt).toBeTruthy();
    expect(() => engine.start(meetingId)).toThrow(/结束/);
  });

  it('extendRounds 增加轮数上限', async () => {
    const { db, engine, meetingId } = setup(1);
    const p = engine.start(meetingId);
    await p; // 跑满 1 轮自动 paused
    engine.extendRounds(meetingId, 2);
    expect(db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0].maxRounds).toBe(3);
    const p2 = engine.resume(meetingId);
    await p2;
    const speeches = db.select().from(messages).where(eq(messages.kind, 'speech')).all();
    expect(speeches.length).toBe(6); // 3 轮 × 2 人
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test
```

Expected: FAIL（pause/resume/extendRounds 不完整或行为不符）。

- [ ] **Step 3: 实现（engine 类追加/完善）**

```typescript
  pause(meetingId: string): void {
    const loop = this.loops.get(meetingId);
    if (loop) loop.pause = true;
    if (this.getMeeting(meetingId).status === 'active') this.setStatus(meetingId, 'paused');
  }

  resume(meetingId: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法继续');
    return this.start(meetingId); // start 会置 active 并重启循环（sdkSessionId 已在参与者行里）
  }

  end(meetingId: string): void {
    const loop = this.loops.get(meetingId);
    if (loop) loop.pause = true;
    this.setStatus(meetingId, 'ended');
  }

  extendRounds(meetingId: string, rounds: number): void {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束');
    this.db.update(meetings)
      .set({ maxRounds: m.maxRounds + rounds })
      .where(eq(meetings.id, meetingId)).run();
  }
```

（`start` 的 ended 防护已在 Task 8 中内置。）

- [ ] **Step 4: 运行测试**

```bash
npm test
```

Expected: PASS。全部测试（Tasks 2-10）通过。

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts tests/engine-control.test.ts
git commit -m "feat: 会议控制——暂停/继续/结束/追加轮数"
```

---

### Task 11: engine 单例与 API Routes（REST + SSE）

**Files:**
- Create: `src/core/engine-instance.ts`
- Create: `src/app/api/agents/route.ts`
- Create: `src/app/api/meetings/route.ts`
- Create: `src/app/api/meetings/[id]/route.ts`
- Create: `src/app/api/meetings/[id]/[action]/route.ts`（start/pause/resume/end/extend）
- Create: `src/app/api/meetings/[id]/messages/route.ts`
- Create: `src/app/api/meetings/[id]/dm/route.ts`
- Create: `src/app/api/meetings/[id]/events/route.ts`
- Test: `tests/api.test.ts`

- [ ] **Step 1: engine 单例**

`src/core/engine-instance.ts`：

```typescript
import { getDb } from '@/db/client';
import { MeetingEngine } from './engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

export function getEngine(): MeetingEngine {
  if (!g.__meetingEngine) g.__meetingEngine = new MeetingEngine(getDb());
  return g.__meetingEngine;
}
```

- [ ] **Step 2: 写 API 测试**

`tests/api.test.ts`（不启动 Next，直接构造 NextRequest 调 handler）：

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/core/engine-instance', () => {
  const { createTestDb } = require('@/db/client');
  const { importAgentsToDb, loadAgentFiles } = require('@/core/agent-config');
  const { MeetingEngine } = require('@/core/engine');
  const db = createTestDb();
  importAgentsToDb(db, loadAgentFiles());
  const engine = new MeetingEngine(db);
  return { getEngine: () => engine };
});

import { NextRequest } from 'next/server';
import { POST as createMeeting } from '@/app/api/meetings/route';
import { GET as listMeetings } from '@/app/api/meetings/route';
import { POST as action } from '@/app/api/meetings/[id]/[action]/route';
import { POST as sendMessage } from '@/app/api/meetings/[id]/messages/route';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));

describe('api', () => {
  it('创建会议 → 列表可见 → 用户发言', async () => {
    const body = {
      title: 't', topic: 'tp', workspacePath: ws(), maxRounds: 2,
      participants: [
        { agentId: 'dev', meetingRole: '激进派' },
        { agentId: 'test', meetingRole: '保守派' },
      ],
    };
    const res = await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body),
    }));
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.id).toBeTruthy();

    const list = await listMeetings(new NextRequest('http://x/api/meetings'));
    expect((await list.json()).length).toBe(1);

    const msgRes = await sendMessage(new NextRequest(
      `http://x/api/meetings/${created.id}/messages`,
      { method: 'POST', body: JSON.stringify({ content: 'hello' }) },
      // Next 15 动态参数注入：通过第二参 params 传入
    ) as any, { params: Promise.resolve({ id: created.id }) });
    expect(msgRes.status).toBe(200);
  });

  it('非法 action 返回 400', async () => {
    const res = await action(new NextRequest('http://x/api/meetings/m1/bad', { method: 'POST' }) as any,
      { params: Promise.resolve({ id: 'm1', action: 'bad' }) });
    expect(res.status).toBe(400);
  });
});
```

（mock 区里避免 require 循环：`@/core/engine` 依赖 `@/db/client`，与 mock 中的 `createTestDb` 同模块不同实例——测试内可行，因为 engine 用的是传入 db。）

- [ ] **Step 3: 实现各 route**

`src/app/api/agents/route.ts`：

```typescript
import { getDb } from '@/db/client';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';

export async function GET() {
  const db = getDb();
  importAgentsToDb(db, loadAgentFiles());
  return Response.json(db.select().from(agents).all());
}

import { agents } from '@/db/schema';
```

（import 合并到文件顶部。）

`src/app/api/meetings/route.ts`：

```typescript
import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { getEngine } from '@/core/engine-instance';

export async function GET() {
  return Response.json(
    getDb().select().from(meetings).orderBy(desc(meetings.createdAt)).all(),
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const m = getEngine().createMeeting(body);
    return Response.json(m);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

`src/app/api/meetings/[id]/route.ts`：

```typescript
import { getEngine } from '@/core/engine-instance';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const engine = getEngine();
    const meeting = engine.getMeeting(id);
    return Response.json({
      meeting,
      participants: engine.getParticipants(id),
      messages: engine.getMessages(id),
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
```

`src/app/api/meetings/[id]/[action]/route.ts`：

```typescript
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
        engine.start(id); // 异步循环，不等待
        return Response.json({ ok: true });
      case 'pause':
        engine.pause(id);
        return Response.json({ ok: true });
      case 'resume':
        engine.resume(id);
        return Response.json({ ok: true });
      case 'end':
        engine.end(id);
        return Response.json({ ok: true });
      case 'extend': {
        const { rounds } = await req.json();
        engine.extendRounds(id, Number(rounds) || 1);
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: `未知操作 ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

`src/app/api/meetings/[id]/messages/route.ts`：

```typescript
import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { content } = await req.json();
    const msg = getEngine().sendUserMessage(id, String(content));
    return Response.json(msg);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

`src/app/api/meetings/[id]/dm/route.ts`：

```typescript
import { getEngine } from '@/core/engine-instance';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const { agentId, content } = await req.json();
    await getEngine().sendDm(id, String(agentId), String(content));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

`src/app/api/meetings/[id]/events/route.ts`（SSE）：

```typescript
import { subscribeMeeting } from '@/lib/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 连接已关闭 */
        }
      };
      const unsubscribe = subscribeMeeting(id, send);
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* ignore */
        }
      }, 15000);
      const close = () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 4: 运行测试 + 构建**

```bash
npm test && npm run build
```

Expected: 测试 PASS、构建成功。

- [ ] **Step 5: Commit**

```bash
git add src/app/api src/core/engine-instance.ts tests/api.test.ts
git commit -m "feat: REST API 与 SSE 实时推送"
```

---

### Task 12: UI——会议列表与创建向导

**Files:**
- Modify: `src/app/page.tsx`
- Create: `src/app/meetings/new/page.tsx`

（UI 任务以浏览器手动验证为主，无自动化测试。）

- [ ] **Step 1: 会议列表页**

`src/app/page.tsx`（整体替换）：

```tsx
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { loadAgentFiles, importAgentsToDb } from '@/core/agent-config';

export const dynamic = 'force-dynamic';

const statusLabel: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  ended: '已结束',
};

export default async function Home() {
  const db = getDb();
  importAgentsToDb(db, loadAgentFiles());
  const rows = db.select().from(meetings).orderBy(desc(meetings.createdAt)).all();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">AI 会议</h1>
        <Link
          href="/meetings/new"
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          新建会议
        </Link>
      </div>
      {rows.length === 0 && (
        <p className="text-gray-500">还没有会议，点右上角新建一场吧。</p>
      )}
      <ul className="space-y-3">
        {rows.map((m) => (
          <li key={m.id} className="rounded border p-4 hover:border-blue-400">
            <Link href={`/meetings/${m.id}`} className="block">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{m.title}</span>
                <span className="text-xs text-gray-500">{statusLabel[m.status]}</span>
              </div>
              <p className="mt-1 text-sm text-gray-600">{m.topic}</p>
              <p className="mt-1 text-xs text-gray-400">
                轮次 {m.currentRound}/{m.maxRounds} · {new Date(m.createdAt).toLocaleString()}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: 创建向导页**

`src/app/meetings/new/page.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface AgentInfo {
  id: string;
  name: string;
  capability: string;
  description: string;
  avatar: string;
}

export default function NewMeetingPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [maxRounds, setMaxRounds] = useState(3);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.json())
      .then(setAgents)
      .catch(() => setError('加载 agent 列表失败'));
  }, []);

  const toggle = (id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const submit = async () => {
    setError('');
    if (selected.length < 2) return setError('至少选择 2 个 agent');
    if (selected.some((id) => !roles[id]?.trim())) return setError('请为每个 agent 填写会议角色');
    setBusy(true);
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, topic, workspacePath, maxRounds,
          participants: selected.map((id) => ({ agentId: id, meetingRole: roles[id] })),
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

      <label className="mb-1 mt-4 block text-sm font-medium">工作区路径（agent 可读写此目录）</label>
      <input
        className={input}
        placeholder="C:/Users/you/project/example"
        value={workspacePath}
        onChange={(e) => setWorkspacePath(e.target.value)}
      />

      <label className="mb-1 mt-4 block text-sm font-medium">最大轮数</label>
      <input
        type="number" min={1} max={50} className={input}
        value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}
      />

      <h2 className="mb-2 mt-6 font-semibold">选择参会 agent 并分配会议角色</h2>
      <div className="space-y-3">
        {agents.map((a) => {
          const on = selected.includes(a.id);
          return (
            <div key={a.id} className={`rounded border p-3 ${on ? 'border-blue-500' : ''}`}>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={on} onChange={() => toggle(a.id)} />
                <span className="text-xl">{a.avatar}</span>
                <span className="font-medium">{a.name}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{a.capability}</span>
                <span className="text-xs text-gray-500">{a.description}</span>
              </label>
              {on && (
                <input
                  className={`${input} mt-2`}
                  placeholder={`会议角色，如：激进派——主张……`}
                  value={roles[a.id] ?? ''}
                  onChange={(e) => setRoles({ ...roles, [a.id]: e.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button
        onClick={submit}
        disabled={busy}
        className="mt-6 rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? '创建中…' : '创建会议'}
      </button>
    </main>
  );
}
```

- [ ] **Step 3: 手动验证**

```bash
npm run dev
```

浏览器打开 http://localhost:3000 ：
- 空列表提示正常
- 「新建会议」→ 选 2 个 agent、填角色、用 `C:/Users/cndux/Desktop/project/ai-meeting` 当工作区 → 创建成功跳转（404 正常，房间页在 Task 13）
- 工作区填不存在的路径 → 报错提示

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx src/app/meetings/new/page.tsx
git commit -m "feat: 会议列表与创建向导界面"
```

---

### Task 13: UI——会议房间（聊天室/agent 侧栏/私聊抽屉/SSE）

**Files:**
- Create: `src/app/meetings/[id]/page.tsx`（server，拉初始数据）
- Create: `src/components/room/Room.tsx`（client 容器：SSE + 全部状态）
- Create: `src/components/room/AgentCard.tsx`
- Create: `src/components/room/ChatPanel.tsx`
- Create: `src/components/room/DmDrawer.tsx`

- [ ] **Step 1: server 页面**

`src/app/meetings/[id]/page.tsx`：

```tsx
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { agents } from '@/db/schema';
import { getEngine } from '@/core/engine-instance';
import { Room, type RoomData } from '@/components/room/Room';

export const dynamic = 'force-dynamic';

export default async function MeetingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const engine = getEngine();
  let data;
  try {
    const meeting = engine.getMeeting(id);
    const participants = engine.getParticipants(id);
    const messages = engine.getMessages(id);
    const agentRows = getDb().select().from(agents).all();
    const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));
    data = {
      meeting,
      participants: participants.map((p) => ({
        ...p,
        agent: agentMap[p.agentId],
      })),
      messages,
    } as RoomData;
  } catch {
    notFound();
  }
  return <Room initial={data} />;
}
```

- [ ] **Step 2: 类型与 Room 容器**

`src/components/room/Room.tsx`：

```tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import AgentCard from './AgentCard';
import ChatPanel from './ChatPanel';
import DmDrawer from './DmDrawer';
import type { MeetingRow, MessageRow } from '@/db/schema';

export interface ParticipantView {
  id: string;
  agentId: string;
  meetingRole: string;
  agent: { id: string; name: string; capability: string; avatar: string; description: string };
}

export interface RoomData {
  meeting: MeetingRow;
  participants: ParticipantView[];
  messages: MessageRow[];
}

type AgentState = 'idle' | 'thinking' | 'tool' | 'speaking';

export default function Room({ initial }: { initial: RoomData }) {
  const [meeting, setMeeting] = useState(initial.meeting);
  const [messages, setMessages] = useState(initial.messages);
  const [states, setStates] = useState<Record<string, { status: AgentState; detail?: string }>>({});
  const [dmTarget, setDmTarget] = useState<string | null>(null);
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
        [data.agentId]: { status: data.status, detail: data.detail },
      }));
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

  const act = async (action: string, body?: object) => {
    await fetch(`/api/meetings/${meeting.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (action !== 'start') {
      // 状态变更后刷新会议对象（SSE 不回传完整对象）
      const res = await fetch(`/api/meetings/${meeting.id}`);
      const d = await res.json();
      setMeeting(d.meeting);
    } else {
      setMeeting((m) => ({ ...m, status: 'active' }));
    }
  };

  const sendChat = async (content: string) => {
    await fetch(`/api/meetings/${meeting.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  };

  const sendDm = async (agentId: string, content: string) => {
    await fetch(`/api/meetings/${meeting.id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, content }),
    });
  };

  const dmAgent = initial.participants.find((p) => p.agentId === dmTarget);

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 border-r p-4">
        <h1 className="font-bold">{meeting.title}</h1>
        <p className="mt-1 text-xs text-gray-500">{meeting.topic}</p>
        <p className="mt-2 text-xs">
          状态：{meeting.status} · 轮次 {meeting.currentRound}/{meeting.maxRounds}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.status === 'paused' && (
            <button onClick={() => act('start')} className="rounded bg-green-600 px-3 py-1 text-xs text-white">
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
          {meeting.status === 'paused' && (
            <button onClick={() => act('extend', { rounds: 3 })} className="rounded bg-gray-600 px-3 py-1 text-xs text-white">
              +3 轮
            </button>
          )}
        </div>
        <div className="mt-4 space-y-2">
          {initial.participants.map((p) => (
            <AgentCard
              key={p.agentId}
              participant={p}
              state={states[p.agentId] ?? { status: 'idle' }}
              onDm={() => setDmTarget(p.agentId)}
            />
          ))}
        </div>
      </aside>

      <ChatPanel
        messages={messages.filter((m) => m.channel === 'chatroom')}
        participants={initial.participants}
        onSend={sendChat}
        disabled={meeting.status === 'ended'}
        bottomRef={bottomRef}
      />

      {dmAgent && (
        <DmDrawer
          participant={dmAgent}
          messages={messages.filter((m) => m.channel === 'dm' && m.agentId === dmAgent.agentId)}
          onSend={(c) => sendDm(dmAgent.agentId, c)}
          onClose={() => setDmTarget(null)}
          disabled={meeting.status === 'ended'}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: AgentCard**

`src/components/room/AgentCard.tsx`：

```tsx
import type { ParticipantView } from './Room';

const stateLabel: Record<string, string> = {
  idle: '',
  thinking: '思考中…',
  tool: '使用工具中',
  speaking: '发言中…',
};

export default function AgentCard({
  participant,
  state,
  onDm,
}: {
  participant: ParticipantView;
  state: { status: string; detail?: string };
  onDm: () => void;
}) {
  const busy = state.status !== 'idle';
  return (
    <div className="rounded border p-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">{participant.agent.avatar}</span>
        <span className="text-sm font-medium">{participant.agent.name}</span>
        <span className="rounded bg-gray-100 px-1.5 text-[10px]">{participant.agent.capability}</span>
        <button onClick={onDm} className="ml-auto text-[10px] text-blue-600 hover:underline">
          私聊
        </button>
      </div>
      <p className="mt-1 text-[11px] text-gray-600">{participant.meetingRole}</p>
      {busy && (
        <p className="mt-1 animate-pulse text-[11px] text-blue-600">
          {stateLabel[state.status]}
          {state.detail ? `（${state.detail}）` : ''}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: ChatPanel**

`src/components/room/ChatPanel.tsx`：

```tsx
import { useState, type RefObject } from 'react';
import type { MessageRow } from '@/db/schema';
import type { ParticipantView } from './Room';

export default function ChatPanel({
  messages,
  participants,
  onSend,
  disabled,
  bottomRef,
}: {
  messages: MessageRow[];
  participants: ParticipantView[];
  onSend: (content: string) => void;
  disabled: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  const [text, setText] = useState('');
  const byAgent = new Map(participants.map((p) => [p.agentId, p]));

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <section className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => {
          if (m.kind === 'system') {
            return (
              <p key={m.id} className="text-center text-xs text-gray-400">{m.content}</p>
            );
          }
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[70%] rounded-lg bg-blue-600 px-3 py-2 text-sm text-white">
                  {m.content}
                </div>
              </div>
            );
          }
          const p = m.agentId ? byAgent.get(m.agentId) : undefined;
          return (
            <div key={m.id} className="flex gap-2">
              <span className="text-xl">{p?.agent.avatar ?? '🤖'}</span>
              <div>
                <p className="text-xs text-gray-500">
                  {p?.agent.name ?? '未知'} · {p?.agent.capability}
                  {m.round != null && ` · 第 ${m.round} 轮`}
                </p>
                <div className="mt-0.5 max-w-[85%] whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-sm">
                  {m.content}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 border-t p-3">
        <input
          className="flex-1 rounded border px-3 py-2 text-sm"
          placeholder={disabled ? '会议已结束' : '以参会者身份发言…'}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button
          onClick={send}
          disabled={disabled}
          className="rounded bg-blue-600 px-4 text-sm text-white disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: DmDrawer**

`src/components/room/DmDrawer.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react';
import type { MessageRow } from '@/db/schema';
import type { ParticipantView } from './Room';

export default function DmDrawer({
  participant,
  messages,
  onSend,
  onClose,
  disabled,
}: {
  participant: ParticipantView;
  messages: MessageRow[];
  onSend: (content: string) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm font-medium">
          {participant.agent.avatar} 与 {participant.agent.name} 私聊
        </span>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">关闭</button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((m) => {
          const mine = m.kind === 'dm_user';
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : ''}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  mine ? 'bg-blue-600 text-white' : 'bg-gray-100'
                }`}
              >
                {m.content}
              </div>
            </div>
          );
        })}
        <div ref={ref} />
      </div>
      <div className="flex gap-2 border-t p-2">
        <input
          className="flex-1 rounded border px-2 py-1.5 text-sm"
          placeholder={disabled ? '会议已结束' : '私信…'}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button
          onClick={send}
          disabled={disabled}
          className="rounded bg-blue-600 px-3 text-sm text-white disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 6: 手动验证（核心路径）**

```bash
npm run dev
```

验证点：
1. 创建会议后进入房间，看到开场系统消息、agent 侧栏
2. 点「开始/继续」→ agent 依次发言（需真实 API），agent 卡片状态变化（思考中/使用工具中/发言中）
3. 聊天室出现 agent 发言；工具调用只在卡片状态行短暂出现，不进消息流
4. 发送用户消息 → 右侧气泡即时出现
5. 点「私聊」→ 抽屉打开 → 发私信 → 会议中该 agent 轮到时会先出现私聊回复
6. 「暂停」→ 私信即时得到回复
7. 暂停 → 「开始/继续」→ 会议从断点继续（召回）
8. 回到列表页 → 会议可见，点击可重新进入

- [ ] **Step 7: 构建 + Commit**

```bash
npm run build
git add src/app/meetings src/components
git commit -m "feat: 会议房间界面——聊天室、agent 侧栏、私聊抽屉、SSE 实时更新"
```

---

### Task 14: README 与验收清单

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README**

```markdown
# AI Meeting

多 Agent 会议系统：多个平等的 AI agent 围绕话题（通常是某个代码库的技术决策）
轮流讨论，用户以群聊 + 私聊双身份参与。基于 Claude Agent SDK。

## 环境要求

- Node 18+
- Claude Code CLI 已安装并可运行（SDK 依赖）
- `ANTHROPIC_API_KEY` 已配置或 claude CLI 已登录

## 启动

​```bash
npm install
npx drizzle-kit generate   # 首次生成迁移（若 drizzle/ 已提交可跳过）
npm run dev
​```​

打开 http://localhost:3000

## 使用流程

1. 新建会议：填话题、指定工作区目录（agent 只能读写该目录）、选 2-8 个 agent、
   给每个 agent 分配会议角色（派别/立场）
2. 进入房间点「开始」：agent 按轮次依次发言，可用文件工具查证工作区代码
3. 你可以随时在聊天室发言（下一轮对所有人可见），或与单个 agent 私聊
   （仅对方可见，但会影响它的会上立场——同一上下文）
4. 暂停后可随时「继续」（召回会议），轮数用尽可追加
5. agent 的工具操作只在左侧卡片显示状态，不污染聊天室；想知道它做了什么，
   直接问它

## 已知限制

- 进程重启时，会议中排队的未注入私信会保留在数据库但不会被自动注入
  （重新发一次即可）
- 私聊与会议发言共用同一 agent 会话，会议进行中私信会在轮到该 agent 时
  优先处理

## 测试

​```bash
npm test
​```​
```

（正式写入时把 `​```​` 恢复为标准三反引号。）

- [ ] **Step 2: 手动 E2E 验收（真实 API）**

按 Task 13 Step 6 的 8 个验证点完整跑一遍，外加：
- 用 3 个 agent（含辩论角色）开一场关于本仓库 `src/core/engine.ts` 设计的评审会，观察辩论 agent 是否挑战他人观点
- 会中要求某 agent「展示你的操作步骤」，验证它以普通发言形式描述工具历史

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 与使用说明"
```

---

## 自审记录

1. **Spec 覆盖**：多 agent 平等轮流（Task 8）、私聊同上下文（Task 9，同一 sdkSessionId 复用）、群聊发言（Task 9）、工具能力+工作区锁定+自动批准（Task 6/7）、工具不进聊天室（Task 8 状态事件 + system prompt 约定）、持久化与召回（Task 2/10，sdkSessionId + start 重启循环）、agent 配置文件+会议角色（Task 3/7）、UI（Task 12/13）。✓
2. **占位符**：全部代码可直接使用，无 TBD/临时写法。✓
3. **类型一致性**：`runAgentTurn` 输入输出、`MeetingEngine` 构造签名（db, runner）、`insertMessage`、事件类型、`agentsById: Map` 在各任务间一致。✓
