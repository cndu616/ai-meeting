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
