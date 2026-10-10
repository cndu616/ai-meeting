// src/core/engine.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  agents, meetings, participants, messages,
  type AgentRow, type MeetingRow, type MessageRow, type ParticipantRow,
} from '@/db/schema';
import type { DB } from '@/db/client';
import { emitMeetingEvent, type MeetingStatus, type ParticipantInfo } from '@/lib/events';
import type { AgentSessionLike, SessionFactory } from './session-factory';
import { defaultSessionFactory } from './session-factory';
import {
  collectChatroomIncrement, chatroomLine, buildKickoffPrompt, buildDmPrompt, isSkip,
  type SenderInfo,
} from './injector';

export interface CreateMeetingInput {
  title: string;
  topic: string;
  workspacePath: string;
  participants: { templateId: string; displayName: string; goal: string }[];
}

/** 禁言者的注入行附加提示：消息照常推送以保持上下文，但明确要求只回 [SKIP] */
const MUTE_SUFFIX =
  '\n（你现在被主持人禁言，请勿发言，直接回复 [SKIP]，并记住该消息作为上下文。）';

export class MeetingEngine {
  /** meetingId -> participantId -> session */
  private sessions = new Map<string, Map<string, AgentSessionLike>>();

  constructor(
    private db: DB,
    private sessionFactory: SessionFactory = defaultSessionFactory,
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

  getParticipant(meetingId: string, participantId: string): ParticipantRow {
    const p = this.db.select().from(participants)
      .where(and(eq(participants.meetingId, meetingId), eq(participants.id, participantId)))
      .get();
    if (!p) throw new Error(`参会者 ${participantId} 不在该会议中`);
    return p;
  }

  agentMap(): Map<string, AgentRow> {
    return new Map(this.db.select().from(agents).all().map((a) => [a.id, a]));
  }

  participantInfo(p: ParticipantRow): ParticipantInfo {
    return {
      id: p.id, templateId: p.templateId, displayName: p.displayName,
      goal: p.goal, muted: !!p.muted, speakOrder: p.speakOrder,
    };
  }

  // ---------- 消息与事件 ----------

  insertMessage(row: {
    meetingId: string;
    channel: 'chatroom' | 'dm';
    participantId?: string | null;
    kind: 'speech' | 'user' | 'system' | 'dm_user' | 'dm_agent';
    content: string;
  }): MessageRow {
    this.db.insert(messages).values({
      meetingId: row.meetingId,
      channel: row.channel,
      participantId: row.participantId ?? null,
      kind: row.kind,
      content: row.content,
      createdAt: Date.now(),
    }).run();
    const all = this.db.select().from(messages)
      .where(eq(messages.meetingId, row.meetingId)).all();
    return all[all.length - 1]; // 自增 id，最后一条即刚插入的
  }

  emitMessage(msg: MessageRow): void {
    emitMeetingEvent({ type: 'message', meetingId: msg.meetingId, message: msg });
  }

  setAgentStatus(
    meetingId: string,
    participantId: string,
    status: 'idle' | 'thinking' | 'tool' | 'speaking' | 'offline',
    detail?: string,
  ): void {
    emitMeetingEvent({ type: 'agent_status', meetingId, participantId, status, detail });
  }

  // ---------- 创建 ----------

  createMeeting(input: CreateMeetingInput): MeetingRow {
    if (!fs.existsSync(input.workspacePath) || !fs.statSync(input.workspacePath).isDirectory()) {
      throw new Error('工作区路径不存在或不是目录');
    }
    if (input.participants.length < 2 || input.participants.length > 8) {
      throw new Error('参与者数量须在 2-8 之间');
    }
    for (const p of input.participants) {
      if (!p.displayName?.trim() || !p.goal?.trim()) {
        throw new Error('每个参与者的名字与目标不能为空');
      }
    }
    const am = this.agentMap();
    for (const p of input.participants) {
      if (!am.has(p.templateId)) throw new Error(`模板 ${p.templateId} 不存在`);
    }

    const meetingId = randomUUID();
    this.db.insert(meetings).values({
      id: meetingId,
      title: input.title,
      topic: input.topic,
      workspacePath: input.workspacePath,
      status: 'paused',
      createdAt: Date.now(),
    }).run();

    input.participants.forEach((p, i) => {
      this.db.insert(participants).values({
        id: randomUUID(),
        meetingId,
        templateId: p.templateId,
        displayName: p.displayName.trim(),
        goal: p.goal.trim(),
        muted: 0,
        speakOrder: i,
        lastInjectedMsgId: 0,
      }).run();
    });

    const opening = this.insertMessage({
      meetingId,
      channel: 'chatroom',
      kind: 'system',
      content: `会议「${input.title}」已创建。主题：${input.topic}\n参会者：\n${this.roster(meetingId)}\n工作区：${input.workspacePath}`,
    });
    this.emitMessage(opening);
    return this.getMeeting(meetingId);
  }

  /** 花名册文本（指令与 system prompt 共用） */
  private roster(meetingId: string): string {
    const am = this.agentMap();
    return this.getParticipants(meetingId)
      .map((p) => {
        const t = am.get(p.templateId);
        return `- ${p.displayName}（${t?.capability ?? ''}）：${p.goal}`;
      })
      .join('\n');
  }

  // ---------- system prompt ----------

  buildSystemPrompt(meetingId: string, participantId: string): string {
    const m = this.getMeeting(meetingId);
    const p = this.getParticipant(meetingId, participantId);
    const t = this.agentMap().get(p.templateId)!;
    return `# 你的身份
你是「${p.displayName}」，本会议中的${t.capability}。${t.persona}

# 会议背景
会议主题：${m.topic}
工作区（你的文件工具只能在此目录内使用）：${m.workspacePath}

# 你的会议目标
${p.goal}

# 参会者
${this.roster(meetingId)}

# 行为规则
- 会议以自由讨论方式进行：聊天室的新消息会实时推送给你，你自主判断是否发言
- 有值得说的就简短发言；没有则只回复 [SKIP]，不要无话找话
- 发言像真实会议发言一样简洁聚焦（通常几十到两三百字），有观点、不重复别人说过的
- 你可以用文件工具查阅/修改工作区代码来支撑观点；你的工具操作过程其他参会者看不到，只有你的最终发言文本会公布到聊天室
- 用户可能私信你（消息带 [user 私信→你] 前缀），私信与你的私聊回复仅双方可见，不会进入聊天室；私信中的指示会影响你的立场，这是允许的`;
  }

  // ---------- 分发 ----------

  private senderInfoMap(meetingId: string): Map<string, SenderInfo> {
    const am = this.agentMap();
    return new Map(
      this.getParticipants(meetingId).map((p) => {
        const t = am.get(p.templateId);
        return [p.id, { name: p.displayName, capability: t?.capability ?? '' }] as const;
      }),
    );
  }

  private sessionsOf(meetingId: string): Map<string, AgentSessionLike> {
    let s = this.sessions.get(meetingId);
    if (!s) {
      s = new Map();
      this.sessions.set(meetingId, s);
    }
    return s;
  }

  /** 聊天室消息广播给所有（除发送者）在线成员；禁言者附加提示 */
  private broadcastChatroom(msg: MessageRow, exceptParticipantId?: string): void {
    const senders = this.senderInfoMap(msg.meetingId);
    const sessions = this.sessionsOf(msg.meetingId);
    for (const p of this.getParticipants(msg.meetingId)) {
      if (p.id === exceptParticipantId) continue;
      const s = sessions.get(p.id);
      if (!s) continue;
      const line = chatroomLine(msg, senders);
      s.push(p.muted ? line + MUTE_SUFFIX : line);
      this.db.update(participants)
        .set({ lastInjectedMsgId: msg.id })
        .where(eq(participants.id, p.id)).run();
    }
  }

  /** agent 一轮结束：按 kind 分流（speech 落库并广播 / dm 落库仅送达用户 / skip 吞掉） */
  private handleAgentResult(
    meetingId: string,
    participantId: string,
    text: string,
    kind: 'chatroom' | 'dm',
  ): void {
    if (kind === 'dm') {
      const p = this.getParticipant(meetingId, participantId);
      if (text.trim() && !isSkip(text)) {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'dm_agent', participantId: p.id, content: text,
        }));
      } else {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'system', participantId: p.id,
          content: `${p.displayName} 未能回复私信。`,
        }));
      }
      this.setAgentStatus(meetingId, participantId, 'idle');
      return;
    }
    if (!text.trim() || isSkip(text)) {
      this.setAgentStatus(meetingId, participantId, 'idle');
      return; // [SKIP]：不落库、不分发
    }
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'speech', participantId, content: text,
    });
    this.emitMessage(msg);
    this.setAgentStatus(meetingId, participantId, 'idle');
    this.broadcastChatroom(msg, participantId);
  }

  /** 创建常驻会话并接线回调 */
  private createSessionFor(meetingId: string, p: ParticipantRow): AgentSessionLike {
    const m = this.getMeeting(meetingId);
    const session = this.sessionFactory.create({
      systemPrompt: this.buildSystemPrompt(meetingId, p.id),
      cwd: m.workspacePath,
      resumeSessionId: p.sdkSessionId ?? undefined,
      callbacks: {
        onSessionId: (sid) => {
          this.db.update(participants)
            .set({ sdkSessionId: sid })
            .where(eq(participants.id, p.id)).run();
        },
        onTool: (tool, detail) =>
          this.setAgentStatus(meetingId, p.id, 'tool', `${tool} ${detail}`.trim()),
        onResult: (text, kind) => this.handleAgentResult(meetingId, p.id, text, kind),
        onRestart: () => this.catchUp(meetingId, p.id),
        onDead: () => this.setAgentStatus(meetingId, p.id, 'offline'),
      },
    });
    session.start();
    this.sessionsOf(meetingId).set(p.id, session);
    return session;
  }

  /** 向某成员推送指令 + 其水位线之后的全部增量（开场/恢复/入会/崩溃重建共用） */
  private catchUp(meetingId: string, participantId: string, directive?: string): void {
    const sessions = this.sessionsOf(meetingId);
    const s = sessions.get(participantId);
    if (!s) return;
    const increment = collectChatroomIncrement(this.db, meetingId, participantId);
    const text = buildKickoffPrompt({
      directive:
        directive ??
        '[system] 以下是会议的最新讨论记录，请关注后续推送并在有话可说时发言。',
      history: increment,
      senders: this.senderInfoMap(meetingId),
    });
    s.push(text);
    if (increment.length) {
      this.db.update(participants)
        .set({ lastInjectedMsgId: increment[increment.length - 1].id })
        .where(eq(participants.id, participantId)).run();
    }
  }

  // ---------- 运行控制 ----------

  isRunning(meetingId: string): boolean {
    return (this.sessions.get(meetingId)?.size ?? 0) > 0;
  }

  start(meetingId: string): void {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法开始');
    this.setStatus(meetingId, 'active');
    for (const p of this.getParticipants(meetingId)) {
      if (this.sessionsOf(meetingId).has(p.id)) continue;
      this.setAgentStatus(meetingId, p.id, 'thinking');
      this.createSessionFor(meetingId, p);
      const resume = !!p.sdkSessionId;
      this.catchUp(meetingId, p.id, resume
        ? `[system] 会议「${m.title}」继续进行。`
        : `[system] 会议「${m.title}」现在开始，主题：${m.topic}。请简短表态开场。`);
    }
  }

  private setStatus(meetingId: string, status: MeetingStatus): void {
    this.db.update(meetings)
      .set({ status, ...(status === 'ended' ? { endedAt: Date.now() } : {}) })
      .where(eq(meetings.id, meetingId)).run();
    emitMeetingEvent({ type: 'meeting_status', meetingId, status });
  }

  private async closeSessions(meetingId: string): Promise<void> {
    const sessions = this.sessions.get(meetingId);
    if (!sessions) return;
    this.sessions.delete(meetingId);
    await Promise.allSettled([...sessions.values()].map((s) => s.close()));
    for (const p of this.getParticipants(meetingId)) {
      this.setAgentStatus(meetingId, p.id, 'idle');
    }
  }

  async pause(meetingId: string): Promise<void> {
    if (this.getMeeting(meetingId).status === 'active') this.setStatus(meetingId, 'paused');
    await this.closeSessions(meetingId);
  }

  async resume(meetingId: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法继续');
    this.start(meetingId);
  }

  async end(meetingId: string): Promise<void> {
    await this.closeSessions(meetingId);
    this.setStatus(meetingId, 'ended');
    const m = this.getMeeting(meetingId);
    const closing = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `会议「${m.title}」已结束。`,
    });
    this.emitMessage(closing);
  }

  /** 服务器重启后恢复所有 active 会议（与 resume 同路径） */
  recoverActiveMeetings(): void {
    const active = this.db.select().from(meetings)
      .where(eq(meetings.status, 'active')).all();
    for (const m of active) {
      try {
        this.start(m.id);
      } catch (e) {
        console.error(`[engine] 恢复会议 ${m.id} 失败:`, e);
      }
    }
  }

  // ---------- 用户消息与私聊 ----------

  sendUserMessage(meetingId: string, content: string): MessageRow {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法发言');
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'user', content,
    });
    this.emitMessage(msg);
    if (m.status === 'active') this.broadcastChatroom(msg);
    return msg;
  }

  async sendDm(meetingId: string, participantId: string, content: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法私聊');
    const p = this.getParticipant(meetingId, participantId);
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'dm', kind: 'dm_user', participantId: p.id, content,
    }));
    if (m.status === 'active' && this.sessionsOf(meetingId).has(p.id)) {
      // 常驻会话在线：直接推私信（禁言不影响私信）
      const s = this.sessionsOf(meetingId).get(p.id)!;
      this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
      s.push(buildDmPrompt(content), 'dm');
    } else {
      // 暂停中：一次性会话回合（resume 原会话链，结束即关）
      await this.runDmOffline(meetingId, p, content);
    }
  }

  /** 暂停状态下的一次性私聊回合 */
  private async runDmOffline(
    meetingId: string,
    p: ParticipantRow,
    content: string,
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    let done!: () => void;
    const gate = new Promise<void>((r) => (done = r));
    this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
    const session = this.sessionFactory.create({
      systemPrompt: this.buildSystemPrompt(meetingId, p.id),
      cwd: m.workspacePath,
      resumeSessionId: p.sdkSessionId ?? undefined,
      callbacks: {
        onSessionId: (sid) => {
          this.db.update(participants)
            .set({ sdkSessionId: sid })
            .where(eq(participants.id, p.id)).run();
        },
        onTool: (tool, detail) =>
          this.setAgentStatus(meetingId, p.id, 'tool', `${tool} ${detail}`.trim()),
        onResult: (text) => {
          this.handleAgentResult(meetingId, p.id, text, 'dm');
          done();
        },
        onRestart: () => {},
        onDead: () => {
          this.emitMessage(this.insertMessage({
            meetingId, channel: 'dm', kind: 'system', participantId: p.id,
            content: `${p.displayName} 私信回复失败。`,
          }));
          done();
        },
      },
    });
    session.start();
    session.push(buildDmPrompt(content), 'dm');
    await gate;
    await session.close();
    this.setAgentStatus(meetingId, p.id, 'idle');
  }

  // ---------- 动态成员管理 ----------

  addParticipant(
    meetingId: string,
    input: { templateId: string; displayName: string; goal: string },
  ): ParticipantRow {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法添加成员');
    const existing = this.getParticipants(meetingId);
    if (existing.length >= 8) throw new Error('参会者已达上限 8');
    if (!input.displayName?.trim() || !input.goal?.trim()) {
      throw new Error('名字与目标不能为空');
    }
    if (!this.agentMap().has(input.templateId)) throw new Error(`模板 ${input.templateId} 不存在`);

    const row: ParticipantRow = {
      id: randomUUID(),
      meetingId,
      templateId: input.templateId,
      displayName: input.displayName.trim(),
      goal: input.goal.trim(),
      muted: 0,
      sdkSessionId: null,
      speakOrder: existing.length,
      lastInjectedMsgId: 0,
    };
    this.db.insert(participants).values(row).run();

    const join = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `${row.displayName} 加入会议。`,
    });
    this.emitMessage(join);
    emitMeetingEvent({ type: 'participant', meetingId, participant: this.participantInfo(row) });

    if (m.status === 'active') {
      this.setAgentStatus(meetingId, row.id, 'thinking');
      this.createSessionFor(meetingId, row);
      this.catchUp(meetingId, row.id,
        `[system] 你中途加入会议「${m.title}」（主题：${m.topic}）。你是「${row.displayName}」，你的会议目标：${row.goal}。以下是会议到目前为止的全部记录，请先简短自我介绍并给出初步观点。`);
    }
    return row;
  }

  setMuted(meetingId: string, participantId: string, muted: boolean): ParticipantRow {
    const p = this.getParticipant(meetingId, participantId);
    this.db.update(participants)
      .set({ muted: muted ? 1 : 0 })
      .where(eq(participants.id, p.id)).run();
    const updated = this.getParticipant(meetingId, participantId);
    emitMeetingEvent({ type: 'participant', meetingId, participant: this.participantInfo(updated) });
    return updated;
  }
}

export type { MeetingStatus };
