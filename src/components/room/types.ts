import type { MeetingRow, MessageRow } from '@/db/schema';

export interface ParticipantView {
  id: string;
  agentId: string;
  meetingRole: string;
  agent: { id: string; name: string; capability: string; avatar: string; description: string };
}

export interface RoomData {
  meeting: MeetingRow;
  participants: ParticipantView[];
  messages: MessageRow[];
}

export type AgentState = 'idle' | 'thinking' | 'tool' | 'speaking';
