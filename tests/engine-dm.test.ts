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
    // 不 start：会议 paused，工厂此时创建一次性 FakeSession（sessions[0]）；
    // 离线 DM 走排队链（microtask 后建会话），先等会话建立再取
    const dmPromise = engine.sendDm(m.id, ps[0].id, '暂停时也找你');
    await vi.waitFor(() => expect(sessions.length).toBe(1));
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
    await vi.waitFor(() => expect(sessions.length).toBe(1));
    const offline = sessions[0];
    offline.opts.callbacks.onDead();
    await dmPromise; // onDead 也必须 finish，否则要等 120s 超时兜底
    expect(offline.closed).toBe(true);
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'system']);
    expect(dmMsgs[1].content).toContain('私信回复失败');
  });

  it('paused 私聊超时：120s 落 system 超时消息、状态回 idle（会话留待迟到回复后关闭）', async () => {
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
      await vi.advanceTimersByTimeAsync(0); // flush 排队链：一次性会话已建立
      const offline = sessions[0];
      vi.advanceTimersByTime(120_000);
      await dmPromise;
      off();
      const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
      expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'system']);
      expect(dmMsgs[1].content).toContain('私信回复超时');
      const last = statuses[statuses.length - 1];
      expect(last).toEqual({ participantId: ps[0].id, status: 'idle' });
      // 超时不立即关会话：SDK 的 turn 可能仍在跑，迟到回复需能通行
      offline.opts.callbacks.onResult('迟到的正文', 'dm');
      expect(offline.closed).toBe(true);
      expect(engine.getMessages(m.id).some(
        (x) => x.kind === 'system' && x.channel === 'dm' && x.content.includes('姗姗来迟'),
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paused 连发两条私信给同一成员：串行排队，第二轮等第一轮收尾后才建会话（并发修复）', async () => {
    const { engine, m, sessions } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const first = engine.sendDm(m.id, ps[0].id, '私信一');
    const second = engine.sendDm(m.id, ps[0].id, '私信二');
    await vi.waitFor(() => expect(sessions.length).toBe(1)); // 第一轮排队链已建会话
    const offline1 = sessions[0];
    // 排队语义：第一轮未收尾前，不得并发建第二个一次性会话（避免并发 resume 同一 sdkSessionId 链）
    expect(sessions.length).toBe(1);
    offline1.opts.callbacks.onResult('回一', 'dm');
    await first;
    await vi.waitFor(() => expect(sessions.length).toBe(2)); // 第一轮收尾后第二轮才开跑
    sessions[1].opts.callbacks.onResult('回二', 'dm');
    await second;
    // 两轮消息严格按序交错，不出现转录竞争
    const dmKinds = engine.getMessages(m.id)
      .filter((x) => x.channel === 'dm')
      .map((x) => x.kind);
    expect(dmKinds).toEqual(['dm_user', 'dm_agent', 'dm_user', 'dm_agent']);
  });

  it('paused 私信超时后迟到回复：不落正常 dm_agent，转「姗姗来迟」系统消息（DM 有等待方）', async () => {
    vi.useFakeTimers();
    try {
      const { engine, m, sessions } = setupEngine();
      const ps = engine.getParticipants(m.id);
      const dmPromise = engine.sendDm(m.id, ps[0].id, '超时后回复测试');
      await vi.advanceTimersByTimeAsync(0); // flush 排队链：一次性会话已建立
      const offline = sessions[0];
      vi.advanceTimersByTime(120_000);
      await dmPromise;
      offline.opts.callbacks.onResult('这是一条迟到的回复正文', 'dm');
      const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
      expect(dmMsgs.some(
        (x) => x.kind === 'dm_agent' && x.content === '这是一条迟到的回复正文',
      )).toBe(false);
      expect(dmMsgs.some(
        (x) => x.kind === 'system' && x.content.includes('姗姗来迟'),
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 决议 1（B+）第 3 点：resume/start 对账补推——某成员最后一条 dm 消息是 dm_user
// （无 dm_agent/dm_system 回应）则重 push 补推；超时/失败/迟到类 dm system 算已回应。
// 位置在 start 的 launch 闭包内、catchUp 之后（先补上下文再处理私信）
describe('决议 1 B+：恢复对账补推无回应私信', () => {
  it('最后一条 dm 是 dm_user（无回应）→ resume 重建后补推私信', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    // 用户私信、agent 未及回复（无任何回应）→ 暂停吞掉飞行回合 → resume
    await engine.sendDm(m.id, ps[0].id, '没被回复的私信');
    await engine.pause(m.id);
    await engine.resume(m.id);

    // 重建后的张工会话（start 按 speakOrder 重建：sessions[2]）
    const fresh = sessions[2];
    const dmPushes = fresh.pushes.filter((p) => p.kind === 'dm');
    expect(dmPushes.length).toBe(1);
    expect(dmPushes[0].text).toContain('没被回复的私信');
    // 顺序：catchUp（chatroom 上下文）先于 dm 补推
    const catchUpIdx = fresh.pushes.findIndex((p) => p.kind === 'chatroom');
    const dmIdx = fresh.pushes.findIndex((p) => p.kind === 'dm');
    expect(catchUpIdx).toBeGreaterThanOrEqual(0);
    expect(catchUpIdx).toBeLessThan(dmIdx);
  });

  it('最后一条 dm 已有 dm_agent 回应 → 不补推', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    await engine.sendDm(m.id, ps[0].id, '已被回复的私信');
    sessions[0].opts.callbacks.onResult('正常回复', 'dm');
    await engine.pause(m.id);
    await engine.resume(m.id);
    expect(sessions[2].pushes.filter((p) => p.kind === 'dm').length).toBe(0);
  });

  it('最后一条 dm 是 dm system（超时/失败/迟到类交代）→ 算已回应，不补推', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    await engine.sendDm(m.id, ps[0].id, '得到交代的私信');
    sessions[0].opts.callbacks.onLateResult('迟到的回复', 'dm'); // 落 dm system
    await engine.pause(m.id);
    await engine.resume(m.id);
    expect(sessions[2].pushes.filter((p) => p.kind === 'dm').length).toBe(0);
  });
});
