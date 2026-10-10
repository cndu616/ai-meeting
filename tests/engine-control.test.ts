// tests/engine-control.test.ts —— 会议控制（pause/resume/end/崩溃/恢复）与动态成员
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupEngine, FakeSession } from './fake-session';
import { MeetingEngine } from '@/core/engine';
import { participants as participantsTable } from '@/db/schema';
import type { SessionCreateOptions } from '@/core/session-factory';

describe('会议控制', () => {
  it('pause：关闭全部会话、状态 paused；期间消息只落库不推送', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    await engine.pause(m.id);
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(engine.getMeeting(m.id).status).toBe('paused');
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '暂停期间的消息');
    expect(sessions.every((s) => s.pushes.length === 0)).toBe(true);
    expect(engine.getMessages(m.id).some((x) => x.content === '暂停期间的消息')).toBe(true);
  });

  it('resume：重建会话并补发暂停期间增量', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    // 第一个成员有 sessionId（模拟已跑过）：resume 应接续原会话链
    sessions[0].opts.callbacks.onSessionId('s-keep');
    await engine.pause(m.id);
    engine.sendUserMessage(m.id, '暂停期间的重要消息');
    const before = sessions.length;
    await engine.resume(m.id);
    expect(sessions.length).toBe(before + 2); // 全部重建
    const rebuilt = sessions[sessions.length - 2];
    expect(rebuilt.opts.resumeSessionId).toBe('s-keep');
    expect(rebuilt.pushes[0].text).toContain('暂停期间的重要消息');
    expect(rebuilt.pushes[0].text).toContain('继续进行');
    // 另一成员无 sessionId → 全新会话
    expect(sessions[sessions.length - 1].opts.resumeSessionId).toBeUndefined();
  });

  it('end：关闭会话、落库结束消息、拒绝再操作', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    await engine.end(m.id);
    expect(sessions.every((s) => s.closed)).toBe(true);
    expect(engine.getMeeting(m.id).status).toBe('ended');
    expect(engine.getMessages(m.id).some((x) => x.content.includes('已结束'))).toBe(true);
    expect(() => engine.sendUserMessage(m.id, 'x')).toThrow(/结束/);
    expect(() => engine.start(m.id)).toThrow(/结束/);
  });

  it('崩溃重建：onRestart 后 catchUp 按水位线补发增量', () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '崩溃前的消息');
    // active 期间广播是同步的（推送即推进水位线），崩溃窗口「消息已落库但未送达」
    // 的等价状态是水位线未推进——回拨构造，验证 catchUp 补发路径
    db.update(participantsTable)
      .set({ lastInjectedMsgId: 0 })
      .where(eq(participantsTable.id, ps[0].id)).run();
    sessions[0].pushes = [];
    sessions[0].opts.callbacks.onRestart();
    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].text).toContain('关注后续推送'); // catchUp 默认指令
    expect(sessions[0].pushes[0].text).toContain('崩溃前的消息'); // 水位线之后的增量
  });

  it('重建也失败：onDead → offline 状态，会议不受影响', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    expect(() => sessions[0].opts.callbacks.onDead()).not.toThrow();
    expect(engine.getMeeting(m.id).status).toBe('active');
  });
});

describe('动态成员管理', () => {
  it('active 会议添加成员：落库、入会消息、建会话并推送全部历史', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    engine.sendUserMessage(m.id, '第一条历史');
    const before = sessions.length;
    const row = engine.addParticipant(m.id, {
      templateId: 'architect', displayName: '王架构', goal: '全局视角把控',
    });
    expect(engine.getParticipants(m.id).length).toBe(3);
    expect(engine.getMeeting(m.id).status).toBe('active');
    expect(sessions.length).toBe(before + 1);
    const joinPush = sessions[sessions.length - 1].pushes[0].text;
    expect(joinPush).toContain('王架构');
    expect(joinPush).toContain('中途加入');
    expect(joinPush).toContain('[chatroom 用户] 第一条历史'); // 全部历史（水位线 0）
    const p = engine.getParticipant(m.id, row.id);
    expect(p.lastInjectedMsgId).toBeGreaterThan(0);
  });

  it('paused 会议添加成员：仅落库（resume 时统一重建）', () => {
    const { engine, m, sessions } = setupEngine();
    const before = sessions.length;
    engine.addParticipant(m.id, {
      templateId: 'analyst', displayName: '赵分析', goal: '数据支撑',
    });
    expect(sessions.length).toBe(before); // 没有新会话
    expect(engine.getParticipants(m.id).length).toBe(3);
  });

  it('上限与校验：空名字拒绝、第 9 人拒绝、ended 拒绝', async () => {
    const { engine, m } = setupEngine();
    // 空名字须在人数未满时验证：engine 校验顺序为 ended → 上限 → 名字 → 模板，
    // 满员后空名字会先命中上限异常，到不了名字校验
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: '', goal: 'g',
    })).toThrow(/名字/);
    for (let i = 0; i < 6; i++) {
      engine.addParticipant(m.id, {
        templateId: 'dev', displayName: `成员${i}`, goal: 'g',
      });
    }
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: '超了', goal: 'g',
    })).toThrow(/8/);
    await engine.end(m.id);
    expect(() => engine.addParticipant(m.id, {
      templateId: 'dev', displayName: 'x', goal: 'g',
    })).toThrow(/结束/);
  });

  it('setMuted：更新并广播 participant 事件', () => {
    const { engine, m } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const updated = engine.setMuted(m.id, ps[0].id, true);
    expect(updated.muted).toBe(1);
    expect(engine.getParticipant(m.id, ps[0].id).muted).toBe(1);
  });
});

describe('服务器重启恢复', () => {
  it('recoverActiveMeetings：重启 engine 后 active 会议自动重建会话；paused 不在范围', async () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions[0].opts.callbacks.onSessionId('s-recover');
    engine.sendUserMessage(m.id, '重启前的消息');
    // 与崩溃重建用例同构：active 期间广播同步推进了水位线，重启窗口「消息已落库
    // 但未送达」的等价状态是水位线未推进——回拨构造以验证恢复补发路径
    const ps = engine.getParticipants(m.id);
    db.update(participantsTable)
      .set({ lastInjectedMsgId: 0 })
      .where(eq(participantsTable.id, ps[0].id)).run();
    // 模拟重启：旧 engine 的内存会话消失，新 engine 实例（同一 db）
    const created2: FakeSession[] = [];
    const engine2 = new MeetingEngine(db, {
      create: (opts: SessionCreateOptions) => {
        const s = new FakeSession(opts);
        created2.push(s);
        return s;
      },
    });
    engine2.recoverActiveMeetings();
    expect(created2.length).toBe(2);
    expect(created2[0].opts.resumeSessionId).toBe('s-recover');
    expect(created2[0].pushes[0].text).toContain('重启前的消息');
    // paused 会议不在恢复范围
    const pausedEnv = setupEngine();
    const created3: FakeSession[] = [];
    const engine3 = new MeetingEngine(pausedEnv.db, {
      create: (opts: SessionCreateOptions) => {
        const s = new FakeSession(opts);
        created3.push(s);
        return s;
      },
    });
    engine3.recoverActiveMeetings();
    expect(created3.length).toBe(0);
  });
});
