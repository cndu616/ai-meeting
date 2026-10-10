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
  name: string;
  capability: string;
}

function chatroomLine(row: MessageRow, agentsById: Map<string, SenderInfo>): string {
  if (row.kind === 'user') return `[chatroom 用户] ${row.content}`;
  if (row.kind === 'system') return `[system] ${row.content}`;
  const a = row.agentId ? agentsById.get(row.agentId) : undefined;
  const label = a ? `${a.name}·${a.capability}` : '未知参会者';
  return `[chatroom ${label}] ${row.content}`;
}

export function buildSpeechPrompt(input: {
  increment: MessageRow[];
  agentsById: Map<string, SenderInfo>;
  round: number;
}): string {
  const lines = input.increment.map((r) => chatroomLine(r, input.agentsById));
  const head = lines.length
    ? lines.join('\n')
    : '（自你上次发言以来没有新的聊天室消息）';
  return `${head}

[system] 第 ${input.round} 轮，轮到你发言。基于以上最新讨论发表观点；若无话可说，只回复 ${SKIP_TOKEN}。`;
}

export function buildDmPrompt(dmContents: string[]): string {
  const lines = dmContents.map((c) => `[user 私信→你] ${c}`).join('\n');
  return `${lines}

[system] 以上是用户发给你的私信（仅你可见，其他参会者看不到）。请直接回复用户，回复同样仅用户可见、不会进入聊天室。`;
}
