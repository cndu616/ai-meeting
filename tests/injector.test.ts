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
