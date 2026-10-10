import { connection } from 'next/server';
import { subscribeMeeting } from '@/lib/events';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection(); // 标记动态路由（cacheComponents 模式）
  const { id } = await ctx.params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* 连接已关闭 */
        }
      };
      const unsubscribe = subscribeMeeting(id, send);
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
