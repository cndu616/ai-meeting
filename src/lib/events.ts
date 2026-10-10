import { EventEmitter } from 'node:events';
import type { MessageRow } from '@/db/schema';

export type MeetingStatus = 'active' | 'paused' | 'ended';
export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'speaking';

export type MeetingEvent =
  | { type: 'message'; meetingId: string; message: MessageRow }
  | {
      type: 'agent_status';
      meetingId: string;
      agentId: string;
      status: AgentStatus;
      detail?: string;
    }
  | { type: 'round'; meetingId: string; round: number; phase: 'start' | 'end' }
  | { type: 'meeting_status'; meetingId: string; status: MeetingStatus };

const g = globalThis as unknown as { __meetingBus?: EventEmitter };

export function getBus(): EventEmitter {
  if (!g.__meetingBus) {
    g.__meetingBus = new EventEmitter();
    g.__meetingBus.setMaxListeners(200);
  }
  return g.__meetingBus;
}

export function emitMeetingEvent(e: MeetingEvent): void {
  getBus().emit(`meeting:${e.meetingId}`, e);
}

export function subscribeMeeting(
  meetingId: string,
  fn: (e: MeetingEvent) => void,
): () => void {
  const bus = getBus();
  const ch = `meeting:${meetingId}`;
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}
