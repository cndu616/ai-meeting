import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// 防线结构说明（契约纪律）：枚举列的 text({ enum }) 只是 drizzle 的**编译期类型收窄**，
// SQLite 运行时仍是自由 text、无 CHECK 约束——运行时防线在消费端 zod safeParse
// （src/lib/events.ts）。三层防线：TS 编译期（本文件）→ zod 运行时（events.ts）→ 无 DB 层约束。

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
  status: text('status', { enum: ['active', 'paused', 'ended'] }).notNull().default('paused'),
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
  channel: text('channel', { enum: ['chatroom', 'dm'] }).notNull(),
  participantId: text('participant_id'), // speech/dm_agent=发言者实例；dm=私聊目标实例；user/system=null
  kind: text('kind', { enum: ['speech', 'user', 'system', 'dm_user', 'dm_agent'] }).notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type ParticipantRow = typeof participants.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
