// src/core/agent-session.ts
import { randomUUID } from 'node:crypto';
import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type PushKind = 'chatroom' | 'dm';

/** 单条 query 允许的最大 agent 轮数（透传 SDK maxTurns；超限时 SDK 产出 error_max_turns result） */
const MAX_TURNS = 40;

export interface AgentSessionCallbacks {
  onSessionId(sessionId: string): void;
  onTool(tool: string, detail: string): void;
  /**
   * 一轮结束的最终文本；kind 按 SDK 回显的 user_message_uuid 绑定到触发这轮的 push。
   * 合并 turn（一次 result 对应多条 push）归并规则：含任一 dm 则 'dm'（宁漏播不泄漏）。
   */
  onResult(text: string, kind: PushKind): void;
  /** 崩溃后自动重建完成、新会话已就绪（引擎此时可立即补发增量） */
  onRestart(): void;
  /** 重建也失败，该成员掉线 */
  onDead(): void;
}

export type QueryFactory = (input: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    systemPrompt: string;
    cwd: string;
    permissionMode: 'bypassPermissions';
    resume?: string;
    maxTurns: number;
  };
}) => AsyncIterable<SDKMessage>;

/** SDK 消费引擎传来的流式输入 */
class PushQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buf.push(msg);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<SDKUserMessage>> {
    const v = this.buf.shift();
    if (v) return Promise.resolve({ value: v, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * 取出并清空尚未被消费端读走的缓冲消息（崩溃重建时用于把未读消息迁移到新队列）。
   * 有 waiter 挂起时 buf 必为空（push 直接喂 waiter），已被 waiter 拿走的消息视作
   * 已消费、不属于「未读」——因此直接返回 buf 即可。
   */
  drainUnconsumed(): SDKUserMessage[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }
}

function describeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const v =
    input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query;
  return v === undefined ? '' : String(v);
}

export interface AgentSessionOptions {
  systemPrompt: string;
  cwd: string;
  resumeSessionId?: string;
  queryFactory: QueryFactory;
  callbacks: AgentSessionCallbacks;
}

export class AgentSession {
  private queue = new PushQueue();
  private sessionId: string | undefined;
  private closed = false;
  private restarted = false;
  /** 已推送但未收到对应 result 的 prompt：uuid → 通道标记（Map 保持插入序，供回退按序消费） */
  private pendingSends = new Map<string, PushKind>();
  /**
   * 私信销账簿：uuid → dm 文本（pendingSends 的 dm 子集）。
   * 崩溃重建时，已被 CLI 读走但未出 result 的私信无法从未读缓冲恢复，
   * 只能凭这本簿子重发——否则重建后 catchUp 增量触发的回复会走聊天室通道，
   * 私信内容可能泄漏进聊天室（宁漏播不泄漏的对称保障）。
   */
  private pendingDms = new Map<string, string>();

  constructor(private readonly opts: AgentSessionOptions) {}

  start(): void {
    if (this.closed) return;
    this.queue = new PushQueue();
    const iter = this.opts.queryFactory({
      prompt: this.queue,
      options: {
        systemPrompt: this.opts.systemPrompt,
        cwd: this.opts.cwd,
        permissionMode: 'bypassPermissions',
        resume: this.sessionId ?? this.opts.resumeSessionId,
        maxTurns: MAX_TURNS,
      },
    });
    void this.consume(iter);
  }

  push(text: string, kind: PushKind = 'chatroom'): void {
    if (this.closed) return; // 与队列丢弃语义一致，避免留下永远无法销账的绑定
    // 客户端自造 uuid：SDK 会在对应 turn 的 result 上回显 user_message_uuid(s)，
    // 据此把回复精确绑定回这次 push（合并 turn / error turn 下顺序推断会错位）
    const uuid = randomUUID();
    this.pendingSends.set(uuid, kind);
    if (kind === 'dm') this.pendingDms.set(uuid, text); // 私信另记文本，供崩溃重建时重发
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid,
    });
  }

  /**
   * 请求关闭：关闭输入队列，SDK 会把进行中的 turn 跑完才退出；
   * 本方法不等待该过程，立即 resolve。
   */
  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }

  private async consume(iter: AsyncIterable<SDKMessage>): Promise<void> {
    try {
      for await (const msg of iter) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          // 新流成功建立即重置容错：连续失败（重建的流没等到 init 又死了）才放弃
          this.restarted = false;
          this.sessionId = msg.session_id;
          this.opts.callbacks.onSessionId(msg.session_id);
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              this.opts.callbacks.onTool(
                block.name,
                describeToolInput(block.input as Record<string, unknown>),
              );
            }
          }
        } else if (msg.type === 'result') {
          // 任意 subtype 的 result 都视为 turn 完成信号并出队（SDK 每 turn 恰好产出一条
          // result，不分 subtype；只认 success 会让 error turn 消费了 push 却不出队，
          // 后续回复全部错位）
          if (msg.session_id) {
            this.sessionId = msg.session_id;
            this.opts.callbacks.onSessionId(msg.session_id);
          }
          const kind = this.resolveResultKind(msg);
          const text = msg.subtype === 'success' ? (msg.result ?? '') : '';
          this.opts.callbacks.onResult(text, kind);
        }
      }
      this.handleEnd();
    } catch (err) {
      console.error('[AgentSession] 输出流消费异常', err);
      this.handleEnd();
    }
  }

  private handleEnd(): void {
    if (this.closed) return;
    if (this.restarted) {
      try {
        this.opts.callbacks.onDead();
      } catch (err) {
        // 回调抛错只记录、不逃逸（与 onRestart 同款防护，避免 unhandled rejection）
        console.error('[AgentSession] onDead 回调执行异常', err);
      }
      return;
    }
    this.restarted = true;

    // 崩溃窗口消息保全。push 只是把消息放进旧队列缓冲，CLI 读走之前存在窗口，此时崩溃
    // start() 会丢弃旧队列——未读消息必须迁移重放，否则静默丢失；而已被读走但未出
    // result 的私信也必须凭销账簿重发，否则重建后回复走聊天室通道（隐私泄漏级事故）。
    const unconsumed = this.queue.drainUnconsumed();
    const replay: { text: string; kind: PushKind }[] = [];
    const replayedDmTexts = new Set<string>();
    const unconsumedUuids = new Set<string>();
    for (const m of unconsumed) {
      if (m.uuid) unconsumedUuids.add(m.uuid);
      const kind = m.uuid ? this.pendingSends.get(m.uuid) : undefined;
      if (!kind) {
        // 理论不该发生（push 总是先登记绑定再入队）；丢弃并记录，不放行无绑定消息
        console.error('[AgentSession] 崩溃重放：未读消息缺少 uuid 绑定，已丢弃', m.uuid);
        continue;
      }
      const text = String(m.message.content);
      replay.push({ text, kind });
      if (kind === 'dm') replayedDmTexts.add(text);
    }
    // 已读走（不在未读缓冲里）但未销账的私信：追加重发，让后续回复继续绑定 dm 通道
    for (const [uuid, text] of this.pendingDms) {
      if (unconsumedUuids.has(uuid)) continue; // 未读路径已在上面迁移，避免双份
      if (replayedDmTexts.has(text)) continue; // 同文本兜底去重
      replay.push({ text, kind: 'dm' });
      replayedDmTexts.add(text);
    }

    // 清空 uuid 绑定：崩溃瞬间 CLI 可能已消费 prompt 未出 result，残留绑定会让
    // 重建后第一条公开回复被误判为 dm（隐私泄漏级 bug）
    this.pendingSends.clear();
    this.pendingDms.clear();
    // 先重建（换新队列）再重放/回调：重放消息与 onRestart 里引擎补发的增量
    // 都必须落进新队列，而不是已无人消费的旧队列
    this.start();
    // 按原顺序重放：重新走 push 生成新 uuid、重新绑定通道。绝不能拿旧 uuid 原样入队——
    // 旧 uuid 已随绑定表清空，result 回显旧 uuid 会走插入序回退判成 chatroom，
    // dm 回复就泄漏了
    for (const item of replay) this.push(item.text, item.kind);
    try {
      this.opts.callbacks.onRestart();
    } catch (err) {
      // 回调抛错只记录、不逃逸（此刻 start() 已完成，重建不受影响）
      console.error('[AgentSession] onRestart 回调执行异常', err);
    }
  }

  /**
   * 把 result 绑定回触发它的 push，返回通道标记：
   * 1. 优先按 SDK 回显的 user_message_uuids 逐个销账（合并 turn 会列出其消费的全部
   *    prompt uuid），归并规则：含任一 dm 则 'dm'（宁漏播不泄漏——混合通道的合并回复
   *    只走私聊，最坏漏一条聊天室回复，好过把私信回复广播）；
   * 2. 其次单数 user_message_uuid；
   * 3. 都缺失时（delivery-failure/zeroed result、旧 producer）保守回退：按插入序消费
   *    最早一条（等价旧的顺序 shift）。
   */
  private resolveResultKind(msg: SDKResultMessage): PushKind {
    const take = (uuid: string): PushKind | undefined => {
      const kind = this.pendingSends.get(uuid);
      if (kind) {
        this.pendingSends.delete(uuid);
        // 同步销私信簿：已出 result 的私信处理完毕，崩溃重建时不再重发
        this.pendingDms.delete(uuid);
      }
      return kind;
    };
    const uuids = msg.user_message_uuids;
    if (Array.isArray(uuids) && uuids.length > 0) {
      const kinds: PushKind[] = [];
      for (const u of uuids) {
        const k = take(u);
        if (k) kinds.push(k);
      }
      if (kinds.length > 0) return kinds.includes('dm') ? 'dm' : 'chatroom';
    }
    if (msg.user_message_uuid) {
      const k = take(msg.user_message_uuid);
      if (k) return k;
    }
    const first = this.pendingSends.entries().next();
    if (first.done) return 'chatroom';
    return take(first.value[0]) ?? 'chatroom'; // 回退同样要同步销两本簿子
  }
}
