// tests/engine-mute.test.ts —— 禁言语义：入口冻结 + 出口拦截双层，DM 豁免
// 语义定义（评审定稿）：禁言 = 发言权冻结。
//   入口：muted 期间聊天室消息不推送、水位线不推进（token 零消耗），解除时 catchUp 补发增量；
//   出口：muted 状态下到达的 chatroom 回合结果（飞行中回合/崩溃重放等防御路径）拦截转系统提示；
//   豁免：私信是一对一问答，不在"会议发言权"语义内，禁言不影响。
import { describe, it, expect } from 'vitest';
import { setupEngine } from './fake-session';

describe('禁言：出口拦截（防御路径）', () => {
  it('muted 期间违规 speech → 原文不落库、不出现在任何成员推送、落一条拦截系统提示', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    sessions[0].pushes = [];
    sessions[1].pushes = [];

    sessions[0].opts.callbacks.onResult('我无视禁言也要发言', 'chatroom');

    // 原文不落库
    expect(engine.getMessages(m.id).some((x) => x.content === '我无视禁言也要发言')).toBe(false);
    // 原文不出现在任何成员的推送里（含拦截后广播的系统提示内容）
    const allPushText = [...sessions[0].pushes, ...sessions[1].pushes].map((p) => p.text).join('\n');
    expect(allPushText).not.toContain('我无视禁言也要发言');
    // 落一条拦截系统提示
    const sysMsgs = engine.getMessages(m.id).filter((x) => x.kind === 'system' && x.content.includes('禁言'));
    expect(sysMsgs.length).toBe(1);
  });
});

describe('禁言：入口冻结', () => {
  it('muted 期间聊天室新消息 → 零推送、水位线不动；未禁言成员正常接收', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    const before = engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId;

    engine.setMuted(m.id, ps[0].id, true);
    sessions[0].pushes = [];
    sessions[1].pushes = [];
    engine.sendUserMessage(m.id, '禁言期间的新消息');

    expect(sessions[0].pushes.length).toBe(0); // 禁言者零推送
    expect(sessions[1].pushes.length).toBe(1); // 未禁言者正常收到
    expect(sessions[1].pushes[0].text).toContain('禁言期间的新消息');
    expect(engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId).toBe(before); // 水位线不动
    // 旁路保护：未禁言成员水位线必须照常推进（入口冻结最易顺手改坏处）
    const newMsg = engine.getMessages(m.id).find((x) => x.content === '禁言期间的新消息')!;
    expect(engine.getParticipant(m.id, ps[1].id).lastInjectedMsgId).toBe(newMsg.id);
  });

  it('解除禁言 → catchUp 补发冻结期间增量，指令显式说明此前被禁言（防补课后长篇反弹）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    engine.sendUserMessage(m.id, '冻结期间的消息1');
    engine.sendUserMessage(m.id, '冻结期间的消息2');

    sessions[0].pushes = [];
    engine.setMuted(m.id, ps[0].id, false);

    expect(sessions[0].pushes.length).toBe(1);
    const text = sessions[0].pushes[0].text;
    expect(text).toContain('禁言'); // 指令含禁言说明
    expect(text).toContain('冻结期间的消息1');
    expect(text).toContain('冻结期间的消息2');
    expect(text.indexOf('冻结期间的消息1')).toBeLessThan(text.indexOf('冻结期间的消息2')); // 增量有序
    // 补发后水位线追平
    const p = engine.getParticipant(m.id, ps[0].id);
    const maxId = Math.max(...engine.getMessages(m.id).map((x) => x.id));
    expect(p.lastInjectedMsgId).toBe(maxId);
    // 旁路保护：未禁言成员水位线同样追平（不被入口冻结误伤）
    expect(engine.getParticipant(m.id, ps[1].id).lastInjectedMsgId).toBe(maxId);
  });
});

describe('isSkip 边界（防误杀锁定）', () => {
  it('非禁言成员回「[SKIP]，不过…」→ 照常落库广播，不吞带实质补充的发言', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    sessions[1].pushes = [];

    sessions[0].opts.callbacks.onResult('[SKIP]，不过我想补充一点', 'chatroom');

    // isSkip 保持严格相等：skip 前缀 + 实质内容 = 正常发言，误杀比漏杀伤害大
    expect(engine.getMessages(m.id).some(
      (x) => x.kind === 'speech' && x.content === '[SKIP]，不过我想补充一点',
    )).toBe(true);
    expect(sessions[1].pushes.some((p) => p.text.includes('[SKIP]，不过我想补充一点'))).toBe(true);
  });
});

describe('禁言：DM 豁免（语义锁定，防后人误改）', () => {
  it('muted 期间私信照常推送与回复', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    sessions[0].pushes = [];

    engine.sendDm(m.id, ps[0].id, '私信不受禁言影响');

    expect(sessions[0].pushes.length).toBe(1);
    expect(sessions[0].pushes[0].kind).toBe('dm');
    // DM 回复照常落库（dm_agent），不受出口拦截影响
    sessions[0].opts.callbacks.onResult('这是私信回复', 'dm');
    const msgs = engine.getMessages(m.id);
    expect(msgs.some((x) => x.kind === 'dm_agent' && x.content === '这是私信回复')).toBe(true);
  });
});
