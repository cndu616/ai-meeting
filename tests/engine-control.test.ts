// tests/engine-control.test.ts —— 会议控制（pause/resume/end/崩溃/恢复）与动态成员
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('崩溃重建：onRestart 后按水位线补发增量（开区间，不重发已送达）', () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    const delivered = engine.sendUserMessage(m.id, '正常送达的消息A');
    engine.sendUserMessage(m.id, '崩溃丢失的消息B1');
    engine.sendUserMessage(m.id, '崩溃丢失的消息B2');
    // active 广播同步推进水位线；回拨到最后一条已送达消息，构造
    // 「A 已送达、B1/B2 崩溃窗口丢失」的等价状态（验证 gt 开区间）
    db.update(participantsTable)
      .set({ lastInjectedMsgId: delivered.id })
      .where(eq(participantsTable.id, ps[0].id)).run();
    sessions[0].pushes = [];
    sessions[0].opts.callbacks.onRestart();
    expect(sessions[0].pushes.length).toBe(1);
    const text = sessions[0].pushes[0].text;
    expect(text).toContain('关注后续推送');
    expect(text).toContain('崩溃丢失的消息B1');
    expect(text).toContain('崩溃丢失的消息B2');
    expect(text.indexOf('崩溃丢失的消息B1')).toBeLessThan(text.indexOf('崩溃丢失的消息B2')); // 增量有序
    expect(text).not.toContain('正常送达的消息A'); // 已送达不重发（gt 非 gte）
  });

  it('重建也失败：onDead → offline 状态，会议不受影响', () => {
    // 完整摘除/水位线不推进/重建行为见 engine-crash.test.ts，此处仅锁定会议控制组视角
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    expect(() => sessions[0].opts.callbacks.onDead()).not.toThrow();
    expect(engine.getMeeting(m.id).status).toBe('active');
  });

  it('暂停穿透拦截：paused 后迟到的 chatroom 回合结果不落库、不广播、零新消息', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    await engine.pause(m.id);
    sessions.forEach((s) => (s.pushes = []));
    // session 已关闭，但飞行中回合的 onResult 仍可能触发（close 无门卫时的在途回调）
    const before = engine.getMessages(m.id).length;
    sessions[0].opts.callbacks.onResult('暂停后迟到的发言', 'chatroom');
    // 静默规格：不产生任何新消息（含系统提示），违规原文不落库
    expect(engine.getMessages(m.id).length).toBe(before);
    expect(engine.getMessages(m.id).some((x) => x.content === '暂停后迟到的发言')).toBe(false);
    expect(sessions.every((s) => s.pushes.length === 0)).toBe(true);
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
    const maxId = Math.max(...engine.getMessages(m.id).map((x) => x.id));
    expect(p.lastInjectedMsgId).toBe(maxId);
  });

  it('决议 3：join 系统消息广播给在线老成员；新人靠 catchUp 拿全量（不重复实时推送）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));

    engine.addParticipant(m.id, {
      templateId: 'architect', displayName: '王架构', goal: '全局视角把控',
    });

    // 老成员实时收到 join 广播（此前只 emitMessage 给 UI，agent 无感知——83 行盲区）
    expect(sessions[0].pushes.some((p) => p.text.includes('王架构 加入会议'))).toBe(true);
    expect(sessions[1].pushes.some((p) => p.text.includes('王架构 加入会议'))).toBe(true);
    // 新成员：只收到一次 catchUp（入会指令 + 全量历史含 join 行），无重复实时推送
    const newcomer = sessions[sessions.length - 1];
    expect(newcomer.pushes.length).toBe(1);
    expect(newcomer.pushes[0].text).toContain('中途加入');
    expect(newcomer.pushes[0].text).toContain('王架构 加入会议');
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
  it('决议 5：recoverActiveMeetings quarantine（不建会话）；恢复改走显式 resume（召回 + 补发）', async () => {
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
    // quarantine：active 孤儿降级 paused + 落痕迹消息，不创建任何会话（开机零 token）
    engine2.recoverActiveMeetings();
    expect(created2.length).toBe(0);
    expect(engine2.getMeeting(m.id).status).toBe('paused');
    expect(engine2.getMessages(m.id)
      .some((x) => x.kind === 'system' && x.content.includes('服务重启'))).toBe(true);
    // 显式「继续」：resume 重建会话（sdkSessionId 召回 + 水位补发），痕迹消息也在增量里
    await engine2.resume(m.id);
    expect(created2.length).toBe(2);
    expect(created2[0].opts.resumeSessionId).toBe('s-recover');
    expect(created2[0].pushes[0].text).toContain('重启前的消息');
    expect(created2[0].pushes[0].text).toContain('服务重启');
    // paused 会议不在 quarantine 范围：无会话、无痕迹、状态不变
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
    expect(engine3.getMeeting(pausedEnv.m.id).status).toBe('paused');
    expect(engine3.getMessages(pausedEnv.m.id)
      .some((x) => x.content.includes('服务重启'))).toBe(false);
  });
});

// 决议 1（B+）engine 侧：close 痕迹消息 + 迟到 result 分通道转交。
// FakeSession 不含 AgentSession 的内部时序，测试以手动触发 callbacks 模拟其时机
describe('决议 1 B+：暂停丢弃的痕迹与迟到转交', () => {
  it('onDiscard → 落痕迹系统消息（措辞不说死"丢弃"——迟到内容大概率会跟到）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions[0].opts.callbacks.onDiscard();
    const trace = engine.getMessages(m.id)
      .find((x) => x.kind === 'system' && x.content.includes('在途'));
    expect(trace).toBeTruthy();
    expect(trace!.content).toContain('稍后送达');
  });

  it('onLateResult(chatroom) → 落迟到系统消息并广播给在场成员', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onLateResult('暂停期间跑完的发言', 'chatroom');
    const trace = engine.getMessages(m.id)
      .find((x) => x.kind === 'system' && x.content.includes('暂停期间跑完的发言'));
    expect(trace).toBeTruthy();
    expect(trace!.channel).toBe('chatroom');
    expect(sessions[1].pushes.some((p) => p.text.includes('暂停期间跑完的发言'))).toBe(true);
    expect(sessions[0].pushes.length).toBe(0); // 不回推给发言者本人
  });

  it('红线：onLateResult(dm) 只落 dm channel、不广播（断言 channel 事实，不断言文案细节）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onLateResult('暂停期间跑完的私信回复', 'dm');
    // 只进 dm channel
    const dmMsgs = engine.getMessages(m.id).filter(
      (x) => x.channel === 'dm' && x.content.includes('暂停期间跑完的私信回复'));
    expect(dmMsgs.length).toBe(1);
    // 红线：绝不落入 chatroom channel、绝不广播
    const chatroomLeak = engine.getMessages(m.id).filter(
      (x) => x.channel === 'chatroom' && x.content.includes('暂停期间跑完的私信回复'));
    expect(chatroomLeak.length).toBe(0);
    expect(sessions[1].pushes.some((p) => p.text.includes('暂停期间跑完的私信回复'))).toBe(false);
  });

  it('onLateResult 的 [SKIP] 与空文本不落任何消息', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const before = engine.getMessages(m.id).length;
    sessions[0].opts.callbacks.onLateResult('[SKIP]', 'chatroom');
    sessions[0].opts.callbacks.onLateResult('  ', 'dm');
    expect(engine.getMessages(m.id).length).toBe(before);
  });
});

// 决议 5（陈终局注记）：SIGTERM 排水契约——优雅停止 = pause 全部 active 会议。
// close 后 consume 循环仍活着，排水窗口内迟到 result 经 onLateResult 落库；
// 窗口超时强杀则 onDiscard 痕迹（已随 pause 落）+ resume 对账补推兜底。
// 进程级 SIGTERM 注册是 engine-instance.ts 的胶水，此处测引擎侧可测核心
describe('决议 5：gracefulShutdown（SIGTERM 排水契约的引擎侧）', () => {
  it('active 会议全部 pause 并关闭会话；非 active 会议不动、无痕迹', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    // 另一场会议保持 paused（createMeeting 默认态）——不应被波及
    const idle = engine.createMeeting({
      title: 't2', topic: 'tp2',
      workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
      participants: [
        { templateId: 'dev', displayName: '王架构', goal: 'g' },
        { templateId: 'test', displayName: '赵分析', goal: 'g' },
      ],
    });
    const idleMsgCount = engine.getMessages(idle.id).length;

    const hadActive = await engine.gracefulShutdown();

    expect(hadActive).toBe(true); // 有 active 被停 → 调用方据此开排水窗口

    expect(engine.getMeeting(m.id).status).toBe('paused');
    expect(sessions.filter((s) => s.started).every((s) => s.closed)).toBe(true);
    expect(engine.getMeeting(idle.id).status).toBe('paused'); // 原本就 paused，不变
    expect(engine.getMessages(idle.id).length).toBe(idleMsgCount); // 无新消息、无痕迹
  });
});
