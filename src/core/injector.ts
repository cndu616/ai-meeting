import { and, eq, gt } from 'drizzle-orm';
import { messages, participants, type MessageRow } from '@/db/schema';
import type { DB } from '@/db/client';

export const SKIP_TOKEN = '[SKIP]';

export function isSkip(text: string): boolean {
  return text.trim() === SKIP_TOKEN;
}

/** 收集某参会者水位之后的聊天室消息（不含 dm，含自己此前发言） */
export function collectChatroomIncrement(
  db: DB,
  meetingId: string,
  participantId: string,
): MessageRow[] {
  const p = db.select().from(participants)
    .where(eq(participants.id, participantId)).get();
  if (!p) throw new Error(`participant ${participantId} 不存在`);
  return db.select().from(messages)
    .where(and(
      eq(messages.meetingId, meetingId),
      eq(messages.channel, 'chatroom'),
      gt(messages.id, p.lastInjectedMsgId),
    ))
    .all();
}

export interface SenderInfo {
  name: string; // displayName
  capability: string;
}

/** 把一条聊天室消息渲染为推送给 agent 的文本行 */
export function chatroomLine(row: MessageRow, senders: Map<string, SenderInfo>): string {
  if (row.kind === 'user') return `[chatroom 用户] ${row.content}`;
  if (row.kind === 'system') return `[system] ${row.content}`;
  const s = row.participantId ? senders.get(row.participantId) : undefined;
  const label = s ? `${s.name}·${s.capability}` : '未知参会者';
  return `[chatroom ${label}] ${row.content}`;
}

export function buildDmPrompt(content: string): string {
  return `[user 私信→你] ${content}

[system] 以上是用户发给你的私信（仅你可见，其他参会者看不到）。请直接回复用户，回复同样仅用户可见、不会进入聊天室。`;
}

/** 开场/恢复/入会共用的指令构造器：指令 + 花名册 + 历史消息行 */
export function buildKickoffPrompt(input: {
  directive: string;
  roster?: string;
  history: MessageRow[];
  senders: Map<string, SenderInfo>;
}): string {
  const parts: string[] = [input.directive];
  if (input.roster) parts.push(`# 参会者\n${input.roster}`);
  if (input.history.length) {
    parts.push(
      `# 最新讨论记录\n${input.history.map((r) => chatroomLine(r, input.senders)).join('\n')}`,
    );
  }
  parts.push(`[system] 请基于以上内容发言表态；若无话可说，只回复 ${SKIP_TOKEN}。`);
  return parts.join('\n\n');
}
