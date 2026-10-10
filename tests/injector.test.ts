import { describe, it, expect } from 'vitest';
import {
  isSkip, chatroomLine, buildDmPrompt, buildKickoffPrompt, type SenderInfo,
} from '@/core/injector';
import type { MessageRow } from '@/db/schema';

const row = (over: Partial<MessageRow>): MessageRow => ({
  id: 1, meetingId: 'm1', channel: 'chatroom', participantId: null,
  kind: 'user', content: 'hi', createdAt: 0, ...over,
});

const senders = new Map<string, SenderInfo>([
  ['p1', { name: '张工', capability: '研发' }],
]);

describe('injector', () => {
  it('isSkip 只认纯 [SKIP]', () => {
    expect(isSkip('[SKIP]')).toBe(true);
    expect(isSkip(' [SKIP] ')).toBe(true);
    expect(isSkip('我认为…[SKIP]')).toBe(false);
    expect(isSkip('[SKIP]，但我还想说两句')).toBe(false);
  });

  it('chatroomLine：用户/系统/成员发言三种前缀', () => {
    expect(chatroomLine(row({ kind: 'user', content: '大家好' }), senders))
      .toBe('[chatroom 用户] 大家好');
    expect(chatroomLine(row({ kind: 'system', content: '会议开始' }), senders))
      .toBe('[system] 会议开始');
    expect(chatroomLine(row({ kind: 'speech', participantId: 'p1', content: '我反对' }), senders))
      .toBe('[chatroom 张工·研发] 我反对');
    expect(chatroomLine(row({ kind: 'speech', participantId: 'pX', content: '??' }), senders))
      .toBe('[chatroom 未知参会者] ??');
  });

  it('buildDmPrompt 带私信规则', () => {
    expect(buildDmPrompt('在吗')).toContain('[user 私信→你] 在吗');
    expect(buildDmPrompt('在吗')).toContain('仅你可见');
  });

  it('buildKickoffPrompt：开场指令 + roster + 历史行', () => {
    const p = buildKickoffPrompt({
      directive: '会议现在开始。请简短表态。',
      roster: '- 张工（研发）：激进派\n- 李工（测试）：保守派',
      history: [
        row({ kind: 'system', content: '会议开始' }),
        row({ id: 2, kind: 'user', content: '大家好' }),
      ],
      senders,
    });
    expect(p).toContain('会议现在开始。请简短表态。');
    expect(p).toContain('- 张工（研发）：激进派');
    expect(p).toContain('[system] 会议开始');
    expect(p).toContain('[chatroom 用户] 大家好');
    expect(p).toContain('[SKIP]');
    // 全等锁定段落顺序与 \n\n 分隔：directive → # 参会者 → # 最新讨论记录 → 尾指令
    expect(p).toBe(`会议现在开始。请简短表态。

# 参会者
- 张工（研发）：激进派
- 李工（测试）：保守派

# 最新讨论记录
[system] 会议开始
[chatroom 用户] 大家好

[system] 请基于以上内容发言表态；若无话可说，只回复 [SKIP]。`);
  });

  it('history 为空且无 roster 时不输出对应段落', () => {
    const p = buildKickoffPrompt({ directive: '继续。', history: [], senders });
    expect(p).not.toContain('# 参会者');
    expect(p).not.toContain('# 最新讨论记录');
    expect(p).toContain('继续。');
    expect(p).toContain('[SKIP]');
  });
});
