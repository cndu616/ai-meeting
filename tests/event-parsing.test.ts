// tests/event-parsing.test.ts —— SSE 消费端两层防线：JSON.parse 防畸形 JSON 炸 onmessage，
// zod safeParse 防结构/字面量不合法；畸形事件隔离——一条坏事件只污染自己，不中断后续处理。
import { describe, it, expect } from 'vitest';
import { parseMeetingEvent } from '@/lib/eventParsing';

const validMessage = {
  type: 'message',
  meetingId: 'm1',
  message: {
    id: 1, meetingId: 'm1', channel: 'chatroom', participantId: null,
    kind: 'system', content: '开场', createdAt: 1,
  },
};

describe('parseMeetingEvent', () => {
  it('合法 message 事件通过', () => {
    const r = parseMeetingEvent(JSON.stringify(validMessage));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.type).toBe('message');
  });

  it('畸形 JSON 拒绝，reason 人类可读', () => {
    const r = parseMeetingEvent('{bad json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('schema 不匹配拒绝：缺必填字段（agent_status 缺 status）', () => {
    const r = parseMeetingEvent(JSON.stringify({ type: 'agent_status', meetingId: 'm1', participantId: 'p1' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('schema 不匹配拒绝：非法字面量（meeting_status.status=bogus）', () => {
    const r = parseMeetingEvent(JSON.stringify({ type: 'meeting_status', meetingId: 'm1', status: 'bogus' }));
    expect(r.ok).toBe(false);
  });

  it('四类合法事件全部通过', () => {
    const events = [
      validMessage,
      { type: 'agent_status', meetingId: 'm1', participantId: 'p1', status: 'thinking', detail: '私聊中' },
      { type: 'participant', meetingId: 'm1', participant: { id: 'p1', templateId: 'dev', displayName: '张工', goal: 'g', muted: false, speakOrder: 0, capability: '研发', avatar: '🧑‍💻' } },
      { type: 'meeting_status', meetingId: 'm1', status: 'active' },
    ];
    for (const e of events) {
      const r = parseMeetingEvent(JSON.stringify(e));
      expect(r.ok).toBe(true);
    }
  });
});
