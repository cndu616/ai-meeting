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
    expect(() => engine.createMeeting(one)).toThrow(/2-8|参与者/);
  });

  it('buildSystemPrompt 含 persona、会议角色与行为规则', () => {
    const { engine } = makeEngine();
    const input = validInput();
    const m = engine.createMeeting(input);
    const sp = (engine as unknown as {
      buildSystemPrompt: (meetingId: string, agentId: string) => string;
    }).buildSystemPrompt(m.id, 'dev');
    const dev = loadAgentFiles().find((a) => a.id === 'dev')!;
    expect(sp).toContain(dev.persona.slice(0, 10)); // 动态引用，agent 改名不改测试
    expect(sp).toContain('激进派：主张全面重写');
    expect(sp).toContain('[SKIP]');
  });
});
