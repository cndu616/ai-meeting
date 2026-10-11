import { connection } from 'next/server';
import { subscribeMeeting, type MeetingEvent } from '@/lib/events';
import { getEngine } from '@/core/engine-instance';

/**
 * SSE 事件流（断线补偿）：
 * - message 事件帧带 `id:`（消息 DB id 即天然序号），客户端断线重连时浏览器自动带
 *   Last-Event-ID 请求头；
 * - 重连补偿分三类语义：message 走区间补发（id > lastEventId）；participant /
 *   meeting_status 是状态性事件，重发当前快照（读库一次）；agent_status 瞬态不补；
 * - 先订阅再补发：订阅后、补发前的新事件可能与补发重叠，服务端不做完美互斥——
 *   重叠由消费端幂等消化（message 按 id 去重合并、participant upsert）。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection(); // 标记动态路由（cacheComponents 模式）
  const { id } = await ctx.params;
  const lastEventId = Number(req.headers.get('last-event-id') ?? '') || 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: MeetingEvent, idLine?: number) => {
        try {
          const idPart = idLine != null ? `id: ${idLine}\n` : '';
          controller.enqueue(encoder.encode(`${idPart}data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* 连接已关闭 */
        }
      };
      const unsubscribe = subscribeMeeting(id, (e) => {
        send(e, e.type === 'message' ? e.message.id : undefined);
      });
      if (lastEventId > 0) {
        // 重连补偿（会议不存在等异常静默跳过：无补偿可做）
        try {
          const engine = getEngine();
          for (const msg of engine.getMessages(id)) {
            if (msg.id > lastEventId) {
              send({ type: 'message', meetingId: id, message: msg }, msg.id);
            }
          }
          for (const p of engine.getParticipants(id)) {
            send({ type: 'participant', meetingId: id, participant: engine.participantInfo(p) });
          }
          send({
            type: 'meeting_status', meetingId: id, status: engine.getMeeting(id).status,
          });
        } catch {
          /* ignore */
        }
      }
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          /* ignore */
        }
      }, 15000);
      const close = () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
