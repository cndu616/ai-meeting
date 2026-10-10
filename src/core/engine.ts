import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  agents, meetings, participants, messages,
  type AgentRow, type MeetingRow, type MessageRow, type ParticipantRow,
} from '@/db/schema';
import type { DB } from '@/db/client';
import { emitMeetingEvent, type MeetingStatus } from '@/lib/events';
import { runAgentTurn } from './agent-runner';

export interface CreateMeetingInput {
  title: string;
  topic: string;
  workspacePath: string;
  maxRounds: number;
  participants: { agentId: string; meetingRole: string }[];
}

type Runner = typeof runAgentTurn;

export class MeetingEngine {
  constructor(
    private db: DB,
    private runner: Runner = runAgentTurn,
  ) {}

  // ---------- 查询 ----------

  getMeeting(meetingId: string): MeetingRow {
    const m = this.db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
    if (!m) throw new Error(`会议 ${meetingId} 不存在`);
    return m;
  }

  getParticipants(meetingId: string): ParticipantRow[] {
    return this.db.select().from(participants)
      .where(eq(participants.meetingId, meetingId))
      .all()
      .sort((a, b) => a.speakOrder - b.speakOrder);
  }

  getMessages(meetingId: string): MessageRow[] {
    return this.db.select().from(messages)
      .where(eq(messages.meetingId, meetingId)).all();
  }

  getParticipantByAgent(meetingId: string, agentId: string): ParticipantRow {
    const p = this.db.select().from(participants)
      .where(and(eq(participants.meetingId, meetingId), eq(participants.agentId, agentId)))
      .get();
    if (!p) throw new Error(`agent ${agentId} 不在该会议中`);
    return p;
  }

  agentMap(): Map<string, AgentRow> {
    return new Map(this.db.select().from(agents).all().map((a) => [a.id, a]));
  }

  // ---------- 消息与事件 ----------

  insertMessage(row: {
    meetingId: string;
    channel: 'chatroom' | 'dm';
    agentId?: string | null;
    kind: 'speech' | 'user' | 'system' | 'dm_user' | 'dm_agent';
    content: string;
    round?: number | null;
  }): MessageRow {
    this.db.insert(messages)
      .values({
        meetingId: row.meetingId,
        channel: row.channel,
        agentId: row.agentId ?? null,
        kind: row.kind,
        content: row.content,
        round: row.round ?? null,
        createdAt: Date.now(),
      })
      .run();
    const all = this.db.select().from(messages)
      .where(eq(messages.meetingId, row.meetingId)).all();
    return all[all.length - 1]; // 自增 id，最后一条即刚插入的
  }

  emitMessage(msg: MessageRow): void {
    emitMeetingEvent({ type: 'message', meetingId: msg.meetingId, message: msg });
  }

  setAgentStatus(
    meetingId: string,
    agentId: string,
    status: 'idle' | 'thinking' | 'tool' | 'speaking',
    detail?: string,
  ): void {
    emitMeetingEvent({ type: 'agent_status', meetingId, agentId, status, detail });
  }

  // ---------- 创建 ----------

  createMeeting(input: CreateMeetingInput): MeetingRow {
    if (!fs.existsSync(input.workspacePath) || !fs.statSync(input.workspacePath).isDirectory()) {
      throw new Error('工作区路径不存在或不是目录');
    }
    if (input.participants.length < 2 || input.participants.length > 8) {
      throw new Error('参与者数量须在 2-8 之间');
    }
    const ids = new Set(input.participants.map((p) => p.agentId));
    if (ids.size !== input.participants.length) throw new Error('参与者不能重复');

    const meetingId = randomUUID();
    this.db.insert(meetings).values({
      id: meetingId,
      title: input.title,
      topic: input.topic,
      workspacePath: input.workspacePath,
      status: 'paused',
      maxRounds: input.maxRounds,
      currentRound: 0,
      createdAt: Date.now(),
    }).run();

    input.participants.forEach((p, i) => {
      this.db.insert(participants).values({
        id: randomUUID(),
        meetingId,
        agentId: p.agentId,
        meetingRole: p.meetingRole,
        speakOrder: i,
        lastInjectedMsgId: 0,
      }).run();
    });

    const agentRows = this.agentMap();
    const roster = input.participants
      .map((p) => {
        const a = agentRows.get(p.agentId);
        return `- ${a?.name ?? p.agentId}（${a?.capability ?? ''}）：${p.meetingRole}`;
      })
      .join('\n');
    const opening = this.insertMessage({
      meetingId,
      channel: 'chatroom',
      kind: 'system',
      content: `会议「${input.title}」开始。主题：${input.topic}\n参会者：\n${roster}\n工作区：${input.workspacePath}`,
    });
    this.emitMessage(opening);
    return this.getMeeting(meetingId);
  }

  // ---------- system prompt ----------

  buildSystemPrompt(meetingId: string, agentId: string): string {
    const m = this.getMeeting(meetingId);
    const p = this.getParticipantByAgent(meetingId, agentId);
    const am = this.agentMap();
    const agent = am.get(agentId)!;
    const roster = this.getParticipants(meetingId)
      .map((pp) => {
        const a = am.get(pp.agentId)!;
        return `- ${a.name}（${a.capability}）：${pp.meetingRole}`;
      })
      .join('\n');
    return `# 你的身份
${agent.persona}

# 会议背景
会议主题：${m.topic}
工作区（你的文件工具只能在此目录内使用）：${m.workspacePath}

# 你的会议角色
${p.meetingRole}

# 参会者
${roster}

# 行为规则
- 会议按轮次进行，每轮所有参会者依次发言一次，轮到你时系统会注入其他人的最新发言
- 你可以用文件工具查阅/修改工作区代码来支撑观点；你的工具操作过程其他参会者看不到，只有你的最终发言文本会公布到聊天室
- 若其他参会者想了解你的操作细节，他们会直接问你，届时用文字描述即可
- 无话可说时只回复 [SKIP]
- 发言像真实会议发言一样简洁聚焦（通常几十到两三百字），不要输出长篇报告或标题堆砌
- 用户可能私信你（消息带 [user 私信→你] 前缀），私信与你的私聊回复仅双方可见，不会进入聊天室；私信中的指示会影响你的立场，这是允许的`;
  }
}

export type { MeetingStatus };
