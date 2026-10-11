import { describe, it, expect, vi } from 'vitest';
import { participants as participantsTable } from '@/db/schema';
import { setupEngine } from './fake-session';

describe('崩溃路径（审查修复）', () => {
  it('onDead 摘除会话：广播不推死会话、水位线不推进、start 可重建', async () => {
    const { db, engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));

    sessions[0].opts.callbacks.onDead();
    expect(engine.getMeeting(m.id).status).toBe('active'); // 会议不受影响

    // 广播：掉线者不再被推送、水位线不推进；在线者照常
    engine.sendUserMessage(m.id, '掉线后的消息');
    expect(sessions[0].pushes.length).toBe(0);
    expect(sessions[1].pushes.length).toBe(1);
    const p0 = db.select().from(participantsTable).all().find((p) => p.id === ps[0].id)!;
    const p1 = db.select().from(participantsTable).all().find((p) => p.id === ps[1].id)!;
    const latest = engine.getMessages(m.id).reduce((a, b) => Math.max(a, b.id), 0);
    expect(p1.lastInjectedMsgId).toBe(latest);
    expect(p0.lastInjectedMsgId).toBeLessThan(latest); // 未推进——留待恢复补发

    // start 可重建掉线者（has 不再挡）
    engine.start(m.id);
    expect(sessions.length).toBe(3); // 重建了一个
    const rebuilt = sessions[sessions.length - 1];
    expect(rebuilt.opts.resumeSessionId).toBeUndefined(); // 从未拿到 sessionId
    // 补发包含掉线期间消息
    expect(rebuilt.pushes[0].text).toContain('掉线后的消息');
  });

  it('暂停态私信中途崩溃：onRestart 重发后收到回复并正常收尾', async () => {
    const { engine, m, sessions } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const dmPromise = engine.sendDm(m.id, ps[0].id, '暂停时也找你');
    // DM 离线走排队链（microtask 后建一次性会话），先等会话建立再取
    await vi.waitFor(() => expect(sessions.length).toBe(1));
    const offline = sessions[0];
    expect(offline.pushes[0].kind).toBe('dm');

    offline.opts.callbacks.onRestart(); // 模拟崩溃重建完成 → 应重发私信
    expect(offline.pushes.length).toBe(2);
    expect(offline.pushes[1].kind).toBe('dm');
    expect(offline.pushes[1].text).toContain('暂停时也找你');

    offline.opts.callbacks.onResult('收到', 'dm');
    await dmPromise; // gate 落定不挂起
    expect(offline.closed).toBe(true);
    const dmMsgs = engine.getMessages(m.id).filter((x) => x.channel === 'dm');
    expect(dmMsgs.map((x) => x.kind)).toEqual(['dm_user', 'dm_agent']);
  });
});
