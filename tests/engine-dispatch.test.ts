// tests/engine-dispatch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { setupEngine } from './fake-session';
import { subscribeMeeting } from '@/lib/events';

describe('分发矩阵', () => {
  it('start：为每个成员建会话并推送开场指令（含开场系统消息增量）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    expect(sessions.length).toBe(2);
    expect(sessions.every((s) => s.started)).toBe(true);
    const first = sessions[0].pushes[0];
    expect(first.kind).toBe('chatroom');
    expect(first.text).toContain('现在开始');
    expect(first.text).toContain('[system]'); // 开场系统消息作为增量
  });

  it('用户消息：广播给所有在线成员（各自水位线推进）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '大家怎么看？');
    for (const s of sessions) {
      expect(s.pushes.length).toBe(1);
      expect(s.pushes[0].text).toBe('[chatroom 用户] 大家怎么看？');
    }
    const ps = engine.getParticipants(m.id);
    // 两个成员的水位线都推进到了最新消息 id
    const maxId = engine.getMessages(m.id)
      .reduce((a, b) => (b.id > a ? b.id : a), 0);
    expect(ps.every((p) => p.lastInjectedMsgId === maxId)).toBe(true);
  });

  it('agent 发言：落库并广播给其他人（不含自己）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onResult('我主张重写', 'chatroom');
    const speeches = engine.getMessages(m.id).filter((x) => x.kind === 'speech');
    expect(speeches.length).toBe(1);
    expect(speeches[0].participantId).toBe(ps[0].id);
    expect(sessions[0].pushes.length).toBe(0); // 不推给自己
    expect(sessions[1].pushes.length).toBe(1);
    expect(sessions[1].pushes[0].text).toContain('[chatroom 张工·研发] 我主张重写');
  });

  it('[SKIP]：不落库不分发', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions.forEach((s) => (s.pushes = []));
    sessions[0].opts.callbacks.onResult('[SKIP]', 'chatroom');
    sessions[1].opts.callbacks.onResult('', 'chatroom');
    expect(engine.getMessages(m.id).filter((x) => x.kind === 'speech').length).toBe(0);
    expect(sessions.every((s) => s.pushes.length === 0)).toBe(true);
  });

  it('禁言成员：仍收到广播但带禁言后缀', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[1].id, true);
    sessions.forEach((s) => (s.pushes = []));
    engine.sendUserMessage(m.id, '继续');
    expect(sessions[1].pushes[0].text).toContain('禁言');
    expect(sessions[1].pushes[0].text).toContain('[chatroom 用户] 继续');
    expect(sessions[0].pushes[0].text).not.toContain('禁言');
  });

  it('工具活动：仅状态事件，不进聊天室', async () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const p0 = engine.getParticipants(m.id)[0];

    // 正向断言：onTool 发出 agent_status 状态事件
    const events: unknown[] = [];
    const unsubscribe = subscribeMeeting(m.id, (e) => events.push(e));
    sessions[0].opts.callbacks.onTool('Read', '/a.ts');
    await vi.waitFor(() => {
      if (!events.some(
        (e) => e.type === 'agent_status'
          && e.participantId === p0.id
          && e.status === 'tool'
          && (e.detail as string).includes('Read /a.ts'),
      )) throw new Error('未收到 agent_status(tool) 事件');
    });
    unsubscribe();

    // 反向断言：不落聊天室消息库
    const msgs = engine.getMessages(m.id);
    expect(msgs.every((x) => !x.content.includes('/a.ts'))).toBe(true);
  });
});
