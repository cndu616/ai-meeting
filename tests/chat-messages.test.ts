import { describe, it, expect } from 'vitest';
import { mergeMessage } from '@/components/room/chatMessages';

const msg = (id: number) => ({ id, content: `m${id}` });

describe('mergeMessage', () => {
  it('正常追加：新消息 append 到末尾', () => {
    const list = [msg(1), msg(2)];
    expect(mergeMessage(list, msg(3))).toEqual([msg(1), msg(2), msg(3)]);
  });

  it('重复消息丢弃：断线补发与本地已有重叠', () => {
    const list = [msg(1), msg(2)];
    expect(mergeMessage(list, msg(2))).toEqual([msg(1), msg(2)]);
  });

  it('乱序补发恢复有序：本地已有 id=100，补发 95-99 后到，仍按 id 升序', () => {
    // SSE 补偿场景：先订阅后补发，补发的旧区间 append 会拼在断线前最后一条之后
    let list = [msg(97), msg(100)];
    for (const id of [98, 95, 96, 99]) list = mergeMessage(list, msg(id));
    expect(list.map((m) => m.id)).toEqual([95, 96, 97, 98, 99, 100]);
  });

  it('不修改原数组（纯函数）', () => {
    const list = [msg(2)];
    mergeMessage(list, msg(1));
    expect(list.map((m) => m.id)).toEqual([2]);
  });
});
