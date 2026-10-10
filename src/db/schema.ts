import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(), // slug，如 'dev'
  name: text('name').notNull(),
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
  maxRounds: integer('max_rounds').notNull().default(6),
  currentRound: integer('current_round').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  endedAt: integer('ended_at'),
});

export const participants = sqliteTable('participants', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id').notNull(),
  agentId: text('agent_id').notNull(),
  meetingRole: text('meeting_role').notNull(),
  sdkSessionId: text('sdk_session_id'),
  speakOrder: integer('speak_order').notNull(),
  lastInjectedMsgId: integer('last_injected_msg_id').notNull().default(0),
});

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  meetingId: text('meeting_id').notNull(),
  channel: text('channel').notNull(), // chatroom | dm
  agentId: text('agent_id'), // dm 时=私聊对象；speech 时=发言者；user/system 为 null
  kind: text('kind').notNull(), // speech | user | system | dm_user | dm_agent
  content: text('content').notNull(),
  round: integer('round'),
  createdAt: integer('created_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
