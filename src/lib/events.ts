import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { MessageRow } from '@/db/schema';

// ---------- 事件契约（zod 即合同：编译期类型 + 运行时校验单一来源） ----------
// 契约变更须 A/B 双评审（本文件属"动则对方评审"三个契约点之一）

export const meetingStatusSchema = z.enum(['active', 'paused', 'ended']);
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

export const agentStatusSchema = z.enum(['idle', 'thinking', 'tool', 'speaking', 'offline']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** 参会者视图（participant 事件与页面共用） */
export const participantInfoSchema = z.object({
  id: z.string(),
  templateId: z.string(),
  displayName: z.string(),
  goal: z.string(),
  muted: z.boolean(),
  speakOrder: z.number(),
  /** 展示字段随事件下发，保证 UI 增量渲染自足 */
  capability: z.string(),
  avatar: z.string(),
});
export type ParticipantInfo = z.infer<typeof participantInfoSchema>;

/** MessageRow 的 zod 镜像：drizzle 行类型无法直接派生，字段须与 db/schema.ts 的 messages 表同步维护 */
export const messageRowSchema = z.object({
  id: z.number(),
  meetingId: z.string(),
  channel: z.enum(['chatroom', 'dm']),
  participantId: z.string().nullable(),
  kind: z.enum(['speech', 'user', 'system', 'dm_user', 'dm_agent']),
  content: z.string(),
  createdAt: z.number(),
});

// 编译期防漂移断言（无运行时作用）：镜像 schema 与 drizzle 行类型双向赋值兼容，
// 任一侧字段增删改名、类型收窄/放宽即编译红——"同步维护"由编译器执行，不靠注释自觉
const _mirrorEqualsRow: MessageRow = null as unknown as z.infer<typeof messageRowSchema>;
const _rowEqualsMirror: z.infer<typeof messageRowSchema> = null as unknown as MessageRow;
void _mirrorEqualsRow;
void _rowEqualsMirror;

export const meetingEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), meetingId: z.string(), message: messageRowSchema }),
  z.object({
    type: z.literal('agent_status'),
    meetingId: z.string(),
    participantId: z.string(),
    status: agentStatusSchema,
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('participant'),
    meetingId: z.string(),
    participant: participantInfoSchema,
  }),
  z.object({
    type: z.literal('meeting_status'),
    meetingId: z.string(),
    status: meetingStatusSchema,
  }),
]);
export type MeetingEvent = z.infer<typeof meetingEventSchema>;

// ---------- 进程内事件总线（单实例部署假设，见 README 边界声明） ----------

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
