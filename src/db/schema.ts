import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** agent 模板：岗位画像（无名字，名字在会议实例上） */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // slug，如 'dev'
  capability: text('capability').notNull(),
  description: text('description').notNull(),
  persona: text('persona').notNull(),
  avatar: text('avatar').notNull().default('🤖'),
});

export const meetings = sqliteTable('meetings', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  topic: text('topic').notNull(),
  workspacePath: text('workspace_path').notNull(),
  status: text('status').notNull().default('paused'), // active | paused | ended
  createdAt: integer('created_at').notNull(),
  endedAt: integer('ended_at'),
});

/** 参会者实例：一场会议里的一个"人"（同一模板可多实例） */
export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  templateId: text('template_id').notNull(),
  displayName: text('display_name').notNull(),
  goal: text('goal').notNull(),
  muted: integer('muted').notNull().default(0),
  sdkSessionId: text('sdk_session_id'),
  speakOrder: integer('speak_order').notNull(),
  lastInjectedMsgId: integer('last_injected_msg_id').notNull().default(0),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  meetingId: text('meeting_id').notNull(),
  channel: text('channel').notNull(), // chatroom | dm
  participantId: text('participant_id'), // speech/dm_agent=发言者实例；dm=私聊目标实例；user/system=null
  kind: text('kind').notNull(), // speech | user | system | dm_user | dm_agent
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
