import { describe, it, expect } from 'vitest';
import { emitMeetingEvent, subscribeMeeting, type MeetingEvent } from '@/lib/events';

describe('events', () => {
  it('按会议频道订阅/退订事件', () => {
    const got: MeetingEvent[] = [];
    const unsub = subscribeMeeting('m1', (e) => got.push(e));
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm1', status: 'active' });
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm2', status: 'active' }); // 其他会议，不收到
    unsub();
    emitMeetingEvent({ type: 'meeting_status', meetingId: 'm1', status: 'paused' });
    expect(got.length).toBe(1);
    expect(got[0].status).toBe('active');
  });
});
