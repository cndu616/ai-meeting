import { describe, it, expect } from 'vitest';
import { createTestDb } from '@/db/client';
import { agents, meetings, participants, messages } from '@/db/schema';

describe('db', () => {
  it('内存库建表并可插入', () => {
    const db = createTestDb();
    db.insert(agents).values({
      id: 'dev', capability: '研发', description: 'd', persona: 'p', avatar: '🧑‍💻',
    }).run();
    db.insert(meetings).values({
      id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', status: 'paused', createdAt: Date.now(),
    }).run();
    db.insert(participants).values({
      id: 'p1', meetingId: 'm1', templateId: 'dev', displayName: '张工', goal: '激进派',
      muted: 0, speakOrder: 0, lastInjectedMsgId: 0,
    }).run();
    db.insert(messages).values({
      meetingId: 'm1', channel: 'chatroom', participantId: 'p1', kind: 'speech',
      content: 'hi', createdAt: Date.now(),
    }).run();
    const ps = db.select().from(participants).all();
    expect(ps.length).toBe(1);
    expect(ps[0].displayName).toBe('张工');
    expect(ps[0].muted).toBe(0);
    const ms = db.select().from(messages).all();
    expect(ms[0].participantId).toBe('p1');
  });

  it('同一模板可插入两个实例（不同 displayName）', () => {
    const db = createTestDb();
    db.insert(agents).values({ id: 'dev', capability: '研发', description: 'd', persona: 'p' }).run();
    db.insert(meetings).values({
      id: 'm1', title: 't', topic: 'tp', workspacePath: '/tmp', status: 'paused', createdAt: Date.now(),
    }).run();
    for (const [pid, name] of [['p1', '张工'], ['p2', '李工']] as const) {
      db.insert(participants).values({
        id: pid, meetingId: 'm1', templateId: 'dev', displayName: name, goal: 'g',
        muted: 0, speakOrder: 0, lastInjectedMsgId: 0,
      }).run();
    }
    expect(db.select().from(participants).all().map((p) => p.displayName)).toEqual(['张工', '李工']);
  });
});
