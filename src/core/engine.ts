// src/core/engine.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { and, asc, desc, eq } from 'drizzle-orm';
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

/** 禁言语义（评审定稿）= 发言权冻结：
 *  入口——muted 期间聊天室消息不推送、水位线不推进（token 零消耗）；
 *  出口——muted 状态下到达的 chatroom 回合结果（飞行中回合等防御路径）拦截转系统提示；
 *  豁免——私信是一对一问答，不在"会议发言权"语义内。 */

/** 暂停态私信回合的兜底超时：防 gate 因未预见路径（如崩溃后无 result）永久挂起 */
const DM_OFFLINE_TIMEOUT_MS = 120_000;

export class MeetingEngine {
  /** meetingId -> participantId -> session */
  private sessions = new Map<string, Map<string, AgentSessionLike>>();
  /** participantId -> DM 串行链：暂停态一次性会话不可并发（会并发 resume 同一 sdkSessionId 链，转录互踩） */
  private dmChains = new Map<string, Promise<void>>();

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
      .where(eq(messages.meetingId, meetingId))
      .orderBy(asc(messages.id)).all();
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
    const t = this.db.select().from(agents).where(eq(agents.id, p.templateId)).get();
    return {
      id: p.id, templateId: p.templateId, displayName: p.displayName,
      goal: p.goal, muted: !!p.muted, speakOrder: p.speakOrder,
      capability: t?.capability ?? '', avatar: t?.avatar ?? '🤖',
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
    const [msg] = this.db.insert(messages).values({
      meetingId: row.meetingId,
      channel: row.channel,
      participantId: row.participantId ?? null,
      kind: row.kind,
      content: row.content,
      createdAt: Date.now(),
    }).returning().all();
    return msg;
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
    const am = this.agentMap();
    const t = am.get(p.templateId)!;
    // 决议 4 修复项：格式说明用真实推送格式举例，动态指认"哪行是自己"——
    // 晚入场者的历史全为带标签格式，in-context 模仿会压倒指令语义（双前缀实弹），
    // 且发言者收不到自己的广播、对瑕疵无感知。只给正例不给反例（负例有模仿引力）
    const other = this.getParticipants(meetingId).find((x) => x.id !== participantId)!;
    const otherT = am.get(other.templateId);
    const selfTag = `[chatroom ${p.displayName}·${t.capability}]`;
    const otherTag = `[chatroom ${other.displayName}·${otherT?.capability ?? ''}]`;
    return `# 你的身份
你是「${p.displayName}」，本会议中的${t.capability}。${t.persona}

# 会议背景
会议主题：${m.topic}
工作区（你的文件工具只能在此目录内使用）：${m.workspacePath}

# 你的会议目标
${p.goal}

# 参会者
${this.roster(meetingId)}

# 消息格式
推送给你的每条消息，开头都有一个系统自动加的方括号标签，标明发言者。实际格式示例：

[chatroom 用户] 大家继续讨论下一个议题
${otherTag} 我同意这个方案
${selfTag} 我补充一点……
[user 私信→你] 咱们私下交换一下看法

示例中的「${selfTag}」这一行就是你自己（${p.displayName}）——系统会给你的每条发言自动加上这个标签，再广播给其他参会者；「${otherTag}」等其他标签对应其他参会者。你平时收不到自己发言的推送，只在入会、恢复或解禁补发记录时才会看到带自己标签的行。
你发言时，正文直接从内容写起——不要在开头添加任何 [chatroom …] 样式的标签，标签由系统自动添加。

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

  /** 聊天室消息广播给所有（除发送者）在线成员；禁言者入口冻结（零推送、水位线不动，解除时补发） */
  private broadcastChatroom(msg: MessageRow, exceptParticipantId?: string): void {
    const senders = this.senderInfoMap(msg.meetingId);
    const sessions = this.sessionsOf(msg.meetingId);
    for (const p of this.getParticipants(msg.meetingId)) {
      if (p.id === exceptParticipantId) continue;
      if (p.muted) continue; // 入口冻结：不推送、不推进水位线
      const s = sessions.get(p.id);
      if (!s) continue;
      const line = chatroomLine(msg, senders);
      s.push(line);
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
    // 会议级门卫：非 active（含 paused）期间 chatroom 发言静默拦截——
    // 防 session 已关闭/摘除但飞行回合的 onResult 仍在途的时序窗口（暂停穿透修复）
    if (this.getMeeting(meetingId).status !== 'active') {
      this.setAgentStatus(meetingId, participantId, 'idle');
      return;
    }
    // 成员级门卫（防御路径）：入口冻结后正常不会有 muted 回合，此处兜飞行中回合等在途结果。
    // 系统提示不引用违规原文（原文不落库、不进任何推送）
    const p = this.getParticipant(meetingId, participantId);
    if (p.muted) {
      const blocked = this.insertMessage({
        meetingId, channel: 'chatroom', kind: 'system',
        content: `${p.displayName} 已被禁言，其发言未被送达。`,
      });
      this.emitMessage(blocked);
      // 决议 2 同根同修：拦截提示也走广播（原只 emitMessage 给 UI，agent 看不到）
      this.broadcastChatroom(blocked);
      this.setAgentStatus(meetingId, participantId, 'idle');
      return;
    }
    const msg = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'speech', participantId, content: text,
    });
    this.emitMessage(msg);
    this.setAgentStatus(meetingId, participantId, 'idle');
    this.broadcastChatroom(msg, participantId);
  }

  /** 决议 1（B+）：closed 后迟到 result 的分通道转交落库。
   *  红线：dm 迟到回复只落 dm channel（宁漏播不泄漏）；chatroom 迟到发言落系统
   *  消息并广播——paused/无会话时自然无人收，恢复靠 catchUp 增量补看 */
  private handleLateResult(
    meetingId: string,
    participantId: string,
    text: string,
    kind: 'chatroom' | 'dm',
  ): void {
    if (!text.trim() || isSkip(text)) return;
    const p = this.getParticipant(meetingId, participantId);
    if (kind === 'dm') {
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'dm', kind: 'system', participantId: p.id,
        content: `${p.displayName} 的私信回复姗姗来迟：${text.slice(0, 500)}`,
      }));
      return;
    }
    const late = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `${p.displayName} 的在途发言（迟到）：${text.slice(0, 500)}`,
    });
    this.emitMessage(late);
    this.broadcastChatroom(late, participantId);
  }

  /** 决议 1（B+）：close 时存在未销账 push → 痕迹消息。
   *  措辞不说死"丢弃"：SDK 会把进行中的 turn 跑完，迟到内容大概率经 onLateResult 跟到 */
  private handleDiscard(meetingId: string, participantId: string): void {
    const p = this.getParticipant(meetingId, participantId);
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `${p.displayName} 暂停时有一回合在途，结果稍后送达或超时作废。`,
    }));
  }

  /** 决议 1（B+）第 3 点：恢复对账——最后一条 dm 是 dm_user（无任何回应）则补推，
   *  防飞行中私信回复被暂停吞掉后用户永无回音。超时/失败/迟到类 dm system 算已回应。
   *  接受与迟到回复的一次性双发，不上跨会话去重（决议 1 第 5 点） */
  private reinjectUnansweredDm(meetingId: string, participantId: string): void {
    const s = this.sessionsOf(meetingId).get(participantId);
    if (!s) return;
    const last = this.db.select().from(messages)
      .where(and(
        eq(messages.meetingId, meetingId),
        eq(messages.channel, 'dm'),
        eq(messages.participantId, participantId),
      ))
      .orderBy(desc(messages.id))
      .limit(1)
      .get();
    if (last?.kind === 'dm_user') {
      s.push(buildDmPrompt(last.content), 'dm');
    }
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
        onLateResult: (text, kind) => this.handleLateResult(meetingId, p.id, text, kind),
        onDiscard: () => this.handleDiscard(meetingId, p.id),
        onRestart: () => this.catchUp(meetingId, p.id),
        onDead: () => {
          // 掉线即摘除会话：broadcast 自动跳过（水位线不推进，消息留待恢复时 catchUp 补发），
          // sendDm 自动落一次性回合分支，start() 可重建
          this.sessionsOf(meetingId).delete(p.id);
          this.setAgentStatus(meetingId, p.id, 'offline');
        },
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
    // 决议 4 回写时裁决（陈指出的实现不一致）：冻结含重建补发——muted 成员
    // 崩溃重建也不 catchUp，零消耗语义贯彻所有路径；水位不动，解禁时
    // setMuted 的 catchUp 补完整增量（不丢不重）。私信豁免不受影响（不走此路径）
    if (this.getParticipant(meetingId, participantId).muted) return;
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
      const launch = () => {
        this.setAgentStatus(meetingId, p.id, 'thinking');
        this.createSessionFor(meetingId, p);
        const resume = !!p.sdkSessionId;
        this.catchUp(meetingId, p.id, resume
          ? `[system] 会议「${m.title}」继续进行。`
          : `[system] 会议「${m.title}」现在开始，主题：${m.topic}。请简短表态开场。`);
        // 决议 1（B+）第 3 点：恢复对账——飞行中私信回复若被暂停吞掉，此处补推原私信
        this.reinjectUnansweredDm(meetingId, p.id);
      };
      const chain = this.dmChains.get(p.id);
      // 掉线 DM 与 start 恢复并发会抢同一条 sdkSessionId 链：等一次性会话收尾再建常驻会话
      if (chain) void chain.then(launch);
      else launch();
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

  /** 决议 5（quarantine）：服务重启后不自动复活 active 孤儿会议。
   * 旧语义（初始化即 start 复活）与 pagehide 兜底"人不在场→暂停"的哲学相反，
   * 且复活的是无人看管的 8 agent × 常驻 CLI × bypassPermissions 自主工具执行。
   * 现统一降级 paused + 落痕迹消息（重启后无 SSE 在场，落库才是用户可见的关键痕迹）；
   * 恢复走 resume 全套（sdkSessionId 召回 + 水位补发），「继续」是显式授权 */
  recoverActiveMeetings(): void {
    const active = this.db.select().from(meetings)
      .where(eq(meetings.status, 'active')).all();
    for (const m of active) {
      try {
        this.setStatus(m.id, 'paused');
        const trace = this.insertMessage({
          meetingId: m.id, channel: 'chatroom', kind: 'system',
          content: `检测到服务重启，会议已自动暂停。点「继续」召回，上下文与讨论增量将完整恢复。`,
        });
        this.emitMessage(trace);
      } catch (e) {
        console.error(`[engine] 隔离会议 ${m.id} 失败:`, e);
      }
    }
  }

  // ---------- 用户消息与私聊 ----------

  /** 决议 5（陈终局注记）：SIGTERM 排水契约的引擎侧——优雅停止 = pause 全部 active。
   *  close 后 consume 循环仍活着，排水窗口内迟到 result 经 onLateResult 落库；
   *  窗口超时强杀时 onDiscard 痕迹（已随 pause 落）与 resume 对账补推兜底。
   *  返回是否停了会议：调用方据此决定是否值得开排水窗口（空闲服务重启不该白等）。
   *  排水窗口的有界性由调用方（engine-instance 的 SIGTERM 处理）保证——
   *  maxTurns 40 的链子不能让「优雅」等成「挂起」（与否决 A 同一条理由） */
  async gracefulShutdown(): Promise<boolean> {
    const active = this.db.select().from(meetings)
      .where(eq(meetings.status, 'active')).all();
    for (const m of active) {
      try {
        await this.pause(m.id);
      } catch (e) {
        console.error(`[engine] 优雅停止会议 ${m.id} 失败:`, e);
      }
    }
    return active.length > 0;
  }

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
    if (m.status === 'active' && this.sessionsOf(meetingId).has(p.id)) {
      // 常驻会话在线：直接推私信（禁言不影响私信）。push 顺序由会话内 PushQueue
      // 天然串行，保持同步语义不走排队链
      this.emitDmUser(meetingId, p.id, content);
      const s = this.sessionsOf(meetingId).get(p.id)!;
      this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
      s.push(buildDmPrompt(content), 'dm');
      return;
    }
    // 离线分支：同成员串行排队——防两个一次性会话并发 resume 同一条 sdkSessionId 链
    const prev = this.dmChains.get(participantId) ?? Promise.resolve();
    const run = prev.then(() => this.runDmQueued(meetingId, participantId, content));
    this.dmChains.set(participantId, run.catch(() => {}));
    await run;
  }

  private emitDmUser(meetingId: string, participantId: string, content: string): void {
    this.emitMessage(this.insertMessage({
      meetingId, channel: 'dm', kind: 'dm_user', participantId, content,
    }));
  }

  /** 排队轮到时的执行体：重新读状态（排队期间会议可能已恢复、会话已重建） */
  private async runDmQueued(
    meetingId: string,
    participantId: string,
    content: string,
  ): Promise<void> {
    const m = this.getMeeting(meetingId);
    const p = this.getParticipant(meetingId, participantId);
    this.emitDmUser(meetingId, p.id, content);
    if (m.status === 'active' && this.sessionsOf(meetingId).has(p.id)) {
      const s = this.sessionsOf(meetingId).get(p.id)!;
      this.setAgentStatus(meetingId, p.id, 'thinking', '私聊中');
      s.push(buildDmPrompt(content), 'dm');
      return;
    }
    await this.runDmOffline(meetingId, p, content);
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
    let settled = false;
    let timedOut = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
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
          if (settled) {
            // 超时后的迟到回复：用户已被告知超时，正文不静默吞（DM 有等待方），
            // 转系统消息呈现并关闭会话
            if (text.trim() && !isSkip(text)) {
              this.emitMessage(this.insertMessage({
                meetingId, channel: 'dm', kind: 'system', participantId: p.id,
                content: `${p.displayName} 的私信回复姗姗来迟：${text.slice(0, 500)}`,
              }));
            }
            void session.close().catch(() => {});
            return;
          }
          this.handleAgentResult(meetingId, p.id, text, 'dm');
          finish();
        },
        // 决议 1（B+）一次性会话的接线：close 后的迟到 result 与常驻会话同款转交
        //（dm 通道，红线不广播）；onDiscard 不落痕迹——离线回合已有超时/失败系统
        // 消息兜底，再落 chatroom 痕迹反而把私聊存在感广播出去
        onLateResult: (text) => this.handleLateResult(meetingId, p.id, text, 'dm'),
        onDiscard: () => {},
        onRestart: () => {
          // 崩溃重建后原私信可能未进转录：重发一次（新队列已就绪，push 安全）
          session.push(buildDmPrompt(content), 'dm');
        },
        onDead: () => {
          if (settled) {
            // 超时后会话已收尾说明：流结束仅作清理信号，不再落失败消息
            void session.close().catch(() => {});
            return;
          }
          this.emitMessage(this.insertMessage({
            meetingId, channel: 'dm', kind: 'system', participantId: p.id,
            content: `${p.displayName} 私信回复失败。`,
          }));
          finish();
        },
      },
    });
    session.start();
    session.push(buildDmPrompt(content), 'dm');
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      this.emitMessage(this.insertMessage({
        meetingId, channel: 'dm', kind: 'system', participantId: p.id,
        content: `${p.displayName} 私信回复超时。`,
      }));
      finish();
    }, DM_OFFLINE_TIMEOUT_MS);
    await gate.then(() => clearTimeout(timeout));
    // 超时不立即关会话：SDK 的 turn 可能仍在跑，迟到回复需能通行（由 onResult/onDead 收尾关闭）
    if (!timedOut) await session.close();
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
      // 决议 3：join 消息广播给在线老成员（显式 except 新人——新人靠下方 catchUp
      // 拿全量历史，含 join 行，不重复实时推送）。互补不是替代：入会自我介绍指令保留
      this.broadcastChatroom(join, row.id);
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
    // 决议 2：mute/unmute 落库 + 广播——system 事件不进推送流，在场者无从知悉成员
    // 状态变化（实弹：禁言被误读为沉默）。禁言者本人被入口冻结自动跳过（水位不动，
    // 解禁时 catchUp 补看）；解禁者显式 except——本人水位不因广播推进，catchUp 增量
    // 得以按时间序覆盖"被禁言 → 冻结期间讨论 → 解除禁言"完整轨迹，不乱序不重复
    const notice = this.insertMessage({
      meetingId, channel: 'chatroom', kind: 'system',
      content: `${p.displayName} ${muted ? '已被禁言' : '已被解除禁言'}。`,
    });
    this.emitMessage(notice);
    this.broadcastChatroom(notice, muted ? undefined : participantId);
    // 解除禁言：补发冻结期间增量。指令必须显式说明此前被禁言——
    // 不给这句，agent 补完课容易一口气发长篇，等于解除禁言当场广播风暴
    if (!muted
      && this.getMeeting(meetingId).status === 'active'
      && this.sessionsOf(meetingId).has(participantId)) {
      this.catchUp(meetingId, participantId,
        '[system] 你此前被主持人禁言，以下是禁言期间的讨论增量，请简短回应后继续参与讨论。');
    }
    return updated;
  }
}

export type { MeetingStatus };
