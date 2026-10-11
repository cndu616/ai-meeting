// tests/engine-mute.test.ts —— 禁言语义：入口冻结 + 出口拦截双层，DM 豁免
// 语义定义（评审定稿）：禁言 = 发言权冻结。
//   入口：muted 期间聊天室消息不推送、水位线不推进（token 零消耗），解除时 catchUp 补发增量；
//   出口：muted 状态下到达的 chatroom 回合结果（飞行中回合/崩溃重放等防御路径）拦截转系统提示；
//   豁免：私信是一对一问答，不在"会议发言权"语义内，禁言不影响。
import { describe, it, expect } from 'vitest';
import { setupEngine } from './fake-session';

// 决议 2（2026-10-11 代码讨论会）：mute/unmute 消息化——落库 + 走广播。
// 动机（实弹事件）：禁言事件此前只存在于可查询历史、无实时推送，
// 在场者把"发不出声"误建模为"选择沉默"并施压，差点把不能表态记成弃权。
// "有记录"等于"没人看"——system 事件必须进广播流。
describe('决议 2：mute/unmute 消息化（落库 + 广播）', () => {
  it('setMuted(true) → 落系统消息并广播给其他在线成员；被禁言者入口冻结（零推送、水位不动）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    sessions.forEach((s) => (s.pushes = []));
    const before = engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId;

    engine.setMuted(m.id, ps[0].id, true);

    // 落库：一条禁言系统消息
    const muteMsg = engine.getMessages(m.id)
      .find((x) => x.kind === 'system' && x.content.includes('已被禁言'));
    expect(muteMsg).toBeTruthy();
    // 广播：其他在线成员实时收到，水位推进到该消息
    expect(sessions[1].pushes.length).toBe(1);
    expect(sessions[1].pushes[0].text).toContain('已被禁言');
    expect(engine.getParticipant(m.id, ps[1].id).lastInjectedMsgId).toBe(muteMsg!.id);
    // 被禁言者：入口冻结，零推送、水位不动（解禁时靠 catchUp 补看）
    expect(sessions[0].pushes.length).toBe(0);
    expect(engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId).toBe(before);
  });

  it('setMuted(false) → 落系统消息并广播；解禁者本人不实时收（靠 catchUp 增量按时间序补看完整轨迹）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    engine.sendUserMessage(m.id, '冻结期间的消息');
    sessions.forEach((s) => (s.pushes = []));

    engine.setMuted(m.id, ps[0].id, false);

    // 落库：一条解禁系统消息
    const unmuteMsg = engine.getMessages(m.id)
      .find((x) => x.kind === 'system' && x.content.includes('解除禁言'));
    expect(unmuteMsg).toBeTruthy();
    // 广播：其他成员实时收到
    expect(sessions[1].pushes.some((p) => p.text.includes('解除禁言'))).toBe(true);
    // 解禁者本人：只收到一次 catchUp（不重复推送），指令仍是禁言补课指令，
    // 增量含完整轨迹（"已被禁言" → 冻结期间消息 → "解除禁言"，按时间序）
    expect(sessions[0].pushes.length).toBe(1);
    const text = sessions[0].pushes[0].text;
    expect(text).toContain('禁言期间的讨论增量');
    expect(text.indexOf('已被禁言')).toBeLessThan(text.indexOf('冻结期间的消息'));
    expect(text.indexOf('冻结期间的消息')).toBeLessThan(text.indexOf('解除禁言'));
    // 补课后水位追平
    const p = engine.getParticipant(m.id, ps[0].id);
    expect(p.lastInjectedMsgId).toBe(unmuteMsg!.id);
  });

  it('出口拦截消息（"未被送达"）也走广播：在线成员实时知悉，原文仍零泄漏', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    sessions.forEach((s) => (s.pushes = []));

    sessions[0].opts.callbacks.onResult('我无视禁言也要发言', 'chatroom');

    // 拦截提示广播给未禁言成员（同根同修：不再只 emitMessage 给 UI）
    expect(sessions[1].pushes.some((p) => p.text.includes('未被送达'))).toBe(true);
    // 原文不落库、不出现在任何推送
    expect(engine.getMessages(m.id).some((x) => x.content === '我无视禁言也要发言')).toBe(false);
    const allPushText = [...sessions[0].pushes, ...sessions[1].pushes].map((p) => p.text).join('\n');
    expect(allPushText).not.toContain('我无视禁言也要发言');
  });
});

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
    // 落一条拦截系统提示。system 构成：开场 1 + setMuted 通知 1 + 拦截 1 = 3（决议 2 新增中间那条）
    const sysMsgs = engine.getMessages(m.id).filter((x) => x.kind === 'system');
    expect(sysMsgs.length).toBe(3);
    expect(sysMsgs.filter((x) => x.content.includes('未被送达')).length).toBe(1);
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

// 决议 4 回写时裁决的实现不一致（陈禁言前指出）：catchUp 无 muted 检查——
// 冻结成员的会话若崩溃重建，onRestart 路径会照常补发增量并推进水位，
// 与入口冻结的"零消耗"语义矛盾。裁决：冻结含重建补发（跳过 muted），
// 解禁时 setMuted 的 catchUp 补完整增量（水位未动，不丢不重）
describe('决议 4 裁决：catchUp 冻结一致性', () => {
  it('muted 成员的 onRestart 重建不补发增量、不推进水位', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    const watermarkBefore = engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId;
    sessions[0].pushes = [];

    sessions[0].opts.callbacks.onRestart(); // 崩溃重建路径的 catchUp

    expect(sessions[0].pushes.length).toBe(0); // 冻结：不补发
    expect(engine.getParticipant(m.id, ps[0].id).lastInjectedMsgId)
      .toBe(watermarkBefore); // 水位不动

    // 对照：未禁言成员的重建照常补发
    sessions[1].pushes = [];
    sessions[1].opts.callbacks.onRestart();
    expect(sessions[1].pushes.length).toBeGreaterThan(0);
  });

  it('解禁后 catchUp 补完整增量（冻结期间消息一条不丢）', () => {
    const { engine, m, sessions } = setupEngine();
    engine.start(m.id);
    const ps = engine.getParticipants(m.id);
    engine.setMuted(m.id, ps[0].id, true);
    engine.sendUserMessage(m.id, '冻结期间的消息');
    engine.setMuted(m.id, ps[0].id, false);

    const last = sessions[0].pushes[sessions[0].pushes.length - 1].text;
    expect(last).toContain('冻结期间的消息');
    expect(last).toContain('此前被主持人禁言');
  });
});
