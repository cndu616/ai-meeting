// src/components/room/types.ts
import type { MeetingRow, MessageRow } from '@/db/schema';
import type { AgentStatus, ParticipantInfo } from '@/lib/events';

export interface TemplateInfo {
  id: string;
  capability: string;
  description: string;
  avatar: string;
}

/** 语义别名：展示字段已由 ParticipantInfo 自足，供 UI 组件 props 引用 */
export interface ParticipantView extends ParticipantInfo {}

export interface RoomData {
  meeting: MeetingRow;
  participants: ParticipantView[];
  messages: MessageRow[];
}

export type { AgentStatus };
