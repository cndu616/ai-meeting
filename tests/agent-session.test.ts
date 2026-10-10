import { describe, it, expect, vi } from 'vitest';
import { AgentSession, type QueryFactory, type AgentSessionCallbacks } from '@/core/agent-session';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** 受控异步输出流：测试中手动 emit 消息、可选地结束流 */
class ControlledStream implements AsyncIterable<SDKMessage> {
  private queued: SDKMessage[] = [];
  private waiters: ((r: IteratorResult<SDKMessage>) => void)[] = [];
  private ended = false;
  emit(m: SDKMessage) {
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.queued.push(m);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<SDKMessage>> {
    const v = this.queued.shift();
    if (v) return Promise.resolve({ value: v, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function makeHarness(overrides?: Partial<AgentSessionCallbacks>) {
  const pushed: SDKUserMessage[] = [];
  /** 每个 query 独立记录各自的 prompt 消费（按流创建顺序） */
  const pushedByStream: SDKUserMessage[][] = [];
  const streams: ControlledStream[] = [];
  const cbs = {
    onSessionId: vi.fn(),
    onTool: vi.fn(),
    onResult: vi.fn(),
    onRestart: vi.fn(),
    onDead: vi.fn(),
    ...overrides,
  };
  const factory: QueryFactory = ({ prompt }) => {
    const stream = new ControlledStream();
    streams.push(stream);
    const mine: SDKUserMessage[] = [];
    pushedByStream.push(mine);
    void (async () => {
      for await (const m of prompt) {
        pushed.push(m);
        mine.push(m);
      }
    })();
    return stream;
  };
  return { pushed, pushedByStream, streams, cbs, factory };
}

const initMsg = { type: 'system', subtype: 'init', session_id: 's-1' } as SDKMessage;
const okResult = (text: string, sid = 's-2') =>
  ({ type: 'result', subtype: 'success', result: text, session_id: sid } as unknown as SDKMessage);
const toolMsg = (name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } } as unknown as SDKMessage);

function makeSession(factory: QueryFactory, cbs: AgentSessionCallbacks, resume?: string) {
  const s = new AgentSession({
    systemPrompt: 'sys', cwd: '/tmp', resumeSessionId: resume, queryFactory: factory, callbacks: cbs,
  });
  s.start();
  return s;
}

describe('AgentSession', () => {
  it('push 进入 prompt 流；输出消息触发回调', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('第一条');
    await vi.waitFor(() => expect(h.pushed.length).toBe(1));
    expect(h.pushed[0].message.content).toBe('第一条');

    h.streams[0].emit(initMsg);
    await vi.waitFor(() => expect(h.cbs.onSessionId).toHaveBeenCalledWith('s-1'));

    h.streams[0].emit(toolMsg('Read', { file_path: '/a.ts' }));
    await vi.waitFor(() => expect(h.cbs.onTool).toHaveBeenCalledWith('Read', '/a.ts'));

    h.streams[0].emit(okResult('我认为可以'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('我认为可以', 'chatroom'));
    await s.close();
  });

  it('push 带 dm 标记时，result 回调携带 dm（顺序对应）', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('聊天室消息', 'chatroom');
    s.push('私信内容', 'dm');
    h.streams[0].emit(okResult('公开回应'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('公开回应', 'chatroom'));
    h.streams[0].emit(okResult('私下的回应'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('私下的回应', 'dm'));
    await s.close();
  });

  it('close 后 push 不再生效，且幂等', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    await s.close();
    await s.close(); // 幂等
    s.push('已关闭');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.pushed.length).toBe(0);
  });

  it('流意外结束：自动重建一次并回调 onRestart；再次结束回调 onDead', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs, 'old-session');
    h.streams[0].end(); // 第一次：崩溃
    await vi.waitFor(() => expect(h.cbs.onRestart).toHaveBeenCalledTimes(1));
    expect(h.streams.length).toBe(2); // 重建了新 query
    h.streams[1].end(); // 第二次：放弃
    await vi.waitFor(() => expect(h.cbs.onDead).toHaveBeenCalled());
    await s.close();
  });

  it('重建后的 query 携带最新 sessionId（resume）', async () => {
    const h = makeHarness();
    const resumeIds: (string | undefined)[] = [];
    const factory: QueryFactory = (input) => {
      resumeIds.push(input.options.resume);
      return h.factory(input);
    };
    const s = makeSession(factory, h.cbs);
    h.streams[0].emit(initMsg); // session_id: s-1
    await vi.waitFor(() => expect(h.cbs.onSessionId).toHaveBeenCalledWith('s-1'));
    h.streams[0].end(); // 触发重建
    await vi.waitFor(() => expect(h.streams.length).toBe(2));
    expect(resumeIds[1]).toBe('s-1');
    await s.close();
  });

  it('onRestart 回调内立即 push 落进新流（重建先就绪再回调）', async () => {
    let session!: AgentSession;
    const h = makeHarness({ onRestart: () => session.push('补发增量', 'chatroom') });
    session = makeSession(h.factory, h.cbs);
    session.push('崩溃前的消息');
    await vi.waitFor(() => expect(h.pushedByStream[0]?.length).toBe(1));
    expect(h.pushedByStream[0][0].message.content).toBe('崩溃前的消息');

    h.streams[0].end(); // 崩溃 → 重建 → onRestart 内补发
    await vi.waitFor(() => expect(h.streams.length).toBe(2));
    await vi.waitFor(() => expect(h.pushedByStream[1]?.length).toBe(1));
    expect(h.pushedByStream[1][0].message.content).toBe('补发增量');
    expect(h.pushedByStream[0].length).toBe(1); // 旧流不会收到补发
    await session.close();
  });

  it('非 success result 也出队（文本按空串）且不导致后续错位', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('公开消息', 'chatroom');
    s.push('私信内容', 'dm');
    h.streams[0].emit({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 's-e',
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('', 'chatroom'));

    h.streams[0].emit(okResult('恢复后的公开回复'));
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledWith('恢复后的公开回复', 'dm'));
    await s.close();
  });

  it('崩溃重建后残留绑定被清空：旧 dm uuid 不会把公开回复误判为 dm', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('未及回复的私信', 'dm');
    await vi.waitFor(() => expect(h.pushedByStream[0]?.length).toBe(1));
    const dmUuid = h.pushedByStream[0][0].uuid!;

    h.streams[0].end(); // 崩溃重建（绑定应被清空）
    await vi.waitFor(() => expect(h.streams.length).toBe(2));
    h.streams[1].emit({
      type: 'result',
      subtype: 'success',
      result: '重建后的公开回复',
      user_message_uuid: dmUuid,
      user_message_uuids: [dmUuid],
      session_id: 's-4',
    } as unknown as SDKMessage);
    await vi.waitFor(() =>
      expect(h.cbs.onResult).toHaveBeenCalledWith('重建后的公开回复', 'chatroom'),
    );
    await s.close();
  });

  it('close 后流 end 不触发 onRestart/onDead', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    await s.close();
    h.streams[0].end();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.cbs.onRestart).not.toHaveBeenCalled();
    expect(h.cbs.onDead).not.toHaveBeenCalled();
  });

  it('合并 turn 的 user_message_uuids 归并 kind：含 dm 则 dm；销账后无残留错位', async () => {
    const h = makeHarness();
    const s = makeSession(h.factory, h.cbs);
    s.push('聊天室消息', 'chatroom');
    s.push('私信内容', 'dm');
    await vi.waitFor(() => expect(h.pushedByStream[0]?.length).toBe(2));
    const [u1, u2] = h.pushedByStream[0].map((m) => m.uuid!);

    // N push → 1 result：列表同时含两个 uuid，含 dm 则归并为 dm
    h.streams[0].emit({
      type: 'result',
      subtype: 'success',
      result: '合并回复',
      user_message_uuid: u2,
      user_message_uuids: [u1, u2],
      session_id: 's-3',
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledTimes(1));
    expect(h.cbs.onResult).toHaveBeenCalledWith('合并回复', 'dm');

    // Map 已销账干净：残留 dm uuid 再被回显也不该把新的公开回复误判为 dm
    s.push('后续聊天室消息', 'chatroom');
    await vi.waitFor(() => expect(h.pushedByStream[0]?.length).toBe(3));
    h.streams[0].emit({
      type: 'result',
      subtype: 'success',
      result: '后续回复',
      user_message_uuid: u2,
      user_message_uuids: [u2],
      session_id: 's-3',
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(h.cbs.onResult).toHaveBeenCalledTimes(2));
    expect(h.cbs.onResult).toHaveBeenLastCalledWith('后续回复', 'chatroom');
    await s.close();
  });
});
