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
import { collectChatroomIncrement, buildSpeechPrompt, buildDmPrompt, isSkip } from './injector';

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

  // ---------- 运行控制 ----------

  private loops = new Map<string, { pause: boolean; promise: Promise<void> }>();

  isRunning(meetingId: string): boolean {
    return this.loops.has(meetingId);
  }

  /** 启动（或重启）轮次循环，返回循环结束的 promise */
  start(meetingId: string): Promise<void> {
    if (this.getMeeting(meetingId).status === 'ended') {
      throw new Error('会议已结束，无法开始');
    }
    this.setStatus(meetingId, 'active');
    if (this.loops.has(meetingId)) return this.loops.get(meetingId)!.promise;
    // 注意：runLoop 与 loops 必须持有同一个 ctl 引用，pause() 才能生效
    const ctl: { pause: boolean; promise: Promise<void> } = {
      pause: false,
      promise: Promise.resolve(),
    };
    ctl.promise = this.runLoop(meetingId, ctl)
      .catch((e) => console.error(`[engine] 会议 ${meetingId} 循环异常:`, e))
      .finally(() => this.loops.delete(meetingId));
    this.loops.set(meetingId, ctl);
    return ctl.promise;
  }

  private setStatus(meetingId: string, status: MeetingStatus): void {
    this.db.update(meetings)
      .set({ status, ...(status === 'ended' ? { endedAt: Date.now() } : {}) })
      .where(eq(meetings.id, meetingId)).run();
    emitMeetingEvent({ type: 'meeting_status', meetingId, status });
  }

  private shouldStop(meetingId: string, ctl: { pause: boolean }): boolean {
    return ctl.pause || this.getMeeting(meetingId).status !== 'active';
  }

  private async runLoop(meetingId: string, ctl: { pause: boolean }): Promise<void> {
    while (!this.shouldStop(meetingId, ctl)) {
      const m = this.getMeeting(meetingId);
      if (m.currentRound >= m.maxRounds) {
        const exhausted = this.insertMessage({
          meetingId, channel: 'chatroom', kind: 'system',
          content: `已达到最大轮数（${m.maxRounds}），会议暂停。可追加轮数后继续。`,
        });
        this.emitMessage(exhausted);
        this.setStatus(meetingId, 'paused');
        return;
      }
      const round = m.currentRound + 1;
      this.db.update(meetings)
        .set({ currentRound: round }).where(eq(meetings.id, meetingId)).run();
      emitMeetingEvent({ type: 'round', meetingId, round, phase: 'start' });

      for (const p of this.getParticipants(meetingId)) {
        if (this.shouldStop(meetingId, ctl)) return;
        await this.processPendingDms(meetingId, p);
        if (this.shouldStop(meetingId, ctl)) return;
        await this.runSpeechTurn(meetingId, p, round);
      }
      emitMeetingEvent({ type: 'round', meetingId, round, phase: 'end' });
    }
  }

  /** 单个 agent 的会议发言回合 */
  private async runSpeechTurn(
    meetingId: string,
    p: ParticipantRow,
    round: number,
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    const agent = this.agentMap().get(p.agentId)!;
    this.setAgentStatus(meetingId, p.agentId, 'thinking');

    const increment = collectChatroomIncrement(this.db, meetingId, p.id);
    const senderMap = new Map(
      [...this.agentMap().entries()].map(([id, a]) =>
        [id, { name: a.name, capability: a.capability }] as const,
      ),
    );
    const prompt = buildSpeechPrompt({ increment, agentsById: senderMap, round });
    const systemPrompt = this.buildSystemPrompt(meetingId, p.agentId);

    let result: Awaited<ReturnType<Runner>> | undefined;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const r = await this.runner({
          systemPrompt, workspacePath: m.workspacePath, prompt,
          resumeSessionId: p.sdkSessionId ?? undefined,
        });
        if (r.speech) result = r;
        else break; // 无文本视为失败，不再重试空结果
      } catch {
        result = undefined; // 重试一次
      }
    }

    if (!result) {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'system',
        content: `${agent.name} 本轮发言失败，已跳过。`,
      }));
      this.setAgentStatus(meetingId, p.agentId, 'idle');
      return;
    }

    // 更新会话 id（召回依据）
    this.db.update(participants)
      .set({ sdkSessionId: result.sessionId })
      .where(eq(participants.id, p.id)).run();

    // 工具活动仅作为状态事件（不进聊天室）
    for (const t of result.toolActivities) {
      this.setAgentStatus(meetingId, p.agentId, 'tool', `${t.tool} ${t.detail}`.trim());
    }

    const watermarkBase = increment.length
      ? increment[increment.length - 1].id
      : p.lastInjectedMsgId;
    if (isSkip(result.speech)) {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'system', round,
        content: `${agent.name} 跳过本轮发言。`,
      }));
      this.db.update(participants)
        .set({ lastInjectedMsgId: watermarkBase })
        .where(eq(participants.id, p.id)).run();
    } else {
      this.setAgentStatus(meetingId, p.agentId, 'speaking');
      const msg = this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'speech',
        agentId: p.agentId, content: result.speech, round,
      });
      this.emitMessage(msg);
      this.db.update(participants)
        .set({ lastInjectedMsgId: Math.max(watermarkBase, msg.id) })
        .where(eq(participants.id, p.id)).run();
    }
    this.setAgentStatus(meetingId, p.agentId, 'idle');
  }

  /** 轮到某 agent 发言前，先处理其排队私信 */
  private async processPendingDms(meetingId: string, p: ParticipantRow): Promise<void> {
    const q = this.pendingDms.get(p.id);
    if (!q?.length) return;
    this.pendingDms.set(p.id, []);
    await this.runDmTurn(meetingId, p, q);
  }

  private async runDmTurn(
    meetingId: string,
    p: ParticipantRow,
    dmContents: string[],
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    const agent = this.agentMap().get(p.agentId)!;
    this.setAgentStatus(meetingId, p.agentId, 'thinking', '私聊中');
    const prompt = buildDmPrompt(dmContents);
    const systemPrompt = this.buildSystemPrompt(meetingId, p.agentId);
    try {
      const r = await this.runner({
        systemPrompt, workspacePath: m.workspacePath, prompt,
        resumeSessionId: p.sdkSessionId ?? undefined,
      });
      if (r.sessionId) {
        this.db.update(participants)
          .set({ sdkSessionId: r.sessionId })
          .where(eq(participants.id, p.id)).run();
      }
      if (r.speech) {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'dm_agent', agentId: p.agentId,
          content: r.speech,
        }));
      } else {
        this.emitMessage(this.insertMessage({
          meetingId, channel: 'dm', kind: 'system', agentId: p.agentId,
          content: `${agent.name} 未能回复私信。`,
        }));
      }
    } catch {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'dm', kind: 'system', agentId: p.agentId,
        content: `${agent.name} 私信回复失败。`,
      }));
    }
    this.setAgentStatus(meetingId, p.agentId, 'idle');
  }

  // ---------- 用户消息 ----------

  sendUserMessage(meetingId: string, content: string): MessageRow {
    if (this.getMeeting(meetingId).status === 'ended') {
      throw new Error('会议已结束，无法发言');
    }
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'user', content,
    });
    this.emitMessage(msg);
    return msg;
  }

  // ---------- 私聊 ----------

  private pendingDms = new Map<string, string[]>(); // participantId -> 私信内容

  async sendDm(meetingId: string, agentId: string, content: string): Promise<void> {
    const m = this.getMeeting(meetingId);
    if (m.status === 'ended') throw new Error('会议已结束，无法私聊');
    const p = this.getParticipantByAgent(meetingId, agentId);
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'dm', kind: 'dm_user', agentId, content,
    }));
    if (m.status === 'active' && this.isRunning(meetingId)) {
      const q = this.pendingDms.get(p.id) ?? [];
      q.push(content);
      this.pendingDms.set(p.id, q);
    } else {
      // 暂停中（或循环已死）即时私聊回合
      await this.runDmTurn(meetingId, p, [content]);
    }
  }

  // ---------- 会议控制（end 的最小实现，其余在后续任务） ----------

  end(meetingId: string): void {
    const loop = this.loops.get(meetingId);
    if (loop) loop.pause = true;
    this.setStatus(meetingId, 'ended');
  }
}

export type { MeetingStatus };
