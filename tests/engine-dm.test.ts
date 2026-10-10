// tests/engine-dm.test.ts
import { describe, it, expect, vi } from 'vitest';
import { setupEngine } from './fake-session';
import { subscribeMeeting } from '@/lib/events';

describe('私聊', () => {
  it('active 会议：DM 立即推入目标会话（kind=dm），其他人不收', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '私下聊聊？');
    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].kind).toBe('dm');
    expect(sessions[0].pushes[0].text).toContain('私下聊聊？');
    expect(sessions[1].pushes.length).toBe(0);
  });

  it('DM 回复落库为 dm_agent，不进聊天室广播', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '在吗');
    sessions[0].opts.callbacks.onResult('在的，说吧', 'dm');
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'dm_agent']);
    expect(sessions[1].pushes.length).toBe(0); // 不广播
  });

  it('禁言不影响私信', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    sessions.forEach((s) => (s.pushes = []));
    await engine.sendDm(m.id, ps[0].id, '还是聊聊');
    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].kind).toBe('dm');
    expect(sessions[0].pushes[0].text).toContain('[user 私信→你] 还是聊聊');
    expect(sessions[0].pushes[0].text).not.toContain('禁言');
  });

  it('paused 会议：DM 走一次性会话（回复后关闭）', async () => {
    const { engine, m, sessions } = setupEngine();
    const ps = engine.getParticipants(m.id);
    // 不 start：会议 paused，工厂此时创建一次性 FakeSession（sessions[0]）
    const dmPromise = engine.sendDm(m.id, ps[0].id, '暂停时也找你');
    const offline = sessions[0];
    expect(offline.started).toBe(true);
    expect(offline.pushes[0].kind).toBe('dm');
    // sendDm 的 promise 在收到 onResult 前不 resolve——手动触发回复
    offline.opts.callbacks.onResult('收到', 'dm');
    await dmPromise;
    expect(offline.closed).toBe(true);
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'dm_agent']);
  });

  it('paused 私信：onDead 落失败 system 消息并放行收尾', async () => {
    const { engine, m, sessions } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const dmPromise = engine.sendDm(m.id, ps[0].id, '在吗');
    const offline = sessions[0];
    offline.opts.callbacks.onDead();
    await dmPromise; // onDead 也必须 finish，否则要等 120s 超时兜底
    expect(offline.closed).toBe(true);
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'system']);
    expect(dmMsgs[1].content).toContain('私信回复失败');
  });

  it('paused 私聊超时：120s 落 system 超时消息、关闭会话、状态回 idle', async () => {
    vi.useFakeTimers();
    try {
      const { engine, m, sessions } = setupEngine();
      const ps = engine.getParticipants(m.id);
      // 订阅状态事件，验证超时收尾后回 idle
      const statuses: { participantId: string; status: string }[] = [];
      const off = subscribeMeeting(m.id, (e) => {
        if (e.type === 'agent_status') statuses.push({ participantId: e.participantId, status: e.status });
      });
      const dmPromise = engine.sendDm(m.id, ps[0].id, '超时测试');
      const offline = sessions[0];
      vi.advanceTimersByTime(120_000);
      await dmPromise;
      off();
      expect(offline.closed).toBe(true);
      const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
      expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'system']);
      expect(dmMsgs[1].content).toContain('私信回复超时');
      const last = statuses[statuses.length - 1];
      expect(last).toEqual({ participantId: ps[0].id, status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });
});
