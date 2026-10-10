// src/components/room/types.ts
import type { MeetingRow, MessageRow } from '@/db/schema';
import type { AgentStatus, ParticipantInfo } from '@/lib/events';

export interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

export interface ParticipantView extends ParticipantInfo {
  capability: string;
  avatar: string;
}

export interface RoomData {
  meeting: MeetingRow;
  participants: ParticipantView[];
  messages: MessageRow[];
}

export type { AgentStatus };
