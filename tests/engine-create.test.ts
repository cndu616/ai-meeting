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
