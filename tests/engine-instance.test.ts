// tests/engine-instance.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db/client', async () => {
  const actual = await vi.importActual<typeof import('@/db/client')>('@/db/client');
  const db = actual.createTestDb();
  return { ...actual, getDb: () => db };
});

import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { getEngine } from '@/core/engine-instance';
import { MeetingEngine } from '@/core/engine';

const g = globalThis as unknown as { __meetingEngine?: MeetingEngine };

describe('engine-instance', () => {
  beforeEach(() => {
    delete g.__meetingEngine; // 每用例重置单例
  });

  it('getEngine 首次调用触发 recoverActiveMeetings，后续调用幂等不重复触发', () => {
    const spy = vi.spyOn(MeetingEngine.prototype, 'recoverActiveMeetings')
      .mockImplementation(() => {});
    const e1 = getEngine();
    expect(spy).toHaveBeenCalledTimes(1);
    const e2 = getEngine();
    expect(e2).toBe(e1);
    expect(spy).toHaveBeenCalledTimes(1); // 单例缓存命中，不再触发
    spy.mockRestore();
  });

  it('决议 5（quarantine）：active 孤儿会议 → 置 paused + 落痕迹消息，不创建任何会话', () => {
    const db = getDb();
    // 造 active 孤儿：createMeeting（paused）后直接 DB 置 active——模拟服务端死亡时
    // pagehide beacon 无处可发、status 停在 active 落库的现场
    importAgentsToDb(db, loadAgentFiles());
    const helper = new MeetingEngine(db);
    const m = helper.createMeeting({
      title: '孤儿会议', topic: 'tp',
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
      participants: [
        { templateId: 'dev', displayName: '张工', goal: 'g' },
        { templateId: 'test', displayName: '李测试', goal: 'g' },
      ],
    });
    db.update(meetings).set({ status: 'active' }).where(eq(meetings.id, m.id)).run();

    // mock start：兼防真 CLI 启动与断言"复活不得发生"
    const startSpy = vi.spyOn(MeetingEngine.prototype, 'start').mockImplementation(() => {});
    delete g.__meetingEngine;
    const engine = getEngine();
    startSpy.mockRestore();

    // 置 paused；落痕迹消息（无 SSE 在场，落库才是关键痕迹）；零会话
    expect(engine.getMeeting(m.id).status).toBe('paused');
    const trace = engine.getMessages(m.id)
      .find((x) => x.kind === 'system' && x.content.includes('服务重启'));
    expect(trace).toBeTruthy();
    expect(trace!.content).toContain('继续');
    expect(startSpy).not.toHaveBeenCalled();
    expect(engine.isRunning(m.id)).toBe(false);
  });
});
