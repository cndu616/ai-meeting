// tests/engine-prompt.test.ts —— system prompt 的消息格式说明（决议 4 修复项）
// 实弹缺陷：晚入场 agent 的历史全为带标签格式，in-context 模仿压倒指令语义，
// 发言自带 [chatroom …] 前缀与系统包装叠加成双前缀；且发言者收不到自己的广播、
// 对双前缀无感知。修复：格式说明附实际 case、动态指认"哪行是自己"。
// 实现注记：只给正例不给反例——负例格式有被模仿的引力
import { describe, it, expect } from 'vitest';
import { setupEngine } from './fake-session';

describe('决议 4：system prompt 消息格式说明', () => {
  it('含实际 case、动态指认本人标签行、说明补发机制与正文要求', () => {
    const { engine, m } = setupEngine();
    const ps = engine.getParticipants(m.id); // 张工(dev) / 李测试(test)
    const prompt = engine.buildSystemPrompt(m.id, ps[0].id);

    // case 使用真实推送格式，覆盖三类行
    expect(prompt).toContain('[chatroom 用户]');
    expect(prompt).toContain(`[chatroom ${ps[1].displayName}·`); // 其他参会者的行
    expect(prompt).toContain('[user 私信→你]');

    // 动态指认：本人标签在 case 中出现且被说明"这是你自己"
    const selfLabel = `[chatroom ${ps[0].displayName}·`;
    expect(prompt).toContain(selfLabel);
    const caseIdx = prompt.indexOf(selfLabel);
    const after = prompt.slice(caseIdx, caseIdx + 300);
    expect(after).toContain('你自己');

    // 机制说明：平时收不到自己消息、补发时才见（解释双前缀无感知的成因）
    expect(prompt).toContain('收不到自己');

    // 正文要求：直接从内容写起，不加任何标签（正例导向，不出示反例样式）
    expect(prompt).toContain('正文直接从内容写起');
    expect(prompt).not.toMatch(/\[chatroom \[chatroom/); // 反例格式绝不出现
  });

  it('两个成员的 prompt 各自指认正确的本人标签', () => {
    const { engine, m } = setupEngine();
    const ps = engine.getParticipants(m.id);
    const p0 = engine.buildSystemPrompt(m.id, ps[0].id);
    const p1 = engine.buildSystemPrompt(m.id, ps[1].id);
    // p0 的说明以 ps[0] 为"你"，p1 以 ps[1] 为"你"——不是硬编码同一人
    expect(p0).toContain(`[chatroom ${ps[0].displayName}·`);
    expect(p1).toContain(`[chatroom ${ps[1].displayName}·`);
    expect(p0).not.toContain(`你就是「${ps[1].displayName}」`);
  });
});
