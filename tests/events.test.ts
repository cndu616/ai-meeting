import { describe, it, expect, vi } from 'vitest';
import { emitMeetingEvent, subscribeMeeting } from '@/lib/events';

describe('events', () => {
  it('participant 事件可订阅与退订', () => {
    const fn = vi.fn();
    const off = subscribeMeeting('m1', fn);
    emitMeetingEvent({
      type: 'participant',
      meetingId: 'm1',
      participant: { id: 'p1', templateId: 'dev', displayName: '张工', goal: 'g', muted: false, speakOrder: 0 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    emitMeetingEvent({
      type: 'participant',
      meetingId: 'm1',
      participant: { id: 'p1', templateId: 'dev', displayName: '张工', goal: 'g', muted: true, speakOrder: 0 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('agent_status 按 participantId 送达', () => {
    const fn = vi.fn();
    const off = subscribeMeeting('m2', fn);
    emitMeetingEvent({ type: 'agent_status', meetingId: 'm2', participantId: 'p9', status: 'offline' });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ participantId: 'p9', status: 'offline' }));
    off();
  });
});
