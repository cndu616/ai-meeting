// src/lib/eventParsing.ts —— SSE 消费端事件解析（事件契约的消费侧纯函数，与 events.ts 同层）。
// 两层防线：JSON.parse try/catch 防畸形 JSON 炸 onmessage；zod safeParse 防结构/字面量不合法。
// 畸形事件隔离：一条坏事件只污染自己（返回 ok:false），绝不中断后续事件处理。
//
// 向前兼容语义（刻意设计，勿当 bug 修）：未来 events.ts 新增事件类型时，已打开的旧页面
// 持有旧 schema，收到新 type 事件会被 safeParse 拒绝并走降级提示——这是刻意优于旧行为：
// 裸断言时代未知事件被硬当成已知类型、字段 undefined 静默污染 UI（如 data.message 为
// undefined 时直接炸掉 onmessage）；zod 化后旧客户端对未知事件是"可见的降级"而非
// "静默的未定义行为"。
import { meetingEventSchema, type MeetingEvent } from '@/lib/events';

export type ParsedEvent =
  | { ok: true; event: MeetingEvent }
  | { ok: false; reason: string };

export function parseMeetingEvent(raw: string): ParsedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `JSON 解析失败：${(e as Error).message}` };
  }
  const result = meetingEventSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `事件结构不合法：${result.error.issues[0]?.message ?? '未知原因'}` };
  }
  return { ok: true, event: result.data };
}
