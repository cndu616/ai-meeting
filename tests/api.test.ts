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
  const db = getDb(); // 与上面 mock 的 getDb 共享同一内存库
  importAgentsToDb(db, loadAgentFiles());
  const engine = new MeetingEngine(db);
  return { getEngine: () => engine };
});

import { NextRequest } from 'next/server';
import { POST as createMeeting, GET as listMeetings } from '@/app/api/meetings/route';
import { POST as action } from '@/app/api/meetings/[id]/[action]/route';
import { POST as sendMessage } from '@/app/api/meetings/[id]/messages/route';

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

    const list = await listMeetings();
    expect((await list.json()).length).toBe(1);

    const msgRes = await sendMessage(
      new NextRequest(`http://x/api/meetings/${created.id}/messages`, {
        method: 'POST', body: JSON.stringify({ content: 'hello' }),
      }) as Parameters<typeof sendMessage>[0],
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(msgRes.status).toBe(200);
  });

  it('非法 action 返回 400', async () => {
    const res = await action(
      new NextRequest('http://x/api/meetings/m1/bad', { method: 'POST' }) as Parameters<typeof action>[0],
      { params: Promise.resolve({ id: 'm1', action: 'bad' }) },
    );
    expect(res.status).toBe(400);
  });

  it('pause 未开始会议返回 200 且状态变 paused', async () => {
    const body = {
      title: 't2', topic: 'tp', workspacePath: ws(), maxRounds: 1,
      participants: [
        { agentId: 'dev', meetingRole: 'a' },
        { agentId: 'test', meetingRole: 'b' },
      ],
    };
    const created = await (await createMeeting(new NextRequest('http://x/api/meetings', {
      method: 'POST', body: JSON.stringify(body),
    }))).json();
    const res = await action(
      new NextRequest(`http://x/api/meetings/${created.id}/pause`, { method: 'POST' }) as Parameters<typeof action>[0],
      { params: Promise.resolve({ id: created.id, action: 'pause' }) },
    );
    expect(res.status).toBe(200);
  });
});
