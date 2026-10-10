import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/db/client';
import { importAgentsToDb, loadAgentFiles } from '@/core/agent-config';
import { MeetingEngine, type CreateMeetingInput } from '@/core/engine';
import { messages } from '@/db/schema';
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
  const engine = new MeetingEngine(db, runner as never);
  const m = engine.createMeeting(input);
  return { db, engine, runner, meetingId: m.id, calls };
}

describe('用户消息', () => {
  it('sendUserMessage 存库为 chatroom/user，后续注入可见', async () => {
    const { db, engine, meetingId, calls } = await setup();
    engine.sendUserMessage(meetingId, '大家先看看覆盖率');
    const row = db.select().from(messages)
      .where(eq(messages.kind, 'user')).all();
    expect(row.length).toBe(1);
    await engine.start(meetingId);
    expect(calls[0].prompt).toContain('[chatroom 用户] 大家先看看覆盖率');
  });
});

describe('私聊', () => {
  it('会议进行中私信排队：轮到该 agent 时先私聊回合再发言回合', async () => {
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
