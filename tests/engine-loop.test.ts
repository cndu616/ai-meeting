import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { messages, meetings, participants } from '@/db/schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeSetup() {
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
    const engine = new MeetingEngine(db, runner as unknown as typeof import('@/core/agent-runner').runAgentTurn);
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
    const engine = new MeetingEngine(db, runner as never);
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
    const engine = new MeetingEngine(db, runner as never);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const rows = db.select().from(messages).all();
    expect(rows.some((r) => r.kind === 'system' && r.content.includes('发言失败'))).toBe(true);
    expect(rows.some((r) => r.kind === 'speech')).toBe(true);
  });

  it('sdkSessionId 被记录（召回依据）', async () => {
    const { db, input } = makeSetup();
    const runner = seqRunner(['a', 'b', 'c', 'd']);
    const engine = new MeetingEngine(db, runner as never);
    const m = engine.createMeeting(input);
    await engine.start(m.id);
    const ps = db.select().from(participants).all();
    expect(ps.every((p) => p.sdkSessionId && p.sdkSessionId.length > 0)).toBe(true);
  });
});
