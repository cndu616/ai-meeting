import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { meetings, messages } from '@/db/schema';
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
  const engine = new MeetingEngine(db, runner as never);
  const m = engine.createMeeting(input);
  return { db, engine, runner, meetingId: m.id };
}

/** 在第 n 次调用时阻塞，返回释放函数（用于精确控制暂停时机） */
function gateAt(runner: ReturnType<typeof vi.fn>, n: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const impl = runner.getMockImplementation()!;
  runner.mockImplementation(async (...args: unknown[]) => {
    const count = runner.mock.calls.length;
    if (count === n) await gate;
    return (impl as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  return release;
}

const speechCount = (db: ReturnType<typeof createTestDb>) =>
  db.select().from(messages).where(eq(messages.kind, 'speech')).all().length;

describe('会议控制', () => {
  it('pause 停止循环，状态 paused；resume 从断点继续并沿用 resume 链', async () => {
    const { db, engine, runner, meetingId } = setup(4);
    const release = gateAt(runner, 2); // 第二个 agent 回合阻塞，等我们暂停后再放行
    const p = engine.start(meetingId);
    // 第一个 agent 发言完成、第二个回合被挂起
    await vi.waitFor(() => expect(speechCount(db)).toBe(1));
    engine.pause(meetingId);
    release();
    await p;
    expect(db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0].status)
      .toBe('paused');
    expect(speechCount(db)).toBe(2); // 被挂起的回合完成后停止，不进入第 2 轮

    // 继续：从第 2 轮开始，最终跑满 4 轮
    const p2 = engine.resume(meetingId);
    await p2;
    expect(speechCount(db)).toBe(8); // 4 轮 × 2 人
    // 后续回合透传了 session id（dev 第 2 轮 resume 其第 1 轮的会话）
    expect(runner.mock.calls[2][0].resumeSessionId).toBe('s-1');
  });

  it('end 置 ended 并停止循环，ended 后 start 抛错', async () => {
    const { db, engine, meetingId } = setup(4);
    const p = engine.start(meetingId);
    await vi.waitFor(() => expect(speechCount(db)).toBeGreaterThanOrEqual(1));
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
    expect(db.select().from(meetings).where(eq(meetings.id, meetingId)).all()[0].maxRounds)
      .toBe(3);
    const p2 = engine.resume(meetingId);
    await p2;
    expect(speechCount(db)).toBe(6); // 3 轮 × 2 人
  });
});
