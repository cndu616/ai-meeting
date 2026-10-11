// 消费端消息合并的纯函数层：UI 行为在 Room.tsx，可测语义在这里锁定。
// 背景：SSE 断线补偿（Last-Event-ID 区间补发）会让旧区间消息晚于断线前最后一条到达，
// 单纯去重后 append 会乱序——去重 + 按 id 升序合并是补偿语义在消费端的必要适配。
export function mergeMessage<T extends { id: number }>(list: T[], incoming: T): T[] {
  if (list.some((m) => m.id === incoming.id)) return list;
  const next = [...list, incoming];
  next.sort((a, b) => a.id - b.id);
  return next;
}
