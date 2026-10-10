// src/core/agent-session.ts
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type PushKind = 'chatroom' | 'dm';

export interface AgentSessionCallbacks {
  onSessionId(sessionId: string): void;
  onTool(tool: string, detail: string): void;
  /** 一轮结束的最终文本；kind 对应触发这轮的 push 标记（顺序对应） */
  onResult(text: string, kind: PushKind): void;
  /** 崩溃后自动重建成功（引擎应补发增量） */
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
  private pendingKinds: PushKind[] = [];

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
        maxTurns: 40,
      },
    });
    void this.consume(iter);
  }

  push(text: string, kind: PushKind = 'chatroom'): void {
    this.pendingKinds.push(kind);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }

  private async consume(iter: AsyncIterable<SDKMessage>): Promise<void> {
    try {
      for await (const msg of iter) {
        if (msg.type === 'system' && msg.subtype === 'init') {
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
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          if (msg.session_id) {
            this.sessionId = msg.session_id;
            this.opts.callbacks.onSessionId(msg.session_id);
          }
          const kind = this.pendingKinds.shift() ?? 'chatroom';
          this.opts.callbacks.onResult(msg.result ?? '', kind);
        }
      }
      this.handleEnd();
    } catch {
      this.handleEnd();
    }
  }

  private handleEnd(): void {
    if (this.closed) return;
    if (this.restarted) {
      this.opts.callbacks.onDead();
      return;
    }
    this.restarted = true;
    // 清空标记队列：崩溃瞬间 CLI 可能已消费 prompt 未出 result，残留 tag 会让
    // 重建后第一条公开回复被误判为 dm（隐私泄漏级 bug）
    this.pendingKinds = [];
    this.opts.callbacks.onRestart();
    this.start();
  }
}
