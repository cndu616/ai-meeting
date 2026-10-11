// tests/api.test.ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// SSE 路由的 connection() 是 Next 运行时 API，脱离请求作用域（直调 handler）会抛——测试环境置空
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, connection: async () => {} };
});

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
  const engine = new MeetingEngine(db, {
    create: (opts) => {
      const s = new FakeSession(opts);
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
import { GET as eventsRoute } from '@/app/api/meetings/[id]/events/route';

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
    expect(row.muted).toBe(false);

    const bad = await addParticipant(
      new NextRequest(`http://x/api/meetings/${created.id}/participants`, {
        method: 'POST',
        body: JSON.stringify({ templateId: 'nope', displayName: 'x', goal: 'g' }),
      }) as Parameters<typeof addParticipant>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(bad.status).toBe(400);
  });

  it('PATCH 禁言：返回 muted=true 的 participantInfo 投影', async () => {
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
    expect((await res.json()).muted).toBe(true);
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
      expect((await res.json()).error).toMatch(/未知操作/);
    }
  });

  it('SSE 重连带 Last-Event-ID：补发缺失区间的 message（帧带 id: 行），不重发已收', async () => {
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }))).json();
    await sendMessage(new NextRequest(`http://x/api/meetings/${created.id}/messages`, {
      method: 'POST', body: JSON.stringify({ content: '断线前的消息' }),
    }) as Parameters<typeof sendMessage>[0], { params: Promise.resolve({ id: created.id }) });
    await sendMessage(new NextRequest(`http://x/api/meetings/${created.id}/messages`, {
      method: 'POST', body: JSON.stringify({ content: '断线窗口丢失的消息' }),
    }) as Parameters<typeof sendMessage>[0], { params: Promise.resolve({ id: created.id }) });

    const engine = (await import('@/core/engine-instance')).getEngine();
    const msgs = engine.getMessages(created.id); // [开场 system, 用户1, 用户2]
    const lastEventId = msgs[1].id; // 客户端已收到开场+第一条，断线

    const res = await eventsRoute(
      new NextRequest(`http://x/api/meetings/${created.id}/events`, {
        headers: { 'last-event-id': String(lastEventId) },
      }) as Parameters<typeof eventsRoute>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    const frames = await readSseFrames(res);
    const messageFrames = frames.filter((f) => (f.data as { type?: string })?.type === 'message');
    // 只补发缺失区间：用户2，不重发开场与用户1
    expect(messageFrames.map((f) => (f.data as { message: { id: number } }).message.id))
      .toEqual([msgs[2].id]);
    // message 帧必须带 id: 行（重连的 Last-Event-ID 锚点）
    expect(messageFrames[0].id).toBe(String(msgs[2].id));
  });

  it('SSE 重连：participant/meeting_status 快照重发，agent_status 瞬态不补', async () => {
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body()),
    }))).json();
    const engine = (await import('@/core/engine-instance')).getEngine();
    await addParticipant(new NextRequest(`http://x/api/meetings/${created.id}/participants`, {
      method: 'POST',
      body: JSON.stringify({ templateId: 'analyst', displayName: '王分析', goal: '补充视角' }),
    }) as Parameters<typeof addParticipant>[0], { params: Promise.resolve({ id: created.id }) });
    await action(new NextRequest(`http://x/api/meetings/${created.id}/pause`, {
      method: 'POST',
    }) as Parameters<typeof action>[0], { params: Promise.resolve({ id: created.id, action: 'pause' }) });

    const lastEventId = engine.getMessages(created.id)[0].id; // 收到过开场后断线
    const res = await eventsRoute(
      new NextRequest(`http://x/api/meetings/${created.id}/events`, {
        headers: { 'last-event-id': String(lastEventId) },
      }) as Parameters<typeof eventsRoute>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    const frames = await readSseFrames(res);
    const types = frames.map((f) => (f.data as { type: string }).type);
    // 快照重发：全部 3 个成员（含断线期间加入的）+ 当前会议状态
    expect(types.filter((t) => t === 'participant').length).toBe(3);
    const statusFrame = frames.find((f) => (f.data as { type: string }).type === 'meeting_status');
    expect((statusFrame!.data as { status: string }).status).toBe('paused');
    // 瞬态事件不补
    expect(types).not.toContain('agent_status');
    // 快照帧不带 id: 行（Last-Event-ID 锚点只挂 message）
    for (const f of frames) {
      if ((f.data as { type: string }).type !== 'message') expect(f.id).toBeUndefined();
    }
  });
});

/** 读取 SSE 流中已缓冲的帧：补发在连接建立时同步入队，但每帧是独立 chunk——
 *  循环读到缓冲耗尽（短超时无新帧即停），不能只读一次（多帧分多 chunk 到达） */
async function readSseFrames(res: Response): Promise<{ id?: string; data: unknown }[]> {
  {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      // 补发帧首帧到达时已全部在队列：后续 read 立即 resolve；队列耗尽后挂起，
      // 以 50ms 超时判定"缓冲已尽"退出（无 fake timers，真实短超时）
      const next = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 50)),
      ]);
      if (!next || next.done) break;
      chunks.push(next.value);
    }
    await reader.cancel().catch(() => {});
    const text = chunks.map((c) => new TextDecoder().decode(c)).join('');
    const frames: { id?: string; data: unknown }[] = [];
    for (const block of text.split('\n\n')) {
      if (!block || block.startsWith(':')) continue; // 心跳注释行
      let id: string | undefined;
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (data) frames.push({ id, data: JSON.parse(data) });
    }
    return frames;
  }
}
